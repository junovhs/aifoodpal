import { describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_BYTES, base64Bytes, handleAiFood, type AiFoodDeps } from "../supabase/functions/ai-food/handler";
import { NOTE_MAX_CHARS } from "../src/ai-capture";

const modelReply = JSON.stringify({
  name: "Greek yogurt",
  brand: "Fage",
  serving: { amount: 170, unit: "g", description: "1 container (170 g)" },
  portion: { amount: 170, unit: "g" },
  nutrition: { calories: 100, proteinG: 18, carbsG: 6, fatG: 0, fiberG: 0, sugarG: 6, addedSugarG: 0, saturatedFatG: 0, transFatG: 0, sodiumMg: 65 },
  sourceType: "label",
  confidence: "high",
  notes: null,
  recipe: null,
});

const deps = (overrides: Partial<AiFoodDeps> = {}): AiFoodDeps & { consumeCredit: ReturnType<typeof vi.fn>; generate: ReturnType<typeof vi.fn> } => ({
  apiKey: "test-key",
  consumeCredit: vi.fn(async () => ({ remaining_today: 39, remaining_month: 499 })),
  generate: vi.fn(async () => modelReply),
  ...overrides,
} as AiFoodDeps & { consumeCredit: ReturnType<typeof vi.fn>; generate: ReturnType<typeof vi.fn> });

const request = (overrides: Record<string, unknown> = {}) => ({
  mode: "label",
  imageBase64: "AAAA",
  mimeType: "image/jpeg",
  ...overrides,
});

/** A base64 string whose decoded length exceeds `bytes`. */
const oversizedBase64 = (bytes: number): string => "A".repeat(Math.ceil((bytes + 1) / 3) * 4);

describe("ai-food request handling", () => {
  it("returns the food draft and what is left of the allowance", async () => {
    const dependencies = deps();

    const result = await handleAiFood(request({ note: "it's lamb, not beef" }), dependencies);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      food: {
        name: "Greek yogurt",
        serving: { amount: 170, unit: "g" },
        portion: { amount: 170, unit: "g" },
        nutrition: { calories: 100 },
      },
      remaining: { today: 39, month: 499 },
    });
    expect(dependencies.consumeCredit).toHaveBeenCalledWith("label");
  });

  it("sends the mode's model, prompt, and schema to the AI", async () => {
    const dependencies = deps();

    await handleAiFood(request({ mode: "estimate", note: "it was fatty" }), dependencies);

    const sent = dependencies.generate.mock.calls[0]![0] as { model: string; prompt: string; schema: { required: string[] } };
    expect(sent.model).not.toContain("lite");
    expect(sent.prompt).toContain("it was fatty");
    expect(sent.schema.required).toContain("nutrition");
    expect(dependencies.consumeCredit).toHaveBeenCalledWith("estimate");
  });

  it("refuses an oversized photo before charging a credit or calling the AI", async () => {
    const dependencies = deps();

    const result = await handleAiFood(request({ imageBase64: oversizedBase64(MAX_IMAGE_BYTES) }), dependencies);

    expect(result.status).toBe(413);
    expect(result.body).toMatchObject({ ok: false, code: "bad-request" });
    expect(dependencies.consumeCredit).not.toHaveBeenCalled();
    expect(dependencies.generate).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown mode", request({ mode: "freeform" })],
    ["a non-image mime type", request({ mimeType: "application/pdf" })],
    ["a missing photo", request({ imageBase64: "" })],
    ["an overlong note", request({ note: "x".repeat(NOTE_MAX_CHARS + 1) })],
    ["a non-object body", "just a string"],
  ])("rejects %s without spending anything", async (_label, payload) => {
    const dependencies = deps();

    const result = await handleAiFood(payload, dependencies);

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ ok: false, code: "bad-request" });
    expect(dependencies.consumeCredit).not.toHaveBeenCalled();
    expect(dependencies.generate).not.toHaveBeenCalled();
  });

  it("reports a reached cap as 429 and never calls the AI", async () => {
    const capReached = Object.assign(new Error("Daily AI limit reached."), { code: "PT429" });
    const dependencies = deps({ consumeCredit: vi.fn(async () => { throw capReached; }) as AiFoodDeps["consumeCredit"] });

    const result = await handleAiFood(request(), dependencies);

    expect(result.status).toBe(429);
    expect(result.body).toMatchObject({ ok: false, code: "limit-reached", error: "Daily AI limit reached." });
    expect(dependencies.generate).not.toHaveBeenCalled();
  });

  it("propagates a non-limit database failure rather than swallowing it as a limit", async () => {
    const dependencies = deps({ consumeCredit: vi.fn(async () => { throw Object.assign(new Error("connection lost"), { code: "08006" }); }) as AiFoodDeps["consumeCredit"] });

    await expect(handleAiFood(request(), dependencies)).rejects.toThrow(/connection lost/);
  });

  it("refuses a reply that does not match the contract instead of returning a partial draft", async () => {
    const dependencies = deps({ generate: vi.fn(async () => JSON.stringify({ name: "Mystery", serving: { amount: 1, unit: "serving" }, portion: { amount: 1, unit: "serving" } })) as AiFoodDeps["generate"] });

    const result = await handleAiFood(request(), dependencies);

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ ok: false, code: "ai-invalid" });
    expect((result.body as { error: string }).error).toContain("nutrition");
  });

  it("refuses a portion that cannot map to the canonical serving", async () => {
    const incompatibleReply = JSON.stringify({
      ...JSON.parse(modelReply),
      portion: { amount: 1, unit: "container" },
    });
    const dependencies = deps({ generate: vi.fn(async () => incompatibleReply) as AiFoodDeps["generate"] });

    const result = await handleAiFood(request(), dependencies);

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ ok: false, code: "ai-invalid" });
    expect((result.body as { error: string }).error).toContain("portion.unit must match serving.unit");
  });

  it("refuses unparseable text from the AI", async () => {
    const dependencies = deps({ generate: vi.fn(async () => "I'm sorry, I can't read that label.") as AiFoodDeps["generate"] });

    const result = await handleAiFood(request(), dependencies);

    expect(result.body).toMatchObject({ ok: false, code: "ai-invalid" });
  });

  it("reports an AI transport failure separately from a bad reply", async () => {
    const dependencies = deps({ generate: vi.fn(async () => { throw new Error("Gemini returned 503."); }) as AiFoodDeps["generate"] });

    const result = await handleAiFood(request(), dependencies);

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ ok: false, code: "ai-unavailable", error: "Gemini returned 503." });
  });

  it("says so plainly when no API key is configured, before touching anything else", async () => {
    const dependencies = deps({ apiKey: null });

    const result = await handleAiFood(request(), dependencies);

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ ok: false, code: "not-configured" });
    expect(dependencies.consumeCredit).not.toHaveBeenCalled();
  });
});

describe("base64Bytes", () => {
  it("measures the decoded size without allocating it", () => {
    expect(base64Bytes("AAAA")).toBe(3);
    expect(base64Bytes("AAA=")).toBe(2);
    expect(base64Bytes("AA==")).toBe(1);
    expect(base64Bytes("")).toBe(0);
  });
});

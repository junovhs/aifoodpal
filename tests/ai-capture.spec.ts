import { describe, expect, it } from "vitest";
import {
  CAPTURE_RESPONSE_SCHEMA,
  CORE_MACROS,
  MODEL_FOR_MODE,
  NOTE_MAX_CHARS,
  buildCapturePrompt,
  captureToFoodDraft,
  parseCapturePayload,
  validateCapturePayload,
} from "../src/ai-capture";
import type { FoodInput } from "../src/model";

const labelPayload = {
  name: "Greek yogurt",
  brand: "Fage",
  serving: { amount: 170, unit: "g", description: "1 container (170 g)" },
  nutrition: { calories: 100, proteinG: 18, carbsG: 6, fatG: 0, fiberG: 0, sugarG: 6, addedSugarG: 0, saturatedFatG: 0, transFatG: 0, sodiumMg: 65 },
  sourceType: "label",
  confidence: "high",
  notes: null,
  recipe: null,
};

describe("capture response schema", () => {
  it("declares every core macro required and never opens the object", () => {
    const schema = JSON.parse(JSON.stringify(CAPTURE_RESPONSE_SCHEMA)) as Record<string, unknown>;
    const nutrition = (schema.properties as Record<string, { required: string[] } | undefined>).nutrition!;

    expect(nutrition.required).toEqual([...CORE_MACROS]);
    expect(schema.required).toEqual(["name", "serving", "nutrition", "sourceType", "confidence"]);
    expect(JSON.stringify(schema)).not.toContain("additionalProperties");
  });

  it("routes transcription to the cheap model and judgement to the stronger one", () => {
    expect(MODEL_FOR_MODE.label).toContain("flash-lite");
    expect(MODEL_FOR_MODE.estimate).not.toContain("lite");
  });
});

describe("buildCapturePrompt", () => {
  it("forbids estimation in label mode", () => {
    const prompt = buildCapturePrompt("label");

    expect(prompt).toContain("Do not estimate");
    expect(prompt).toContain("not the % Daily Value column");
    expect(prompt).toContain("The user added no extra context.");
  });

  it("embeds the note as authoritative in estimate mode", () => {
    const prompt = buildCapturePrompt("estimate", "  it's lamb, not beef, and it was fatty  ");

    expect(prompt).toContain("it's lamb, not beef, and it was fatty");
    expect(prompt).toContain("Treat it as authoritative");
    expect(prompt).toContain("Do not return null for calories");
  });

  it("bounds a runaway note", () => {
    const prompt = buildCapturePrompt("estimate", "x".repeat(NOTE_MAX_CHARS + 250));

    expect(prompt).toContain("x".repeat(NOTE_MAX_CHARS));
    expect(prompt).not.toContain("x".repeat(NOTE_MAX_CHARS + 1));
  });

  it("never carries the user's library or profile", () => {
    expect(buildCapturePrompt("estimate", "note")).not.toContain("weightLb");
  });
});

describe("validateCapturePayload", () => {
  it("accepts a schema-conforming label reply", () => {
    expect(validateCapturePayload(labelPayload)).toMatchObject({
      name: "Greek yogurt",
      brand: "Fage",
      serving: { amount: 170, unit: "g" },
      nutrition: { calories: 100, proteinG: 18, sodiumMg: 65 },
      sourceType: "label",
    });
  });

  it("keeps a recipe when one is returned", () => {
    const result = validateCapturePayload({
      ...labelPayload,
      recipe: { ingredients: [{ name: "lamb shoulder", amount: 1.5, unit: "lb" }, { name: "olive oil" }], instructions: "Braise." },
    });

    expect(result.recipe?.ingredients).toEqual([
      { name: "lamb shoulder", amount: 1.5, unit: "lb" },
      { name: "olive oil", amount: null, unit: "" },
    ]);
  });

  it.each([
    ["a missing name", { ...labelPayload, name: "  " }],
    ["a non-numeric calorie count", { ...labelPayload, nutrition: { ...labelPayload.nutrition, calories: "100" } }],
    ["a zero serving amount", { ...labelPayload, serving: { ...labelPayload.serving, amount: 0 } }],
    ["a non-object reply", ["not", "a", "food"]],
  ])("refuses %s rather than half-applying it", (_label, payload) => {
    expect(() => validateCapturePayload(payload)).toThrowError(expect.objectContaining({ name: "CaptureContractError", code: "invalid-shape" }));
  });

  it("reports unparseable text distinctly from a bad shape", () => {
    expect(() => parseCapturePayload("{oops")).toThrowError(expect.objectContaining({ code: "invalid-json" }));
    expect(parseCapturePayload(JSON.stringify(labelPayload)).name).toBe("Greek yogurt");
  });
});

describe("captureToFoodDraft", () => {
  it("merges onto the open draft and preserves its id", () => {
    const current: FoodInput = { id: "food_1", name: "yogurt", nutrition: { calories: 1 } };

    const merged = captureToFoodDraft(current, labelPayload);

    expect(merged.id).toBe("food_1");
    expect(merged.name).toBe("Greek yogurt");
    expect(merged.nutrition?.calories).toBe(100);
  });

  it("does not invent an id for a food that has none", () => {
    expect(captureToFoodDraft({ name: "yogurt" }, labelPayload).id).toBeUndefined();
  });

  it("lets a null from the model leave a hand-entered value alone", () => {
    const current: FoodInput = { name: "Lamb stew", brand: "Homemade", nutrition: { calories: 0, sodiumMg: 480, sugarG: 4 }, notes: "family recipe" };
    const estimate = {
      ...labelPayload,
      name: "Lamb stew",
      brand: null,
      notes: null,
      nutrition: { calories: 520, proteinG: 34, carbsG: 18, fatG: 32, fiberG: 3, sugarG: null, addedSugarG: null, saturatedFatG: 14, transFatG: null, sodiumMg: null },
    };

    const merged = captureToFoodDraft(current, estimate);

    expect(merged.nutrition).toMatchObject({ calories: 520, proteinG: 34, sodiumMg: 480, sugarG: 4 });
    expect(merged.brand).toBe("Homemade");
    expect(merged.notes).toBe("family recipe");
  });

  it("records a nutrient the draft never had as an explicit null", () => {
    const merged = captureToFoodDraft({ name: "Lamb stew" }, { ...labelPayload, nutrition: { ...labelPayload.nutrition, transFatG: null } });

    expect(merged.nutrition?.transFatG).toBeNull();
  });
});

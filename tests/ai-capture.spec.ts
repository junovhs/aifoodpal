import { describe, expect, it } from "vitest";
import {
  CAPTURE_RESPONSE_FORMAT,
  CAPTURE_RESPONSE_SCHEMA,
  CORE_MACROS,
  MODEL_FOR_MODE,
  NOTE_MAX_CHARS,
  buildCapturePrompt,
  parseCapturePayload,
  validateCapturePayload,
} from "../src/ai-capture";

interface SchemaNode {
  type?: string | string[];
  additionalProperties?: boolean;
  required?: readonly string[];
  properties?: Record<string, unknown>;
  items?: unknown;
}

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
  /** Walk every object node, the way a strict-mode validator does. */
  const objectNodes = (node: unknown, path = "root"): Array<[string, SchemaNode]> => {
    if (!node || typeof node !== "object") return [];
    const schema = node as SchemaNode;
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const here: Array<[string, SchemaNode]> = types.includes("object") ? [[path, schema]] : [];
    const children = Object.entries(schema.properties ?? {}).flatMap(([key, value]) => objectNodes(value, `${path}.${key}`));
    return [...here, ...children, ...objectNodes(schema.items, `${path}[]`)];
  };

  it("closes every object and requires every property, as strict mode demands", () => {
    const schema = JSON.parse(JSON.stringify(CAPTURE_RESPONSE_SCHEMA)) as SchemaNode;
    const nodes = objectNodes(schema);

    expect(nodes.map(([path]) => path)).toEqual([
      "root", "root.serving", "root.nutrition", "root.recipe", "root.recipe.ingredients[]",
    ]);
    for (const [path, node] of nodes) {
      expect(node.additionalProperties, `${path} must be closed`).toBe(false);
      expect([...(node.required ?? [])].sort(), `${path} must require every property`).toEqual(Object.keys(node.properties ?? {}).sort());
    }
  });

  it("spells optional values as type unions, not as a Gemini nullable flag", () => {
    const schema = JSON.parse(JSON.stringify(CAPTURE_RESPONSE_SCHEMA)) as SchemaNode;
    const nutrition = schema.properties!.nutrition as SchemaNode;

    expect(nutrition.required).toEqual([...CORE_MACROS, "sugarG", "addedSugarG", "saturatedFatG", "transFatG", "sodiumMg"]);
    expect((nutrition.properties!.calories as SchemaNode).type).toBe("number");
    expect((nutrition.properties!.fiberG as SchemaNode).type).toEqual(["number", "null"]);
    expect((schema.properties!.recipe as SchemaNode).type).toEqual(["object", "null"]);

    const serialized = JSON.stringify(schema);
    expect(serialized).not.toContain("nullable");
    expect(serialized).not.toContain("propertyOrdering");
  });

  it("wraps the schema the way OpenRouter expects, with strict binding", () => {
    expect(CAPTURE_RESPONSE_FORMAT.type).toBe("json_schema");
    expect(CAPTURE_RESPONSE_FORMAT.json_schema.strict).toBe(true);
    expect(CAPTURE_RESPONSE_FORMAT.json_schema.schema).toBe(CAPTURE_RESPONSE_SCHEMA);
  });

  it("routes transcription to the cheap model and judgement to the stronger one", () => {
    expect(MODEL_FOR_MODE.label).toBe("google/gemini-2.5-flash-lite");
    expect(MODEL_FOR_MODE.estimate).toBe("google/gemini-2.5-flash");
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

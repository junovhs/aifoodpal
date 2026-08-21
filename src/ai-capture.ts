import type { Confidence, FoodInput, SourceType } from "./model";

/**
 * How a photo should be read. `label` transcribes a printed nutrition panel; `estimate`
 * judges a plate of food. They differ in prompt and model, never in request shape.
 */
export type CaptureMode = "label" | "estimate";

/** Every mode, for validating an incoming request and for iterating the capture buttons. */
export const CAPTURE_MODES: readonly CaptureMode[] = ["label", "estimate"];

/**
 * Transcription is nearly mechanical, so it runs on the cheap model; estimating a portion
 * is real judgement and gets the stronger one. Tuned against observed output in OPS-01.
 */
export const MODEL_FOR_MODE: Record<CaptureMode, string> = {
  label: "gemini-2.5-flash-lite",
  estimate: "gemini-2.5-flash",
};

/** Long enough for real context ("it's lamb, not beef, and it was fatty"), short enough to bound cost. */
export const NOTE_MAX_CHARS = 500;

const SOURCE_TYPES: readonly SourceType[] = ["user", "label", "restaurant", "estimate"];
const CONFIDENCE_LEVELS: readonly Confidence[] = ["high", "medium", "low"];

/** Macros the model must always return a value or an explicit null for — never omit. */
export const CORE_MACROS = ["calories", "proteinG", "carbsG", "fatG", "fiberG"] as const;

const OPTIONAL_NUTRIENTS = ["sugarG", "addedSugarG", "saturatedFatG", "transFatG", "sodiumMg"] as const;

const nullableNumber = { type: "number", nullable: true } as const;

/**
 * Gemini `responseSchema` (the OpenAPI 3.0 subset it accepts: no `additionalProperties`,
 * nullability via `nullable`). Constraining generation to this is what removes the whole
 * class of parse failures the clipboard bridge had — no fences, no prose, no smart quotes.
 */
export const CAPTURE_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "The food's identity only. Never include a quantity." },
    brand: { type: "string", nullable: true },
    serving: {
      type: "object",
      properties: {
        amount: { type: "number" },
        unit: { type: "string", description: "tsp, tbsp, fl oz, cup, ml, l, g, kg, oz, lb, serving, piece, slice, or container." },
        description: { type: "string" },
      },
      required: ["amount", "unit", "description"],
    },
    nutrition: {
      type: "object",
      properties: {
        calories: { type: "number" },
        proteinG: nullableNumber,
        carbsG: nullableNumber,
        fatG: nullableNumber,
        fiberG: nullableNumber,
        sugarG: nullableNumber,
        addedSugarG: nullableNumber,
        saturatedFatG: nullableNumber,
        transFatG: nullableNumber,
        sodiumMg: nullableNumber,
      },
      required: [...CORE_MACROS],
    },
    sourceType: { type: "string", enum: [...SOURCE_TYPES] },
    confidence: { type: "string", enum: [...CONFIDENCE_LEVELS] },
    notes: { type: "string", nullable: true, description: "How the figures were arrived at, when that is worth knowing." },
    recipe: {
      type: "object",
      nullable: true,
      properties: {
        ingredients: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              amount: nullableNumber,
              unit: { type: "string" },
            },
            required: ["name"],
          },
        },
        instructions: { type: "string", nullable: true },
      },
      required: ["ingredients"],
    },
  },
  required: ["name", "serving", "nutrition", "sourceType", "confidence"],
  propertyOrdering: ["name", "brand", "serving", "nutrition", "sourceType", "confidence", "notes", "recipe"],
} as const;

/** Whether the reply could not be parsed at all, or parsed but did not match the declared schema. */
export type CaptureContractErrorCode = "invalid-json" | "invalid-shape";

/** A reply that did not conform to CAPTURE_RESPONSE_SCHEMA, kept distinct from a transport failure. */
export class CaptureContractError extends Error {
  readonly code: CaptureContractErrorCode;

  constructor(code: CaptureContractErrorCode, message: string) {
    super(message);
    this.name = "CaptureContractError";
    this.code = code;
  }
}

// Explicitly typed so TypeScript treats a call as never-returning and narrows after it.
const fail: (message: string) => never = (message) => { throw new CaptureContractError("invalid-shape", message); };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readNumber = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${field} must be a number.`);
  return value as number;
};

const readNullableNumber = (value: unknown, field: string): number | null => {
  if (value === null || value === undefined) return null;
  return readNumber(value, field);
};

const readNullableString = (value: unknown, field: string): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") fail(`${field} must be a string or null.`);
  return value as string;
};

/**
 * Validate a decoded Gemini reply against the same contract the request declared.
 * Structured output makes conformance overwhelmingly likely, not guaranteed — a truncated
 * or safety-filtered generation still has to be refused rather than half-applied.
 */
export const validateCapturePayload = (value: unknown): FoodInput => {
  if (!isRecord(value)) fail("The reply was not a JSON object.");
  const record = value as Record<string, unknown>;

  const name = record.name;
  if (typeof name !== "string" || name.trim().length === 0) fail("The reply is missing a food name.");

  if (!isRecord(record.serving)) fail("The reply is missing serving information.");
  const serving = record.serving as Record<string, unknown>;
  const amount = readNumber(serving.amount, "serving.amount");
  if (amount <= 0) fail("serving.amount must be greater than zero.");
  if (typeof serving.unit !== "string" || serving.unit.trim().length === 0) fail("serving.unit must be a non-empty string.");

  if (!isRecord(record.nutrition)) fail("The reply is missing nutrition information.");
  const source = record.nutrition as Record<string, unknown>;
  const calories = readNumber(source.calories, "nutrition.calories");
  if (calories < 0) fail("nutrition.calories cannot be negative.");
  const nutrition: Record<string, number | null> = { calories };
  for (const key of [...CORE_MACROS.filter((macro) => macro !== "calories"), ...OPTIONAL_NUTRIENTS]) {
    nutrition[key] = readNullableNumber(source[key], `nutrition.${key}`);
  }

  const sourceType = SOURCE_TYPES.includes(record.sourceType as SourceType) ? record.sourceType as SourceType : "estimate";
  const confidence = CONFIDENCE_LEVELS.includes(record.confidence as Confidence) ? record.confidence as Confidence : "low";

  const food: FoodInput = {
    name: name.trim(),
    brand: readNullableString(record.brand, "brand"),
    serving: { amount, unit: (serving.unit as string).trim(), description: typeof serving.description === "string" ? serving.description : "" },
    nutrition: nutrition as FoodInput["nutrition"],
    sourceType,
    confidence,
    notes: readNullableString(record.notes, "notes"),
  };

  if (record.recipe === null || record.recipe === undefined) return food;
  if (!isRecord(record.recipe)) fail("recipe must be an object or null.");
  const recipe = record.recipe as Record<string, unknown>;
  if (!Array.isArray(recipe.ingredients)) fail("recipe.ingredients must be an array.");
  food.recipe = {
    ingredients: (recipe.ingredients as unknown[]).map((entry, index) => {
      if (!isRecord(entry)) return fail(`recipe.ingredients[${index}] must be an object.`);
      const ingredient = entry as Record<string, unknown>;
      if (typeof ingredient.name !== "string") fail(`recipe.ingredients[${index}].name must be a string.`);
      return {
        name: ingredient.name as string,
        amount: readNullableNumber(ingredient.amount, `recipe.ingredients[${index}].amount`),
        unit: typeof ingredient.unit === "string" ? ingredient.unit : "",
      };
    }),
    instructions: readNullableString(recipe.instructions, "recipe.instructions"),
  };
  return food;
};

/** Parse raw JSON text from the model, then validate it. */
export const parseCapturePayload = (json: string): FoodInput => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    throw new CaptureContractError("invalid-json", "The AI reply was not valid JSON.");
  }
  return validateCapturePayload(decoded);
};

/**
 * Merge a validated reply onto the draft currently in the food form. A null or absent value
 * never erases something the user already knows: the model returns null for "not stated on
 * the panel", which must not wipe a figure typed by hand.
 */
export const captureToFoodDraft = (current: FoodInput, payload: unknown): FoodInput => {
  const incoming = validateCapturePayload(payload);
  const nutrition: Record<string, unknown> = { ...(current.nutrition ?? {}) };
  for (const [key, value] of Object.entries(incoming.nutrition ?? {})) {
    if (value !== null && value !== undefined) nutrition[key] = value;
    else if (!(key in nutrition)) nutrition[key] = null;
  }

  const merged: FoodInput = {
    ...current,
    ...incoming,
    brand: incoming.brand ?? current.brand ?? null,
    notes: incoming.notes ?? current.notes ?? null,
    serving: { ...(current.serving ?? {}), ...(incoming.serving ?? {}) },
    nutrition: nutrition as FoodInput["nutrition"],
    recipe: incoming.recipe ?? current.recipe ?? null,
  };
  if (current.id) merged.id = current.id;
  else delete merged.id;
  return merged;
};

const SHARED_RULES = `Rules:
- Everything you return describes ONE serving. Never multiply by the number of servings shown.
- The name is the food's identity only. Quantities belong in serving.amount and serving.unit, never in the name.
- Normalize the unit to one of: tsp, tbsp, fl oz, cup, ml, l, g, kg, oz, lb, serving, piece, slice, container.
- sugarG is TOTAL sugar; addedSugarG is ADDED sugar only.
- Use 0 only when a nutrient is confidently zero. Use null when you do not know it.`;

const LABEL_RULES = `This photo is a printed nutrition facts panel.

- Transcribe what the panel states. Do not estimate, and do not substitute typical values for the food.
- Use the serving size exactly as printed, including its unit.
- Read the gram and milligram figures, not the % Daily Value column.
- If a nutrient is not printed on the panel, return null for it rather than guessing.
- Set sourceType to "label". Set confidence to "high" only when the panel is fully legible.`;

const ESTIMATE_RULES = `This photo is prepared food, not a label. Estimate its nutrition.

- Judge the portion from visible cues: plate and utensil size, and how the food is heaped.
- Account for how it was cooked — oil, butter, sauces, and visible fat all count.
- Estimate every core macro. Do not return null for calories, protein, carbs, fat, or fiber merely because the figure is an estimate.
- Describe the portion you assumed in serving.description, so the figures can be checked.
- Set sourceType to "estimate" or "restaurant". Set confidence honestly; "low" is the right answer for an ambiguous plate.`;

/**
 * Build the instruction half of a capture request. The photo and the response schema are
 * attached by the caller; this text never contains the user's food library or profile.
 */
export const buildCapturePrompt = (mode: CaptureMode, note?: string | null): string => {
  const trimmed = (note ?? "").trim().slice(0, NOTE_MAX_CHARS);
  const context = trimmed.length > 0
    ? `The user added this context. Treat it as authoritative — it overrides what the photo appears to show:\n"""\n${trimmed}\n"""`
    : "The user added no extra context.";
  return `You are filling in a single food entry for AIfoodpal, a private food tracker. Return only data conforming to the provided schema.

${mode === "label" ? LABEL_RULES : ESTIMATE_RULES}

${SHARED_RULES}

${context}`;
};

/**
 * The wire contract for photo capture, shared verbatim by the browser and the Deno Edge
 * Function. It imports nothing on purpose: the function's module graph has to be resolvable
 * by Deno from the files the deploy uploads, and reaching into the app's domain model pulled
 * in a chain (model -> units -> ...) that was never uploaded and failed to boot.
 */

/** How confident the model is in what it produced. Mirrors the domain model's own union. */
export type CaptureConfidence = "high" | "medium" | "low";

/** Where the figures came from. Mirrors the domain model's own union. */
export type CaptureSourceType = "user" | "label" | "restaurant" | "estimate";

/** Exactly what a capture returns: structurally a FoodInput, but owned by the contract. */
export interface CapturedFood {
  name: string;
  brand: string | null;
  serving: { amount: number; unit: string; description: string };
  portion: { amount: number; unit: string };
  nutrition: Record<string, number | null>;
  sourceType: CaptureSourceType;
  confidence: CaptureConfidence;
  notes: string | null;
  recipe?: { ingredients: Array<{ name: string; amount: number | null; unit: string }>; instructions: string | null } | null;
}

/**
 * How a capture should be read. `label` transcribes a printed nutrition panel; `estimate`
 * judges a plate of food; `describe` reads a written description with no photo at all.
 * The first two differ only in prompt and model; `describe` also sends no image.
 */
export type CaptureMode = "label" | "estimate" | "describe";

/** Every mode, for validating an incoming request and for iterating the capture buttons. */
export const CAPTURE_MODES: readonly CaptureMode[] = ["label", "estimate", "describe"];

/** The modes that carry a photo. `describe` is the one that does not. */
export const PHOTO_MODES: readonly CaptureMode[] = ["label", "estimate"];

/**
 * OpenRouter model slugs. Transcription is nearly mechanical, so it runs on the cheap model;
 * estimating a portion is real judgement and gets the stronger one. OpenRouter resells these
 * at the provider's own rates, so routing through it costs nothing extra per call — it only
 * removes the need for a Google Cloud billing account. Tuned against observed output in OPS-01.
 */
export const MODEL_FOR_MODE: Record<CaptureMode, string> = {
  label: "google/gemini-2.5-flash-lite",
  estimate: "google/gemini-2.5-flash",
  describe: "google/gemini-2.5-flash",
};

/**
 * Which ai_usage row a mode is charged against.
 *
 * `describe` runs the same model as `estimate` at a smaller prompt, so it costs no more and
 * belongs in the same bucket. Keeping the ledger's kind at two values also means this mode
 * needs no migration: `consume_ai_credit` check-constrains kind to ('label', 'estimate'),
 * and a third value would be refused by a database the deploy has not caught up with.
 */
export const CREDIT_KIND_FOR_MODE: Record<CaptureMode, "label" | "estimate"> = {
  label: "label",
  estimate: "estimate",
  describe: "estimate",
};

/** Long enough for real context ("it's lamb, not beef, and it was fatty"), short enough to bound cost. */
export const NOTE_MAX_CHARS = 500;

const SOURCE_TYPES: readonly CaptureSourceType[] = ["user", "label", "restaurant", "estimate"];
const CONFIDENCE_LEVELS: readonly CaptureConfidence[] = ["high", "medium", "low"];

/** Macros the model must always return a value or an explicit null for — never omit. */
export const CORE_MACROS = ["calories", "proteinG", "carbsG", "fatG", "fiberG"] as const;

const OPTIONAL_NUTRIENTS = ["sugarG", "addedSugarG", "saturatedFatG", "transFatG", "sodiumMg"] as const;

/** Strict JSON Schema spells an optional value as a type union rather than a `nullable` flag. */
const nullableNumber = { type: ["number", "null"] } as const;
const nullableString = { type: ["string", "null"] } as const;

const NUTRIENT_KEYS = [...CORE_MACROS, ...OPTIONAL_NUTRIENTS] as const;

const nutritionProperties = Object.fromEntries(
  NUTRIENT_KEYS.map((key) => [key, key === "calories" ? { type: "number" } : nullableNumber]),
);

/**
 * The response schema, in the strict JSON Schema dialect OpenRouter forwards to the provider.
 *
 * Strict mode has three hard requirements that shape this: every object closes with
 * `additionalProperties: false`, every property is listed in `required`, and optionality is
 * expressed as a `["type", "null"]` union rather than by omission. So "the panel does not
 * state fiber" arrives as an explicit null, which is exactly what the merge in
 * `captureToFoodDraft` already treats as "leave what the user typed alone".
 */
export const CAPTURE_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "brand", "serving", "portion", "nutrition", "sourceType", "confidence", "notes", "recipe"],
  properties: {
    name: { type: "string", description: "The food's identity only. Never include a quantity." },
    brand: nullableString,
    serving: {
      type: "object",
      additionalProperties: false,
      required: ["amount", "unit", "description"],
      properties: {
        amount: { type: "number" },
        unit: { type: "string", description: "tsp, tbsp, fl oz, cup, ml, l, g, kg, oz, lb, serving, piece, slice, or container." },
        description: { type: "string" },
      },
    },
    portion: {
      type: "object",
      additionalProperties: false,
      required: ["amount", "unit"],
      properties: {
        amount: { type: "number", description: "The amount eaten now, expressed in portion.unit." },
        unit: { type: "string", description: "Must exactly match serving.unit so the portion always converts to a diary multiplier." },
      },
    },
    nutrition: {
      type: "object",
      additionalProperties: false,
      required: [...NUTRIENT_KEYS],
      properties: nutritionProperties,
    },
    sourceType: { type: "string", enum: [...SOURCE_TYPES] },
    confidence: { type: "string", enum: [...CONFIDENCE_LEVELS] },
    notes: { ...nullableString, description: "How the figures were arrived at, when that is worth knowing." },
    recipe: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["ingredients", "instructions"],
      properties: {
        ingredients: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "amount", "unit"],
            properties: {
              name: { type: "string" },
              amount: nullableNumber,
              unit: { type: "string" },
            },
          },
        },
        instructions: nullableString,
      },
    },
  },
} as const;

/** OpenRouter wants the schema wrapped and named; `strict` is what makes conformance binding. */
export const CAPTURE_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: { name: "aifoodpal_food", strict: true, schema: CAPTURE_RESPONSE_SCHEMA },
} as const;

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
 * Read the amount eaten now, recovering rather than refusing when it is absent or unusable.
 *
 * Unlike a name or a calorie count, a missing portion is not missing information: the reply
 * still describes a food completely, and one canonical serving is the honest reading of a
 * quantity nobody stated. Refusing here cost the user the whole capture — and its allowance
 * charge — over a field the model was merely asked to include, so a reply from a model that
 * never saw the portion instruction still fills the form.
 *
 * A unit that disagrees with serving.unit is treated as a labelling slip, not a different
 * measurement: the amount is kept and the canonical unit adopted, because the two are
 * required to match and the user reviews every figure before saving.
 */
const readPortion = (value: unknown, servingAmount: number, servingUnit: string): { amount: number; unit: string } => {
  const source = isRecord(value) ? value as Record<string, unknown> : {};
  const amount = typeof source.amount === "number" && Number.isFinite(source.amount) && source.amount > 0 ? source.amount : servingAmount;
  return { amount, unit: servingUnit };
};

/**
 * Validate a decoded model reply against the same contract the request declared.
 * Structured output makes conformance overwhelmingly likely, not guaranteed — a truncated
 * or safety-filtered generation still has to be refused rather than half-applied.
 */
export const validateCapturePayload = (value: unknown): CapturedFood => {
  if (!isRecord(value)) fail("The reply was not a JSON object.");
  const record = value as Record<string, unknown>;

  const name = record.name;
  if (typeof name !== "string" || name.trim().length === 0) fail("The reply is missing a food name.");

  if (!isRecord(record.serving)) fail("The reply is missing serving information.");
  const serving = record.serving as Record<string, unknown>;
  const amount = readNumber(serving.amount, "serving.amount");
  if (amount <= 0) fail("serving.amount must be greater than zero.");
  if (typeof serving.unit !== "string" || serving.unit.trim().length === 0) fail("serving.unit must be a non-empty string.");

  const portion = readPortion(record.portion, amount, (serving.unit as string).trim());

  if (!isRecord(record.nutrition)) fail("The reply is missing nutrition information.");
  const source = record.nutrition as Record<string, unknown>;
  const calories = readNumber(source.calories, "nutrition.calories");
  if (calories < 0) fail("nutrition.calories cannot be negative.");
  const nutrition: Record<string, number | null> = { calories };
  for (const key of [...CORE_MACROS.filter((macro) => macro !== "calories"), ...OPTIONAL_NUTRIENTS]) {
    nutrition[key] = readNullableNumber(source[key], `nutrition.${key}`);
  }

  const sourceType = SOURCE_TYPES.includes(record.sourceType as CaptureSourceType) ? record.sourceType as CaptureSourceType : "estimate";
  const confidence = CONFIDENCE_LEVELS.includes(record.confidence as CaptureConfidence) ? record.confidence as CaptureConfidence : "low";

  const food: CapturedFood = {
    name: name.trim(),
    brand: readNullableString(record.brand, "brand"),
    serving: { amount, unit: (serving.unit as string).trim(), description: typeof serving.description === "string" ? serving.description : "" },
    portion,
    nutrition,
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
export const parseCapturePayload = (json: string): CapturedFood => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    throw new CaptureContractError("invalid-json", "The AI reply was not valid JSON.");
  }
  return validateCapturePayload(decoded);
};

const SHARED_RULES = `Rules:
- serving is the canonical reusable unit stored with the library food. portion is the amount eaten now. Never reuse one figure as the other.
- Express portion in the same unit as serving. Convert the amount when the user's note uses a different unit.
- Nutrition describes exactly one canonical serving, not the portion. The app applies the portion as a multiplier when it logs the diary entry.
- The name is the food's identity only. Quantities belong in serving.amount and serving.unit, never in the name.
- Normalize the unit to one of: tsp, tbsp, fl oz, cup, ml, l, g, kg, oz, lb, serving, piece, slice, container.
- sugarG is TOTAL sugar; addedSugarG is ADDED sugar only.
- Use 0 only when a nutrient is confidently zero. Use null when you do not know it.`;

const LABEL_RULES = `This photo is a printed nutrition facts panel.

- Transcribe what the panel states. Do not estimate, and do not substitute typical values for the food.
- Serving size: when the panel gives both a household measure and a metric weight, put the metric weight in serving.amount and serving.unit (for "2/3 cup (55g)" that is amount 55, unit "g") and keep the printed text in serving.description. Grams are unambiguous; household measures are not.
- Set portion to exactly one printed serving unless the user's note says they ate a different amount.
- If only a household measure is printed, express any fraction as a decimal: "2/3 cup" is amount 0.67, not amount 2.
- The food's name is the product's name as printed on the packaging. Never name it after a heading on the panel such as "Nutrition Facts" or "Supplement Facts". If no product name appears anywhere in the photo, set name to exactly "Unnamed food" and let the user fill it in — do not invent one and do not fall back to a heading.
- Read the gram and milligram figures, not the % Daily Value column.
- If a nutrient is not printed on the panel, return null for it rather than guessing.
- Set sourceType to "label". Set confidence to "high" only when the panel is fully legible.`;

const ESTIMATE_RULES = `This photo is prepared food, not a label. Estimate its nutrition.

- Judge the portion from visible cues: plate and utensil size, and how the food is heaped.
- Account for how it was cooked — oil, butter, sauces, and visible fat all count.
- Set serving to a clean reusable unit: normally 100 g, or 1 piece or 1 container when that is the food's natural unit. Never put the estimated amount eaten in serving.
- Put the estimated amount eaten in portion. Scale nutrition to describe one canonical serving so the portion multiplier produces the nutrition eaten now.
- Estimate every core macro. Do not return null for calories, protein, carbs, fat, or fiber merely because the figure is an estimate.
- Describe the canonical serving in serving.description, so the library unit can be checked.
- Set sourceType to "estimate" or "restaurant". Set confidence honestly; "low" is the right answer for an ambiguous plate.`;

const DESCRIBE_RULES = `There is no photo. The user's description below is the only evidence you have.

- Work only from what the description says. Never invent a food, a brand, or an ingredient it does not mention.
- When the description already states figures — calories, macros, a per-item breakdown — use those figures rather than your own estimate of the same food.
- When it describes several items as one meal, return them as one food named after the meal, with nutrition covering the whole of it.
- Set serving to a clean reusable unit and put the amount described in portion, exactly as the plate rules do.
- Estimate every core macro. Do not return null for calories, protein, carbs, fat, or fiber merely because the figure is an estimate.
- Say in notes which figures came from the description and which you estimated.
- Set sourceType to "user" when the description supplied the numbers, otherwise "estimate". Set confidence honestly.`;

const RULES_FOR_MODE: Record<CaptureMode, string> = {
  label: LABEL_RULES,
  estimate: ESTIMATE_RULES,
  describe: DESCRIBE_RULES,
};

/**
 * Build the instruction half of a capture request. The photo (when there is one) and the
 * response schema are attached by the caller; this text never contains the user's food
 * library or profile.
 */
export const buildCapturePrompt = (mode: CaptureMode, note?: string | null): string => {
  const trimmed = (note ?? "").trim().slice(0, NOTE_MAX_CHARS);
  const context = trimmed.length > 0
    ? mode === "describe"
      ? `This is the user's description of what they ate:\n"""\n${trimmed}\n"""`
      : `The user added this context. Treat it as authoritative — it overrides what the photo appears to show:\n"""\n${trimmed}\n"""`
    : "The user added no extra context.";
  return `You are filling in a single food entry for AIfoodpal, a private food tracker. Return only data conforming to the provided schema.

${RULES_FOR_MODE[mode]}

${SHARED_RULES}

${context}`;
};

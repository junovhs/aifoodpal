import { backfillEntryNutrition } from "./storage";
import { createEntry, isoDate, normalizeFood, normalizePeriod, type AppState, type Food, type FoodInput, type GoalType, type PaceMode, type Profile } from "./model";
import { latestWeight, nutritionTargets, shiftDate } from "./nutrition";

type UpsertFoodOperation = { type: "upsertFood"; food: FoodInput };
type AddEntryOperation = { type: "addEntry"; entry: { date?: string; period?: string; servings?: number; foodId?: string; food?: FoodInput } };
type AddWeightOperation = { type: "addWeight"; date?: string; weightLb: number };
type UpdateProfileOperation = { type: "updateProfile"; changes: Partial<Profile> };
type SetGoalOperation = { type: "setGoal"; goalType?: GoalType; goalWeightLb?: number; rateLbWeek?: number; paceMode?: PaceMode };
export type AiOperation = UpsertFoodOperation | AddEntryOperation | AddWeightOperation | UpdateProfileOperation | SetGoalOperation;
export interface AiResponse { schemaVersion: 1; summary?: string; operations: AiOperation[] }

const isOperation = (value: unknown): value is AiOperation =>
  Boolean(value && typeof value === "object" && ["upsertFood", "addEntry", "addWeight", "updateProfile", "setGoal"].includes(String((value as { type?: unknown }).type)));

const repairJsonText = (value: string): string => {
  const text = value
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\u00A0\u202F]/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
  let repaired = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      repaired += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; repaired += char; continue; }
    if (char === ",") {
      let next = index + 1;
      while (/\s/.test(text[next] ?? "")) next += 1;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    repaired += char;
  }
  return repaired;
};

const parseCandidate = (value: string, candidates: unknown[]): void => {
  const variants = [value, repairJsonText(value)];
  for (const variant of variants) {
    try {
      const parsed = JSON.parse(variant) as unknown;
      candidates.push(parsed);
      // Some mobile share/copy paths leave the entire JSON response encoded as a JSON string.
      if (typeof parsed === "string" && parsed !== variant) parseCandidate(parsed, candidates);
      return;
    } catch { /* Try the next conservative repair. */ }
  }
};

const jsonCandidates = (input: string): unknown[] => {
  const text = input.replace(/^\uFEFF/, "").trim();
  const candidates: unknown[] = [];
  parseCandidate(text, candidates);

  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    const stack: string[] = [];
    let quoted = false;
    let escaped = false;
    for (let end = start; end < text.length; end += 1) {
      const char = text[end]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') { quoted = true; continue; }
      if (char === "{" || char === "[") stack.push(char);
      else if (char === "}" || char === "]") {
        const expected = char === "}" ? "{" : "[";
        if (stack.pop() !== expected) break;
        if (stack.length === 0) {
          parseCandidate(text.slice(start, end + 1), candidates);
          break;
        }
      }
    }
  }
  return candidates;
};

export const parseAiResponse = (json: string): AiResponse => {
  const candidates = jsonCandidates(json);
  const objects = candidates.filter((candidate): candidate is Partial<AiResponse> => Boolean(candidate && typeof candidate === "object"));
  const value = objects.find((candidate) => "schemaVersion" in candidate && "operations" in candidate)
    ?? objects.find((candidate) => "schemaVersion" in candidate || "operations" in candidate);
  if (!value) {
    if (objects.length) throw new Error("JSON was found, but it is not an AIfoodpal response. Paste the complete AI reply.");
    throw new Error("No usable JSON was found. Paste the complete AI reply; code fences and extra text are okay.");
  }
  if (value.schemaVersion !== 1) {
    throw new Error(value.schemaVersion == null ? "The AI response is missing schemaVersion 1." : `Schema version ${value.schemaVersion} is not supported.`);
  }
  if (!Array.isArray(value.operations) || !value.operations.every(isOperation)) {
    throw new Error("The reply is not a valid AIfoodpal change set.");
  }
  return value as AiResponse;
};

export const buildFoodAiPrompt = (draft: FoodInput): string => `You are a structured data assistant for AIfoodpal, a private food tracker. Return ONLY valid JSON with no markdown or code fences.

Create or complete the food below as one upsertFood operation.

Rules:
- Nutrition represents ONE serving. Do not multiply values.
- Food names contain only the food identity. Never put quantities such as "2 tbsp" or "100 g" in the name; put them in serving.amount and serving.unit.
- Normalize common units to tsp, tbsp, fl oz, cup, ml, l, g, kg, oz, lb, serving, piece, slice, or container. A specific custom unit is allowed when needed.
- Preserve every known value in PARTIAL FOOD unless you have an explicit replacement.
- Make a best-effort estimate for calories, proteinG, carbsG, fatG, and fiberG whenever exact values are unavailable. Use typical portions, ingredients, preparation, and restaurant data as clues; do not leave core macros blank merely because an estimate is required.
- For detailed nutrients beyond those core macros, use a reasonable estimate when supported; otherwise use null, never an invented 0.
- Use 0 only when a nutrient is confidently zero.
- sugarG is TOTAL sugar. addedSugarG is ADDED sugar only.
- If this is a recipe, include recipe.ingredients and optional recipe.instructions. Estimate ingredient macros when amounts make that practical, and use them to estimate the recipe's per-serving totals; genuinely unknowable ingredient values may be null.
- A recipe is still one food. Do not create separate foods or entries for its ingredients.
- Do not add an addEntry operation. The user will review and save manually.

Required output:
{"schemaVersion":1,"summary":"short summary","operations":[{"type":"upsertFood","food":{"name":"string","brand":null,"serving":{"amount":1,"unit":"serving","description":"1 serving"},"nutrition":{"calories":0,"proteinG":0,"carbsG":0,"fatG":0,"fiberG":null,"sugarG":null,"addedSugarG":null,"saturatedFatG":null,"transFatG":null,"sodiumMg":null},"recipe":null,"sourceType":"user|label|restaurant|estimate","confidence":"high|medium|low","notes":null}}]}

Recipe shape when applicable:
{"ingredients":[{"name":"ingredient","amount":1,"unit":"cup","nutrition":{"calories":null,"proteinG":null,"carbsG":null,"fatG":null}}],"instructions":"optional directions"}

PARTIAL FOOD:
${JSON.stringify(draft, null, 2)}`;

export const importFoodDraft = (current: FoodInput, json: string): FoodInput => {
  let response: AiResponse;
  try {
    response = parseAiResponse(json);
  } catch (error) {
    const direct = jsonCandidates(json).find((candidate): candidate is Record<string, unknown> => Boolean(candidate && typeof candidate === "object" && !Array.isArray(candidate)));
    const food = direct?.type === "upsertFood" && direct.food && typeof direct.food === "object"
      ? direct.food
      : direct?.food && typeof direct.food === "object"
        ? direct.food
        : direct && ("name" in direct || "nutrition" in direct || "serving" in direct)
          ? direct
          : null;
    if (!food) throw error;
    response = { schemaVersion: 1, operations: [{ type: "upsertFood", food: food as FoodInput }] };
  }
  const operation = response.operations.find((item): item is UpsertFoodOperation => item.type === "upsertFood");
  if (!operation) throw new Error("The AI response does not contain an upsertFood operation.");
  if (!operation.food || typeof operation.food !== "object") throw new Error("The upsertFood operation is missing its food data.");
  const merged: FoodInput = {
    ...current,
    ...operation.food,
    serving: { ...(current.serving ?? {}), ...(operation.food.serving ?? {}) },
    nutrition: { ...(current.nutrition ?? {}), ...(operation.food.nutrition ?? {}) },
    recipe: operation.food.recipe === undefined ? current.recipe : operation.food.recipe,
  };
  if (current.id) merged.id = current.id;
  else delete merged.id;
  return merged;
};

export const buildAiPrompt = (state: AppState, request: string): string => {
  const start = shiftDate(state.prefs.date, -6);
  const context = {
    currentDate: isoDate(),
    selectedDate: state.prefs.date,
    profile: { ...state.profile, weightLb: latestWeight(state), dailyNutritionGuide: nutritionTargets(state.profile) },
    library: state.foods,
    recentEntries: state.entries.filter((entry) => entry.date >= start && entry.date <= state.prefs.date),
  };
  return `You are a structured data assistant for a private personal tracking app. Return ONLY valid JSON, with no markdown or code fences.

The app owns arithmetic, totals, storage, dates, and quantity multiplication. Interpret the user's request and structure the changes.

Rules:
- Prefer an existing library food and exact food id when it clearly matches.
- Nutrition always represents ONE serving. "servings" is the multiplier.
- Keep food names free of quantities. Store amounts and units in serving or recipe ingredient fields.
- Never delete anything.
- Preserve known values unless the user asks to correct them.
- When creating or completing a food, make a best-effort estimate for calories, proteinG, carbsG, fatG, and fiberG if exact nutrition is unavailable. Infer from typical portions, ingredients, preparation, brands, or restaurant data; core macros should not be left null merely because they are estimates.
- For detailed nutrients beyond those core macros, estimate when reasonably supported; otherwise use null, not 0.
- sugarG is total sugar; addedSugarG is added sugar only.
- Recipes remain one food and one diary entry. Store ingredients and instructions in food.recipe; never log ingredients separately.

Allowed operations:
1) {"type":"upsertFood","food":{"id":"existing id when updating","name":"string","brand":null,"serving":{"amount":1,"unit":"serving","description":"1 serving"},"nutrition":{"calories":0,"proteinG":0,"carbsG":0,"fatG":0,"fiberG":null,"sugarG":null,"addedSugarG":null,"saturatedFatG":null,"transFatG":null,"sodiumMg":null},"recipe":null,"sourceType":"user|label|restaurant|estimate","confidence":"high|medium|low","notes":null}}
2) {"type":"addEntry","entry":{"date":"YYYY-MM-DD","period":"breakfast|lunch|dinner|snacks","servings":1,"foodId":"existing id"}} (or include "food" for a new food)
3) {"type":"addWeight","date":"YYYY-MM-DD","weightLb":180.5}
4) {"type":"updateProfile","changes":{"age":30,"heightIn":70,"weightLb":180,"activityPAL":1.6,"manualDailyGuide":null}}
5) {"type":"setGoal","goalType":"lose|maintain|gain","goalWeightLb":160,"rateLbWeek":1,"paceMode":"slow|steady|fast"}

Output shape: {"schemaVersion":1,"summary":"short summary","operations":[]}

CURRENT CONTEXT:
${JSON.stringify(context, null, 2)}

USER REQUEST:
${request}`;
};

const upsertFood = (state: AppState, input: FoodInput): Food => {
  const index = input.id ? state.foods.findIndex((food) => food.id === input.id) : -1;
  const existing = index >= 0 ? state.foods[index] : undefined;
  const merged: FoodInput = existing ? {
    ...existing,
    ...input,
    serving: { ...existing.serving, ...(input.serving ?? {}) },
    nutrition: { ...existing.nutrition, ...(input.nutrition ?? {}) },
  } : input;
  if (input.id && !existing) delete merged.id;
  const food = normalizeFood(merged);
  if (existing) {
    food.createdAt = existing.createdAt;
    state.foods[index] = food;
  } else state.foods.push(food);
  backfillEntryNutrition(state, food.id);
  return food;
};

export const applyAiResponse = (source: AppState, response: AiResponse): { state: AppState; applied: number } => {
  const state = structuredClone(source);
  let applied = 0;
  for (const operation of response.operations) {
    if (operation.type === "upsertFood") {
      upsertFood(state, operation.food);
      applied += 1;
    } else if (operation.type === "addEntry") {
      let food = operation.entry.foodId ? state.foods.find((item) => item.id === operation.entry.foodId) : undefined;
      if (!food && operation.entry.food) food = upsertFood(state, operation.entry.food);
      if (food) {
        state.entries.push(createEntry(food, operation.entry.date ?? state.prefs.date, normalizePeriod(operation.entry.period), operation.entry.servings ?? 1));
        applied += 1;
      }
    } else if (operation.type === "addWeight" && operation.weightLb > 0) {
      const now = new Date().toISOString();
      state.weights.push({ id: `weight_${crypto.randomUUID()}`, date: operation.date ?? state.prefs.date, weightLb: operation.weightLb, createdAt: now, updatedAt: now });
      state.profile.weightLb = operation.weightLb;
      applied += 1;
    } else if (operation.type === "updateProfile") {
      const allowed: (keyof Profile)[] = ["units", "age", "sexForEquation", "heightIn", "weightLb", "activityPAL", "pregnantBreastfeeding", "manualDailyGuide", "nutritionPlanMode", "customNutritionTargets"];
      for (const key of allowed) if (key in operation.changes) Object.assign(state.profile, { [key]: operation.changes[key] });
      applied += 1;
    } else if (operation.type === "setGoal") {
      if (operation.goalType) state.profile.goalType = operation.goalType;
      if (operation.goalWeightLb && operation.goalWeightLb > 0) state.profile.goalWeightLb = operation.goalWeightLb;
      if (operation.rateLbWeek !== undefined && operation.rateLbWeek >= 0) state.profile.rateLbWeek = operation.rateLbWeek;
      if (operation.paceMode) state.profile.paceMode = operation.paceMode;
      applied += 1;
    }
  }
  backfillEntryNutrition(state);
  return { state, applied };
};

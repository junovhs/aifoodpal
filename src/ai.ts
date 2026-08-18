import { backfillEntryNutrition } from "./storage";
import { createEntry, normalizeFood, normalizePeriod, type AppState, type Food, type FoodInput, type GoalType, type PaceMode, type Profile } from "./model";
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

export const parseAiResponse = (json: string): AiResponse => {
  const value = JSON.parse(json) as Partial<AiResponse>;
  if (value.schemaVersion !== 1 || !Array.isArray(value.operations) || !value.operations.every(isOperation)) {
    throw new Error("The reply is not a valid AIfoodpal change set.");
  }
  return value as AiResponse;
};

export const buildAiPrompt = (state: AppState, request: string): string => {
  const start = shiftDate(state.prefs.date, -6);
  const context = {
    currentDate: new Date().toISOString().slice(0, 10),
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
- Never delete anything.
- Preserve known values unless the user asks to correct them.
- Unknown detailed nutrients must be null, not 0.
- sugarG is total sugar; addedSugarG is added sugar only.

Allowed operations:
1) {"type":"upsertFood","food":{"id":"existing id when updating","name":"string","brand":null,"serving":{"amount":1,"unit":"serving","description":"1 serving"},"nutrition":{"calories":0,"proteinG":0,"carbsG":0,"fatG":0,"fiberG":null,"sugarG":null,"addedSugarG":null,"saturatedFatG":null,"transFatG":null,"sodiumMg":null},"sourceType":"user|label|restaurant|estimate","confidence":"high|medium|low","notes":null}}
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

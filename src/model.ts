import { formatQuantity, normalizeUnit, servingMultiplier, splitTrailingQuantity } from "./units";

export const SCHEMA_VERSION = 3 as const;
export const PERIODS = ["breakfast", "lunch", "dinner", "snacks"] as const;

export type Period = (typeof PERIODS)[number];
export type Units = "imperial" | "metric";
export type GoalType = "lose" | "maintain" | "gain";
export type PaceMode = "slow" | "steady" | "fast";
export type SourceType = "user" | "label" | "restaurant" | "estimate";
export type Confidence = "high" | "medium" | "low";

export interface Nutrition {
  calories: number;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  fiberG: number | null;
  sugarG: number | null;
  addedSugarG: number | null;
  saturatedFatG: number | null;
  transFatG: number | null;
  sodiumMg: number | null;
}

export interface Portion {
  amount: number;
  unit: string;
}

export interface Serving extends Portion {
  description: string;
}

export interface RecipeIngredient {
  id: string;
  foodId: string | null;
  name: string;
  amount: number | null;
  unit: string;
  nutrition: {
    calories: number | null;
    proteinG: number | null;
    carbsG: number | null;
    fatG: number | null;
  };
}

export interface Recipe {
  ingredients: RecipeIngredient[];
  instructions: string | null;
}

export interface Food {
  id: string;
  name: string;
  brand: string | null;
  serving: Serving;
  nutrition: Nutrition;
  sourceType: SourceType;
  confidence: Confidence;
  notes: string | null;
  recipe: Recipe | null;
  createdAt: string;
  updatedAt: string;
}

export interface Entry {
  id: string;
  foodId: string;
  date: string;
  period: Period;
  servings: number;
  nameSnapshot: string;
  brandSnapshot: string | null;
  servingSnapshot: Serving;
  nutritionSnapshot: Nutrition;
  recipeSnapshot: Recipe | null;
  createdAt: string;
  updatedAt: string;
}

export interface Weight {
  id: string;
  date: string;
  weightLb: number;
  createdAt: string;
  updatedAt: string;
}

export type ExerciseKind = "strength" | "walkEasy" | "walkBrisk" | "workoutHard";

export interface Exercise {
  id: string;
  date: string;
  kind: ExerciseKind;
  minutes: number;
  createdAt: string;
  updatedAt: string;
}

export interface NutritionTargets {
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number;
}

export interface Profile {
  onboardingComplete: boolean;
  units: Units;
  age: number | null;
  sexForEquation: "male" | "female" | null;
  pregnantBreastfeeding: boolean;
  heightIn: number | null;
  weightLb: number | null;
  activityPAL: number;
  /** Weight the plan started from. Recorded when the plan is created, never inferred from check-in history (DEC-05). */
  startWeightLb: number | null;
  goalType: GoalType;
  goalWeightLb: number | null;
  rateLbWeek: number;
  paceMode: PaceMode;
  manualDailyGuide: number | null;
  nutritionPlanMode: "auto" | "custom";
  customNutritionTargets: NutritionTargets | null;
}

export interface AppState {
  schemaVersion: typeof SCHEMA_VERSION;
  createdAt: string;
  updatedAt: string;
  profile: Profile;
  foods: Food[];
  entries: Entry[];
  weights: Weight[];
  exercises: Exercise[];
  prefs: {
    date: string;
    protectedSnackBudgetEnabled: boolean;
    protectedSnackCalories: number;
  };
}

/** The effective snack reserve and any main-meal use of that reserve, expressed in calories and bar percentages. */
export interface ProtectedSnackBudget {
  snackCalories: number;
  mainCalories: number;
  mainPercent: number;
  encroachmentCalories: number;
  encroachmentPercent: number;
}

/** Converts a daily guide and opt-in snack reserve into renderable main-meal and encroachment allocations. */
export const protectedSnackBudget = (dailyGuide: number, requestedSnackCalories: number, loggedMainCalories: number): ProtectedSnackBudget => {
  const guide = Math.max(0, dailyGuide);
  const snackCalories = Math.min(guide, Math.max(0, requestedSnackCalories));
  const mainCalories = Math.max(0, guide - snackCalories);
  const encroachmentCalories = Math.min(snackCalories, Math.max(0, loggedMainCalories - mainCalories));
  return {
    snackCalories,
    mainCalories,
    mainPercent: guide ? mainCalories / guide * 100 : 0,
    encroachmentCalories,
    encroachmentPercent: guide ? encroachmentCalories / guide * 100 : 0,
  };
};

export const moveDiaryEntry = (entries: Entry[], entryId: string, period: Period, index: number): Entry[] => {
  const found = entries.find((entry) => entry.id === entryId);
  if (!found) return entries;
  const date = found.date;
  const firstDayIndex = entries.findIndex((entry) => entry.date === date);
  const moved = { ...found, period, updatedAt: new Date().toISOString() };
  const groups = new Map(PERIODS.map((candidate) => [candidate, entries.filter((entry) => entry.date === date && entry.period === candidate && entry.id !== entryId)]));
  const target = groups.get(period) ?? [];
  target.splice(Math.max(0, Math.min(index, target.length)), 0, moved);
  const reorderedDay = PERIODS.flatMap((candidate) => groups.get(candidate) ?? []);
  const result = entries.filter((entry) => entry.date !== date);
  result.splice(firstDayIndex < 0 ? result.length : firstDayIndex, 0, ...reorderedDay);
  return result;
};

export type FoodInput = Partial<Omit<Food, "serving" | "nutrition" | "recipe">> & {
  serving?: Partial<Serving>;
  nutrition?: Partial<Nutrition> & { satFatG?: number | null };
  recipe?: { ingredients?: Array<Partial<Omit<RecipeIngredient, "nutrition">> & { nutrition?: Partial<RecipeIngredient["nutrition"]> }>; instructions?: string | null } | null;
};

export const isoDate = (date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const uid = (prefix: string): string =>
  `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`}`;

const optionalNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : null;
};

const positiveNumber = (value: unknown, fallback = 0): number => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
};

const macroNumber = (value: unknown): number | null =>
  value === null ? null : positiveNumber(value);

export const emptyNutrition = (): Nutrition => ({
  calories: 0,
  proteinG: 0,
  carbsG: 0,
  fatG: 0,
  fiberG: null,
  sugarG: null,
  addedSugarG: null,
  saturatedFatG: null,
  transFatG: null,
  sodiumMg: null,
});

export const normalizeNutrition = (input: Partial<Nutrition> & { satFatG?: number | null } = {}): Nutrition => ({
  calories: positiveNumber(input.calories),
  proteinG: macroNumber(input.proteinG),
  carbsG: macroNumber(input.carbsG),
  fatG: macroNumber(input.fatG),
  fiberG: optionalNumber(input.fiberG),
  sugarG: optionalNumber(input.sugarG),
  addedSugarG: optionalNumber(input.addedSugarG),
  saturatedFatG: optionalNumber(input.saturatedFatG ?? input.satFatG),
  transFatG: optionalNumber(input.transFatG),
  sodiumMg: optionalNumber(input.sodiumMg),
});

const normalizeRecipe = (input: FoodInput["recipe"]): Recipe | null => {
  if (!input) return null;
  return {
    ingredients: (input.ingredients ?? []).map((ingredient) => ({
      id: ingredient.id ?? uid("ingredient"),
      foodId: ingredient.foodId ? String(ingredient.foodId) : null,
      name: String(ingredient.name ?? "").trim(),
      amount: optionalNumber(ingredient.amount),
      unit: normalizeUnit(ingredient.unit, ""),
      nutrition: {
        calories: optionalNumber(ingredient.nutrition?.calories),
        proteinG: optionalNumber(ingredient.nutrition?.proteinG),
        carbsG: optionalNumber(ingredient.nutrition?.carbsG),
        fatG: optionalNumber(ingredient.nutrition?.fatG),
      },
    })).filter((ingredient) => ingredient.name),
    instructions: input.instructions ? String(input.instructions).trim() : null,
  };
};

export const normalizePeriod = (value: unknown): Period => {
  const aliases: Record<string, Period> = {
    morning: "breakfast",
    midday: "lunch",
    evening: "dinner",
    other: "snacks",
    snack: "snacks",
    breakfast: "breakfast",
    lunch: "lunch",
    dinner: "dinner",
    snacks: "snacks",
  };
  return aliases[String(value ?? "").toLowerCase()] ?? "snacks";
};

export const normalizeFood = (input: FoodInput = {}): Food => {
  const now = new Date().toISOString();
  const sourceTypes: SourceType[] = ["user", "label", "restaurant", "estimate"];
  const confidences: Confidence[] = ["high", "medium", "low"];
  const rawName = String(input.name ?? "Untitled item").trim() || "Untitled item";
  const extracted = (!input.serving || normalizeUnit(input.serving.unit) === "serving" && positiveNumber(input.serving.amount, 1) === 1)
    ? splitTrailingQuantity(rawName)
    : null;
  const servingAmount = extracted?.amount ?? Math.max(0.0001, positiveNumber(input.serving?.amount, 1));
  const servingUnit = extracted?.unit ?? normalizeUnit(input.serving?.unit);
  return {
    id: input.id ?? uid("food"),
    name: extracted?.name ?? rawName,
    brand: input.brand ? String(input.brand).trim() : null,
    serving: {
      amount: servingAmount,
      unit: servingUnit,
      description: formatQuantity(servingAmount, servingUnit),
    },
    nutrition: normalizeNutrition(input.nutrition),
    sourceType: sourceTypes.includes(input.sourceType as SourceType) ? (input.sourceType as SourceType) : "estimate",
    confidence: confidences.includes(input.confidence as Confidence) ? (input.confidence as Confidence) : "medium",
    notes: input.notes ? String(input.notes) : null,
    recipe: normalizeRecipe(input.recipe),
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  };
};

export const createEntry = (food: Food, date: string, period: Period, servings = 1, id = uid("entry")): Entry => {
  const now = new Date().toISOString();
  return {
    id,
    foodId: food.id,
    date,
    period,
    servings: Math.max(0.01, servings),
    nameSnapshot: food.name,
    brandSnapshot: food.brand,
    servingSnapshot: { ...food.serving },
    nutritionSnapshot: { ...food.nutrition },
    recipeSnapshot: food.recipe ? structuredClone(food.recipe) : null,
    createdAt: now,
    updatedAt: now,
  };
};

export const createQuickCalorieEntry = (calories: number, date: string, period: Period): Entry => {
  const now = new Date().toISOString();
  const amount = Math.max(1, Math.round(calories));
  return {
    id: uid("entry"),
    foodId: "quick-calories",
    date,
    period,
    servings: 1,
    nameSnapshot: "Quick calories",
    brandSnapshot: null,
    servingSnapshot: { amount: 1, unit: "entry", description: "calorie estimate" },
    nutritionSnapshot: {
      calories: amount,
      proteinG: null,
      carbsG: null,
      fatG: null,
      fiberG: null,
      sugarG: null,
      addedSugarG: null,
      saturatedFatG: null,
      transFatG: null,
      sodiumMg: null,
    },
    recipeSnapshot: null,
    createdAt: now,
    updatedAt: now,
  };
};

/** Removes a reusable food while deliberately retaining immutable diary snapshots. */
export const removeFoodFromLibrary = (state: AppState, foodId: string): boolean => {
  const previousCount = state.foods.length;
  state.foods = state.foods.filter((food) => food.id !== foodId);
  return state.foods.length < previousCount;
};

export const createState = (date = isoDate()): AppState => {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    profile: {
      onboardingComplete: false,
      units: "imperial",
      age: null,
      sexForEquation: null,
      pregnantBreastfeeding: false,
      heightIn: null,
      weightLb: null,
      activityPAL: 1.6,
      startWeightLb: null,
      goalType: "lose",
      goalWeightLb: null,
      rateLbWeek: 1,
      paceMode: "steady",
      manualDailyGuide: null,
      nutritionPlanMode: "auto",
      customNutritionTargets: null,
    },
    foods: [],
    entries: [],
    weights: [],
    exercises: [],
    prefs: { date, protectedSnackBudgetEnabled: false, protectedSnackCalories: 200 },
  };
};

/** Convert the amount eaten now into the multiplier stored by a diary entry. */
export const servingsForPortion = (portion: Portion, serving: Serving): number =>
  servingMultiplier(portion.amount, portion.unit, serving);

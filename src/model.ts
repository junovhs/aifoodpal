export const SCHEMA_VERSION = 1 as const;
export const PERIODS = ["breakfast", "lunch", "dinner", "snacks"] as const;

export type Period = (typeof PERIODS)[number];
export type Units = "imperial" | "metric";
export type GoalType = "lose" | "maintain" | "gain";
export type PaceMode = "slow" | "steady" | "fast";
export type SourceType = "user" | "label" | "restaurant" | "estimate";
export type Confidence = "high" | "medium" | "low";

export interface Nutrition {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number | null;
  sugarG: number | null;
  addedSugarG: number | null;
  saturatedFatG: number | null;
  transFatG: number | null;
  sodiumMg: number | null;
}

export interface Serving {
  amount: number;
  unit: string;
  description: string;
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
  prefs: { date: string };
}

export type FoodInput = Partial<Omit<Food, "serving" | "nutrition">> & {
  serving?: Partial<Serving>;
  nutrition?: Partial<Nutrition> & { satFatG?: number | null };
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
  proteinG: positiveNumber(input.proteinG),
  carbsG: positiveNumber(input.carbsG),
  fatG: positiveNumber(input.fatG),
  fiberG: optionalNumber(input.fiberG),
  sugarG: optionalNumber(input.sugarG),
  addedSugarG: optionalNumber(input.addedSugarG),
  saturatedFatG: optionalNumber(input.saturatedFatG ?? input.satFatG),
  transFatG: optionalNumber(input.transFatG),
  sodiumMg: optionalNumber(input.sodiumMg),
});

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
  return {
    id: input.id ?? uid("food"),
    name: String(input.name ?? "Untitled item").trim() || "Untitled item",
    brand: input.brand ? String(input.brand).trim() : null,
    serving: {
      amount: Math.max(0.0001, positiveNumber(input.serving?.amount, 1)),
      unit: String(input.serving?.unit ?? "serving"),
      description: String(input.serving?.description ?? "1 serving"),
    },
    nutrition: normalizeNutrition(input.nutrition),
    sourceType: sourceTypes.includes(input.sourceType as SourceType) ? (input.sourceType as SourceType) : "estimate",
    confidence: confidences.includes(input.confidence as Confidence) ? (input.confidence as Confidence) : "medium",
    notes: input.notes ? String(input.notes) : null,
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
    createdAt: now,
    updatedAt: now,
  };
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
    prefs: { date },
  };
};

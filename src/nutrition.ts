import { emptyNutrition, isoDate, type AppState, type Entry, type ExerciseKind, type Nutrition, type NutritionTargets, type Profile } from "./model";

export const FDA_DAILY_VALUES = { saturatedFatG: 20, sodiumMg: 2300, addedSugarG: 50, fiberG: 28 } as const;
export const CALORIE_FLOOR = 1000;
const PROJECTION_WINDOW_DAYS = 7;
const MIN_STABLE_GOAL_RATE_LB_WEEK = 0.25;

export const numberOr = (value: unknown, fallback = 0): number => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

export const round = (value: number, digits = 0): number => {
  const power = 10 ** digits;
  return Math.round((value + Number.EPSILON) * power) / power;
};

export const poundsToKg = (pounds: number): number => pounds / 2.2046226218;
export const kgToPounds = (kg: number): number => kg * 2.2046226218;
export const inchesToCm = (inches: number): number => inches * 2.54;
export const cmToInches = (cm: number): number => cm / 2.54;

export const parseLocalDate = (value: string): Date => {
  const [year = 1970, month = 1, day = 1] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
};

export const shiftDate = (value: string, days: number): string => {
  const date = parseLocalDate(value);
  date.setDate(date.getDate() + days);
  return isoDate(date);
};

export const formatDate = (value: string, long = false): string =>
  new Intl.DateTimeFormat(undefined, long
    ? { weekday: "long", month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" }).format(parseLocalDate(value));

export const restingMetabolicRate = (profile: Profile, weightOverride?: number): number | null => {
  const age = numberOr(profile.age, Number.NaN);
  const weight = numberOr(weightOverride ?? profile.weightLb, Number.NaN);
  const height = numberOr(profile.heightIn, Number.NaN);
  if (![age, weight, height].every(Number.isFinite) || !profile.sexForEquation) return null;
  return 10 * poundsToKg(weight) + 6.25 * inchesToCm(height) - 5 * age + (profile.sexForEquation === "male" ? 5 : -161);
};

export interface Guidance {
  ok: boolean;
  reason: string | null;
  maintenance: number | null;
  target: number | null;
  rate: number;
  weeks: number | null;
  targetDate: string | null;
  floorLimited: boolean;
}

export const calorieGuidance = (profile: Profile): Guidance => {
  const result: Guidance = {
    ok: false,
    reason: null,
    maintenance: null,
    target: null,
    rate: numberOr(profile.rateLbWeek),
    weeks: null,
    targetDate: null,
    floorLimited: false,
  };
  if (numberOr(profile.age) < 18) {
    result.reason = "Automatic guidance is only provided for adults.";
    return result;
  }
  if (profile.pregnantBreastfeeding) {
    result.reason = "Automatic guidance is not provided during pregnancy or breastfeeding.";
    return result;
  }
  const resting = restingMetabolicRate(profile);
  if (!resting) {
    result.reason = "Add age, height, weight, and equation sex to calculate a guide.";
    return result;
  }
  result.maintenance = resting * profile.activityPAL;
  const adjustment = profile.goalType === "lose" ? result.rate * 500 : profile.goalType === "gain" ? -result.rate * 500 : 0;
  const raw = result.maintenance - adjustment;
  result.target = Math.max(CALORIE_FLOOR, raw);
  result.floorLimited = raw < CALORIE_FLOOR;
  const current = numberOr(profile.weightLb);
  const goal = numberOr(profile.goalWeightLb);
  const effectiveRate = profile.goalType === "maintain" ? 0 : Math.abs(result.maintenance - result.target) * 7 / 3500;
  if (current && goal && effectiveRate) {
    result.weeks = Math.abs(current - goal) / effectiveRate;
    const date = new Date();
    date.setDate(date.getDate() + Math.round(result.weeks * 7));
    result.targetDate = isoDate(date);
  }
  result.ok = true;
  return result;
};

export const dailyCalorieGuide = (profile: Profile): number | null =>
  profile.manualDailyGuide && profile.manualDailyGuide > 0 ? profile.manualDailyGuide : calorieGuidance(profile).target;

export const nutritionTargets = (profile: Profile): NutritionTargets | null => {
  const calories = dailyCalorieGuide(profile);
  if (!calories) return null;
  if (profile.nutritionPlanMode === "custom" && profile.customNutritionTargets) return profile.customNutritionTargets;
  const currentKg = profile.weightLb ? poundsToKg(profile.weightLb) : 0;
  const goalKg = profile.goalWeightLb ? poundsToKg(profile.goalWeightLb) : 0;
  let proteinG = calories * 0.27 / 4;
  if (profile.goalType === "lose" && currentKg) proteinG = Math.max(currentKg * 1.3, goalKg ? goalKg * 1.6 : currentKg * 1.4);
  if (profile.goalType === "gain" && currentKg) proteinG = currentKg * 1.6;
  if (profile.goalType === "maintain" && currentKg) proteinG = currentKg * 1.4;
  proteinG = Math.min(proteinG, calories * 0.35 / 4);
  const fatG = calories * 0.3 / 9;
  return {
    proteinG,
    fatG,
    carbsG: Math.max(0, (calories - proteinG * 4 - fatG * 9) / 4),
    fiberG: calories / 2000 * FDA_DAILY_VALUES.fiberG,
  };
};

export const multiplyNutrition = (nutrition: Nutrition, servings: number): Nutrition => {
  const output = emptyNutrition();
  const target = output as Record<keyof Nutrition, number | null>;
  for (const key of Object.keys(output) as (keyof Nutrition)[]) {
    const value = nutrition[key];
    target[key] = value === null ? null : value * servings;
  }
  return output;
};

export const sumNutrition = (items: Nutrition[]): Nutrition => {
  const output = emptyNutrition();
  const target = output as Record<keyof Nutrition, number | null>;
  const seen = new Set<keyof Nutrition>();
  for (const key of Object.keys(output) as (keyof Nutrition)[]) target[key] = 0;
  for (const item of items) {
    for (const key of Object.keys(output) as (keyof Nutrition)[]) {
      const value = item[key];
      if (value !== null) {
        target[key] = numberOr(target[key]) + value;
        seen.add(key);
      }
    }
  }
  for (const key of Object.keys(output) as (keyof Nutrition)[]) if (!seen.has(key)) target[key] = null;
  for (const key of ["calories", "proteinG", "carbsG", "fatG"] as const) output[key] ??= 0;
  return output;
};

export const entryNutrition = (entry: Entry): Nutrition => multiplyNutrition(entry.nutritionSnapshot, entry.servings);

export const totalsFor = (state: AppState, date: string, period?: Entry["period"]): Nutrition =>
  sumNutrition(state.entries
    .filter((entry) => entry.date === date && (!period || entry.period === period))
    .map(entryNutrition));

export const latestWeight = (state: AppState): number | null => {
  const latest = [...state.weights].sort((left, right) => right.date.localeCompare(left.date))[0];
  return latest?.weightLb ?? state.profile.weightLb;
};

export interface CalorieAverage {
  average: number | null;
  activeDays: number;
  calories: number;
}

export interface CalorieTrend {
  activeDayAverage: CalorieAverage;
  week: CalorieAverage;
  month: CalorieAverage;
}

const averageBetween = (dailyCalories: Map<string, number>, start: string | null, end: string): CalorieAverage => {
  const values = [...dailyCalories]
    .filter(([date]) => (!start || date >= start) && date <= end)
    .map(([, calories]) => calories);
  const calories = values.reduce((sum, value) => sum + value, 0);
  return { average: values.length ? calories / values.length : null, activeDays: values.length, calories };
};

/** Active-day intake averages. Unlogged days are excluded instead of being treated as zero-calorie days. */
export const calorieTrend = (state: AppState, anchor = isoDate()): CalorieTrend => {
  const dailyCalories = new Map<string, number>();
  for (const entry of state.entries) {
    if (entry.date > anchor) continue;
    dailyCalories.set(entry.date, (dailyCalories.get(entry.date) ?? 0) + entryNutrition(entry).calories);
  }
  return {
    activeDayAverage: averageBetween(dailyCalories, null, anchor),
    week: averageBetween(dailyCalories, shiftDate(anchor, -6), anchor),
    month: averageBetween(dailyCalories, shiftDate(anchor, -29), anchor),
  };
};

export const EXERCISE_MET: Record<ExerciseKind, number> = {
  strength: 3.5,
  walkEasy: 3,
  walkBrisk: 4.3,
  workoutHard: 6,
};

/** Estimated energy above rest. MET values are deliberately broad because pace and effort are not measured. */
export const exerciseCalories = (kind: ExerciseKind, minutes: number, weightLb: number): number =>
  Math.max(0, EXERCISE_MET[kind] - 1) * 3.5 * poundsToKg(weightLb) / 200 * Math.max(0, minutes);

export interface WeightProjection {
  averageIntake: number;
  activeDays: number;
  spanDays: number;
  baselineMaintenance: number;
  averageExercise: number;
  dailyDeficit: number;
  weeklyChangeLb: number;
  oneMonthWeightLb: number;
  goalDate: string | null;
}

/** Projects the logged trend; positive weeklyChangeLb means loss and negative means gain. */
export const weightProjection = (state: AppState, anchor = isoDate()): WeightProjection | null => {
  const current = latestWeight(state);
  const resting = current == null ? null : restingMetabolicRate(state.profile, current);
  if (!current || !resting) return null;

  // A partially logged current day is not evidence about a full future day. Use one
  // complete calendar week, and fail closed when any day's intake is unknown.
  const lastCompleteDate = shiftDate(anchor, -1);
  const firstDate = shiftDate(lastCompleteDate, -(PROJECTION_WINDOW_DAYS - 1));
  const completedDates = Array.from(
    { length: PROJECTION_WINDOW_DAYS },
    (_, index) => shiftDate(firstDate, index),
  );
  const loggedDates = new Set(
    state.entries
      .filter((entry) => entry.date >= firstDate && entry.date <= lastCompleteDate)
      .map((entry) => entry.date),
  );
  if (completedDates.some((date) => !loggedDates.has(date))) return null;

  const intakeTotal = completedDates.reduce((sum, date) => sum + totalsFor(state, date).calories, 0);
  const averageIntake = intakeTotal / PROJECTION_WINDOW_DAYS;
  const exerciseTotal = state.exercises
    .filter((entry) => entry.date >= firstDate && entry.date <= lastCompleteDate)
    .reduce((sum, entry) => sum + exerciseCalories(entry.kind, entry.minutes, current), 0);
  const averageExercise = exerciseTotal / PROJECTION_WINDOW_DAYS;
  const baselineMaintenance = resting * state.profile.activityPAL;
  const dailyDeficit = baselineMaintenance + averageExercise - averageIntake;
  const dailyChangeLb = -dailyDeficit / 3500;
  const weeklyChangeLb = dailyDeficit * 7 / 3500;
  const goal = state.profile.goalWeightLb;
  let goalDate: string | null = null;
  if (goal != null && Math.abs(goal - current) < 0.05) goalDate = anchor;
  else if (goal != null && Math.abs(weeklyChangeLb) >= MIN_STABLE_GOAL_RATE_LB_WEEK && (goal - current) * dailyChangeLb > 0) {
    goalDate = shiftDate(anchor, Math.ceil(Math.abs((goal - current) / dailyChangeLb)));
  }
  return {
    averageIntake,
    activeDays: PROJECTION_WINDOW_DAYS,
    spanDays: PROJECTION_WINDOW_DAYS,
    baselineMaintenance,
    averageExercise,
    dailyDeficit,
    weeklyChangeLb,
    oneMonthWeightLb: current + dailyChangeLb * 30,
    goalDate,
  };
};

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

/** Energy burned on a normal day before planned workouts. Independent of the chosen pace. */
export const maintenanceCalories = (profile: Profile): number | null => {
  const resting = restingMetabolicRate(profile);
  return resting === null ? null : resting * profile.activityPAL;
};

/**
 * The inverse of the guide: the weekly pace a chosen daily calorie figure actually produces.
 * Pace and guide are two views of one plan intent (DEC-04), so editing either must move the other.
 */
export const paceFromDailyGuide = (profile: Profile, guide: number): number | null => {
  const maintenance = maintenanceCalories(profile);
  if (maintenance === null || !Number.isFinite(guide) || guide <= 0) return null;
  if (profile.goalType === "maintain") return 0;
  const gap = profile.goalType === "gain" ? guide - maintenance : maintenance - guide;
  return Math.max(0, gap / 500);
};

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

/**
 * The plan's daily calorie guide. Derived from the one stored intent (DEC-04); a legacy manual
 * guide is honoured only while no body baseline exists to derive from, and migration converts
 * it into the pace it implies as soon as one does.
 */
export const dailyCalorieGuide = (profile: Profile): number | null =>
  calorieGuidance(profile).target
  ?? (profile.manualDailyGuide && profile.manualDailyGuide > 0 ? profile.manualDailyGuide : null);

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

/**
 * The profile every calorie calculation must read (DEC-05). Body weight always comes
 * from the newest check-in, so guidance and projection can never quote different weights.
 */
export const planProfile = (state: AppState): Profile => ({ ...state.profile, weightLb: latestWeight(state) });

/**
 * The weight the plan started from. A recorded fact, so deleting an old check-in cannot
 * rewrite how much progress the user has made. Falls back only for states predating the field.
 */
export const startWeight = (state: AppState): number | null =>
  state.profile.startWeightLb
  ?? [...state.weights].sort((left, right) => left.date.localeCompare(right.date))[0]?.weightLb
  ?? state.profile.weightLb
  ?? latestWeight(state);

/** Percentage traveled from a starting check-in toward a goal, never rewarding movement away. */
export const goalProgressPercent = (start: number, current: number, goal: number): number => {
  const total = goal - start;
  if (Math.abs(total) < 0.05) return Math.abs(current - goal) < 0.05 ? 100 : 0;
  const traveledTowardGoal = (current - start) * Math.sign(total);
  return Math.max(0, Math.min(100, traveledTowardGoal / Math.abs(total) * 100));
};

/** Calendar date implied by a saved weekly pace, independent of short-term calorie estimates. */
export const goalDateFromPace = (current: number, goal: number, rateLbWeek: number, anchor = isoDate()): string | null => {
  if (![current, goal, rateLbWeek].every(Number.isFinite) || current <= 0 || goal <= 0 || rateLbWeek <= 0) return null;
  return shiftDate(anchor, Math.round(Math.abs(current - goal) / rateLbWeek * 7));
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

const REPAYMENT_DAYS = 7;

/**
 * One rolling week measured against the plan (DEC-06): what was eaten, what it borrowed or
 * saved, the smallest adjustment that repays it, and where the goal date sits as a result.
 * Every field is evidence about the window, never a verdict on a day.
 */
export interface WeekBalance {
  /** The plan's daily calorie guide the window is measured against. */
  guide: number;
  windowStart: string;
  windowEnd: string;
  /** Days in the window with any food logged. Unlogged days are excluded, never counted as zero. */
  loggedDays: number;
  loggedCalories: number;
  /** What the plan allowed across the logged days. */
  budgetedCalories: number;
  /** Calories eaten above the plan across the window. Zero when the week is even or under. */
  borrowedCalories: number;
  /** Calories left unspent across the window. Zero when the week is over. */
  savedCalories: number;
  /** Days the repayment is spread across. */
  repaymentDays: number;
  /** The daily average over the coming week that returns the balance to even. */
  catchUpDailyGuide: number;
  /** False when repaying inside the coming week would mean eating below the calorie floor. */
  catchUpReachable: boolean;
  /**
    * Weekly change the window's own intake and exercise imply; positive means losing. Null when
    * there is no body baseline, because nothing about weight can honestly be inferred without one.
    */
  observedWeeklyChangeLb: number | null;
  /** The goal date the saved plan points to. */
  planGoalDate: string | null;
  /** The goal date the window's own behaviour points to. */
  observedGoalDate: string | null;
  /** Days the observed date sits later than the plan date. Negative means ahead of plan. */
  goalDateDriftDays: number | null;
  /**
   * The daily average, sustained for the whole remaining span, that still lands on the plan
   * date. Null when there is no plan date to hold or the span has run out. It can fall below
   * the calorie floor, which is the honest signal that the original date is out of reach.
   */
  holdPlanDailyGuide: number | null;
  /** The span holdPlanDailyGuide must be sustained across. */
  holdPlanDays: number | null;
}

/**
 * The rolling seven-day balance (DEC-06). Adherence is a week, not a verdict on a day: a heavy
 * day borrows from the week and is answered with the smallest daily average that repays it,
 * and when the week cannot repay it the goal date moves rather than the user failing.
 */
export const weekBalance = (state: AppState, anchor = isoDate()): WeekBalance | null => {
  const profile = planProfile(state);
  const guide = dailyCalorieGuide(profile);
  const current = latestWeight(state);
  if (!guide || current == null) return null;

  // A partially logged current day is not evidence about a full day, matching weightProjection.
  const windowEnd = shiftDate(anchor, -1);
  const windowStart = shiftDate(windowEnd, -(PROJECTION_WINDOW_DAYS - 1));
  const dates = Array.from({ length: PROJECTION_WINDOW_DAYS }, (_, index) => shiftDate(windowStart, index));
  const logged = dates.filter((date) => state.entries.some((entry) => entry.date === date));
  const loggedCalories = logged.reduce((sum, date) => sum + totalsFor(state, date).calories, 0);
  const budgetedCalories = guide * logged.length;
  const difference = loggedCalories - budgetedCalories;
  const borrowedCalories = Math.max(0, difference);
  const savedCalories = Math.max(0, -difference);
  const catchUpDailyGuide = guide - borrowedCalories / REPAYMENT_DAYS;

  const exerciseTotal = state.exercises
    .filter((entry) => entry.date >= windowStart && entry.date <= windowEnd)
    .reduce((sum, entry) => sum + exerciseCalories(entry.kind, entry.minutes, current), 0);
  // Without a body baseline there is no maintenance to measure intake against, so the window
  // says nothing about weight. A guide can still exist here as a legacy manual figure, and
  // inferring a pace from it would be inventing evidence.
  const maintenance = maintenanceCalories(profile);
  const averageIntake = logged.length ? loggedCalories / logged.length : guide;
  const averageExercise = logged.length ? exerciseTotal / logged.length : 0;
  const observedWeeklyChangeLb = maintenance === null
    ? null
    : (maintenance + averageExercise - averageIntake) * 7 / 3500;

  const goal = profile.goalWeightLb;
  const planGoalDate = goal == null ? null : goalDateFromPace(current, goal, profile.rateLbWeek, anchor);
  const observedGoalDate = goal == null || observedWeeklyChangeLb === null
    || Math.abs(observedWeeklyChangeLb) < MIN_STABLE_GOAL_RATE_LB_WEEK
    || (goal - current) * -observedWeeklyChangeLb <= 0
    ? null
    : goalDateFromPace(current, goal, Math.abs(observedWeeklyChangeLb), anchor);

  const dayGap = (from: string, to: string): number =>
    Math.round((parseLocalDate(to).getTime() - parseLocalDate(from).getTime()) / 86400000);
  const holdPlanDays = planGoalDate ? dayGap(anchor, planGoalDate) : null;
  // The average that actually holds the date is the one sustained across the whole remaining
  // span. A figure held for a few weeks and then abandoned does not hold anything.
  const holdPlanDailyGuide = goal != null && maintenance !== null && holdPlanDays != null && holdPlanDays > 0
    ? maintenance + averageExercise - Math.abs(current - goal) * 3500 / holdPlanDays
    : null;

  return {
    guide,
    windowStart,
    windowEnd,
    loggedDays: logged.length,
    loggedCalories,
    budgetedCalories,
    borrowedCalories,
    savedCalories,
    repaymentDays: REPAYMENT_DAYS,
    catchUpDailyGuide,
    catchUpReachable: catchUpDailyGuide >= CALORIE_FLOOR,
    observedWeeklyChangeLb,
    planGoalDate,
    observedGoalDate,
    goalDateDriftDays: planGoalDate && observedGoalDate ? dayGap(planGoalDate, observedGoalDate) : null,
    holdPlanDailyGuide,
    holdPlanDays,
  };
};

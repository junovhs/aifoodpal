import {
  SCHEMA_VERSION,
  createState,
  normalizeFood,
  normalizeNutrition,
  normalizePeriod,
  type AppState,
} from "./model";

export const STORAGE_KEY = "daybook.prototype.v1";

export interface StateRepository {
  load(): AppState;
  save(state: AppState): void;
}

export const migrateState = (value: unknown): AppState => {
  if (!value || typeof value !== "object") throw new Error("Backup must be a JSON object.");
  const input = value as Omit<Partial<AppState>, "schemaVersion"> & { schemaVersion?: number; preferences?: AppState["prefs"] };
  if (![1, 2, SCHEMA_VERSION].includes(input.schemaVersion ?? -1)) throw new Error("This backup uses an unsupported schema version.");
  const base = createState();
  const state: AppState = {
    ...base,
    ...input,
    schemaVersion: SCHEMA_VERSION,
    profile: { ...base.profile, ...(input.profile ?? {}) },
    prefs: { ...base.prefs, ...(input.prefs ?? input.preferences ?? {}) },
    foods: Array.isArray(input.foods) ? input.foods.map((food) => normalizeFood(food)) : [],
    entries: Array.isArray(input.entries)
      ? input.entries.map((entry) => ({
          ...entry,
          period: normalizePeriod(entry.period),
          nutritionSnapshot: normalizeNutrition(entry.nutritionSnapshot),
          recipeSnapshot: entry.recipeSnapshot ?? null,
        }))
      : [],
    weights: Array.isArray(input.weights) ? input.weights : [],
    exercises: Array.isArray(input.exercises) ? input.exercises : [],
  };
  backfillEntryNutrition(state);
  return state;
};

export const backfillEntryNutrition = (state: AppState, foodId?: string): number => {
  const foods = new Map(state.foods.map((food) => [food.id, food]));
  const optional = ["fiberG", "sugarG", "addedSugarG", "saturatedFatG", "transFatG", "sodiumMg"] as const;
  let changed = 0;
  for (const entry of state.entries) {
    if (foodId && entry.foodId !== foodId) continue;
    const food = foods.get(entry.foodId);
    if (!food) continue;
    for (const key of optional) {
      if (entry.nutritionSnapshot[key] === null && food.nutrition[key] !== null) {
        entry.nutritionSnapshot[key] = food.nutrition[key];
        changed += 1;
      }
    }
  }
  return changed;
};

export const parseBackup = (json: string): AppState => migrateState(JSON.parse(json) as unknown);

export const exportBackup = (state: AppState): string =>
  JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2);

export const browserRepository: StateRepository = {
  load() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? migrateState(JSON.parse(saved) as unknown) : createState();
    } catch {
      return createState();
    }
  },
  save(state) {
    state.updatedAt = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  },
};

import { describe, expect, it } from "vitest";
import { applyAiResponse, buildAiPrompt, buildFoodAiPrompt, importFoodDraft, parseAiResponse } from "../src/ai";
import { createEntry, createQuickCalorieEntry, createState, moveDiaryEntry, normalizeFood, protectedSnackBudget, removeFoodFromLibrary, type AppState } from "../src/model";
import { calorieGuidance, nutritionTargets, totalsFor } from "../src/nutrition";
import { exportBackup, parseBackup } from "../src/storage";
import { calendarGrid, formatMonth, shiftMonth } from "../src/calendar";
import { createComboFood } from "../src/combos";
import { convertAmount, normalizeUnit, servingMultiplier, splitTrailingQuantity } from "../src/units";

const readyState = () => {
  const state = createState("2026-08-17");
  Object.assign(state.profile, {
    onboardingComplete: true,
    age: 35,
    sexForEquation: "female",
    heightIn: 66,
    weightLb: 180,
    goalWeightLb: 155,
    activityPAL: 1.6,
    goalType: "lose",
    rateLbWeek: 1,
  });
  return state;
};

describe("nutrition domain", () => {
  it("measures when main meals consume a protected snack reserve", () => {
    expect(protectedSnackBudget(2000, 400, 1700)).toEqual({
      snackCalories: 400,
      mainCalories: 1600,
      mainPercent: 80,
      encroachmentCalories: 100,
      encroachmentPercent: 5,
    });
  });
  it("reorders foods within a meal and moves them across meals", () => {
    const date = "2026-08-18";
    const foods = ["Toast", "Coffee", "Soup"].map((name) => normalizeFood({ name, nutrition: { calories: 100 } }));
    const toast = createEntry(foods[0]!, date, "breakfast");
    const coffee = createEntry(foods[1]!, date, "breakfast");
    const soup = createEntry(foods[2]!, date, "lunch");
    const reordered = moveDiaryEntry([toast, coffee, soup], coffee.id, "breakfast", 0);
    expect(reordered.map((entry) => entry.nameSnapshot)).toEqual(["Coffee", "Toast", "Soup"]);
    const moved = moveDiaryEntry(reordered, toast.id, "lunch", 1);
    expect(moved.map((entry) => [entry.nameSnapshot, entry.period])).toEqual([
      ["Coffee", "breakfast"],
      ["Soup", "lunch"],
      ["Toast", "lunch"],
    ]);
  });

  it("calculates a bounded energy guide and coherent macro targets", () => {
    const state = readyState();
    const guidance = calorieGuidance(state.profile);
    const targets = nutritionTargets(state.profile);
    expect(guidance.ok).toBe(true);
    expect(guidance.target).toBeGreaterThanOrEqual(1000);
    expect(targets?.proteinG).toBeGreaterThan(0);
    expect(targets?.carbsG).toBeGreaterThan(0);
    expect(targets?.fatG).toBeGreaterThan(0);
  });

  it("multiplies snapshot nutrition without changing the library food", () => {
    const state = readyState();
    const food = normalizeFood({ name: "Toast", nutrition: { calories: 100, proteinG: 4, carbsG: 18, fatG: 2 } });
    state.foods.push(food);
    state.entries.push(createEntry(food, state.prefs.date, "breakfast", 2.5));
    expect(totalsFor(state, state.prefs.date).calories).toBe(250);
    expect(food.nutrition.calories).toBe(100);
  });

  it("logs quick calories without inventing macro values", () => {
    const state = readyState();
    const entry = createQuickCalorieEntry(80, state.prefs.date, "snacks");
    state.entries.push(entry);
    expect(entry.nutritionSnapshot).toMatchObject({ calories: 80, proteinG: null, carbsG: null, fatG: null });
    expect(totalsFor(state, state.prefs.date).calories).toBe(80);
  });

  it("snapshots a recipe as one expandable diary entry", () => {
    const food = normalizeFood({
      name: "Taco bowls",
      nutrition: { calories: 510, proteinG: 28, carbsG: 58, fatG: 18 },
      recipe: { ingredients: [{ name: "Black beans", amount: 1, unit: "cup", nutrition: { calories: 220, proteinG: 14 } }], instructions: "Assemble the bowls." },
    });
    const entry = createEntry(food, "2026-08-17", "dinner");
    food.recipe!.ingredients[0]!.name = "Changed later";
    expect(entry.foodId).toBe(food.id);
    expect(entry.recipeSnapshot?.ingredients[0]?.name).toBe("Black beans");
    expect(entry.recipeSnapshot?.instructions).toBe("Assemble the bowls.");
  });

  it("removes a library food without deleting its diary snapshots", () => {
    const state = readyState();
    const food = normalizeFood({ name: "Archived soup", nutrition: { calories: 220, proteinG: 8, carbsG: 30, fatG: 7 } });
    state.foods.push(food);
    state.entries.push(createEntry(food, state.prefs.date, "lunch"));
    expect(removeFoodFromLibrary(state, food.id)).toBe(true);
    expect(state.foods).toHaveLength(0);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]?.nameSnapshot).toBe("Archived soup");
    expect(removeFoodFromLibrary(state, food.id)).toBe(false);
  });
});

describe("portions and saved combos", () => {
  it("normalizes kitchen aliases and converts only compatible dimensions", () => {
    expect(normalizeUnit("Tablespoons")).toBe("tbsp");
    expect(convertAmount(1, "cup", "tbsp")).toBeCloseTo(16);
    expect(convertAmount(100, "g", "oz")).toBeCloseTo(3.5274);
    expect(servingMultiplier(2, "tbsp", { amount: 1, unit: "tbsp" })).toBe(2);
    expect(() => convertAmount(2, "tbsp", "g")).toThrow(/cannot convert/i);
    expect(() => convertAmount(1, "slice", "container")).toThrow(/cannot convert/i);
    expect(splitTrailingQuantity("Cream cheese, 2 tablespoons")).toEqual({ name: "Cream cheese", amount: 2, unit: "tbsp" });
    expect(normalizeFood({ name: "Cream cheese, 2 tbsp", nutrition: { calories: 100 } })).toMatchObject({ name: "Cream cheese", serving: { amount: 2, unit: "tbsp", description: "2 tbsp" } });
  });

  it("saves selected food portions as one expandable reusable combo", () => {
    const bagel = normalizeFood({
      name: "WinCo cheddar jalapeño bagel, top half",
      serving: { amount: 1, unit: "piece" },
      nutrition: { calories: 170, proteinG: 6, carbsG: 29, fatG: 3 },
    });
    const creamCheese = normalizeFood({
      name: "Cream cheese",
      serving: { amount: 1, unit: "tbsp" },
      nutrition: { calories: 50, proteinG: 1, carbsG: 1, fatG: 5 },
    });
    const combo = createComboFood("Bagel + cream cheese", [
      { food: bagel, amount: 1, unit: "piece" },
      { food: creamCheese, amount: 2, unit: "tablespoons" },
    ]);
    const entry = createEntry(combo, "2026-08-18", "breakfast");

    expect(combo.nutrition).toMatchObject({ calories: 270, proteinG: 8, carbsG: 31, fatG: 13 });
    expect(combo.recipe?.ingredients).toHaveLength(2);
    expect(combo.recipe?.ingredients[1]).toMatchObject({ foodId: creamCheese.id, name: "Cream cheese", amount: 2, unit: "tbsp", nutrition: { calories: 100 } });
    expect(entry.nameSnapshot).toBe("Bagel + cream cheese");
    expect(entry.recipeSnapshot?.ingredients[0]?.name).toContain("WinCo");
  });
});

describe("portable storage", () => {
  it("adds safe snack-budget defaults to existing saved state", () => {
    const legacy = createState("2026-08-17") as AppState;
    (legacy as { schemaVersion: number }).schemaVersion = 1;
    delete (legacy.prefs as Partial<AppState["prefs"]>).protectedSnackBudgetEnabled;
    delete (legacy.prefs as Partial<AppState["prefs"]>).protectedSnackCalories;
    expect(parseBackup(JSON.stringify(legacy)).prefs).toMatchObject({
      protectedSnackBudgetEnabled: false,
      protectedSnackCalories: 200,
    });
    expect(parseBackup(JSON.stringify(legacy)).schemaVersion).toBe(2);
  });
  it("round-trips an exported backup and preserves null nutrients", () => {
    const state = readyState();
    state.foods.push(normalizeFood({ name: "Soup", nutrition: { calories: 220, proteinG: 8, carbsG: 30, fatG: 7, sodiumMg: null } }));
    const restored = parseBackup(exportBackup(state));
    expect(restored.profile.goalWeightLb).toBe(155);
    expect(restored.foods[0]?.nutrition.sodiumMg).toBeNull();
  });

  it("rejects incompatible schema versions", () => {
    expect(() => parseBackup('{"schemaVersion":99}')).toThrow(/schema version/i);
  });
});

describe("calendar history", () => {
  it("builds a stable six-week month grid with adjacent dates", () => {
    const days = calendarGrid("2026-08");
    expect(days).toHaveLength(42);
    expect(days[0]).toMatchObject({ date: "2026-07-26", inMonth: false });
    expect(days.find((day) => day.date === "2026-08-17")).toMatchObject({ day: 17, inMonth: true });
  });

  it("moves across year boundaries and formats the selected month", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(formatMonth("2026-08")).toMatch(/August 2026/);
  });
});

describe("AI bridge", () => {
  it("builds a self-contained clipboard packet without making a network call", () => {
    const prompt = buildAiPrompt(readyState(), "Log oatmeal for breakfast");
    expect(prompt).toContain("CURRENT CONTEXT");
    expect(prompt).toContain("Log oatmeal for breakfast");
    expect(prompt).toContain("Return ONLY valid JSON");
    expect(prompt).toContain("best-effort estimate");
    expect(prompt).toContain("core macros should not be left null");
  });

  it("builds a food-only prompt with partial recipe context", () => {
    const prompt = buildFoodAiPrompt(readyState(), { name: "Taco bowls", recipe: { ingredients: [{ name: "rice" }] } });
    expect(prompt).toContain("PARTIAL FOOD");
    expect(prompt).toContain("Taco bowls");
    expect(prompt).toContain("one food");
    expect(prompt).toContain("ONE serving");
    expect(prompt).toContain("best-effort estimate");
    expect(prompt).toContain("do not leave core macros blank");
  });

  it("fills a draft from upsertFood while preserving omitted user values", () => {
    const current = { name: "Taco bowls", brand: "Home", nutrition: { calories: 0, sodiumMg: 400 }, recipe: { ingredients: [{ name: "rice" }] } };
    const merged = importFoodDraft(current, JSON.stringify({
      schemaVersion: 1,
      operations: [{ type: "upsertFood", food: { nutrition: { calories: 520, proteinG: 26 }, recipe: { ingredients: [{ name: "rice" }, { name: "beans" }], instructions: "Combine." } } }],
    }));
    expect(merged.name).toBe("Taco bowls");
    expect(merged.brand).toBe("Home");
    expect(merged.nutrition).toMatchObject({ calories: 520, proteinG: 26, sodiumMg: 400 });
    expect(merged.recipe?.ingredients).toHaveLength(2);
  });

  it("gives useful food-import errors", () => {
    expect(() => importFoodDraft({}, "not json")).toThrow(/not valid JSON/i);
    expect(() => importFoodDraft({}, '{"schemaVersion":2,"operations":[]}')).toThrow(/not supported/i);
    expect(() => importFoodDraft({}, '{"schemaVersion":1,"operations":[]}')).toThrow(/upsertFood/i);
  });

  it("validates and applies food, entry, weight, and goal operations", () => {
    const response = parseAiResponse(JSON.stringify({
      schemaVersion: 1,
      summary: "Breakfast and check-in",
      operations: [
        { type: "addEntry", entry: { period: "morning", servings: 1, food: { name: "Oatmeal", nutrition: { calories: 180, proteinG: 6, carbsG: 32, fatG: 3 } } } },
        { type: "addWeight", date: "2026-08-17", weightLb: 178.5 },
        { type: "setGoal", goalType: "lose", goalWeightLb: 150, rateLbWeek: 0.5 },
      ],
    }));
    const result = applyAiResponse(readyState(), response);
    expect(result.applied).toBe(3);
    expect(result.state.foods[0]?.name).toBe("Oatmeal");
    expect(result.state.entries[0]?.period).toBe("breakfast");
    expect(result.state.profile.weightLb).toBe(178.5);
    expect(result.state.profile.goalWeightLb).toBe(150);
  });
});

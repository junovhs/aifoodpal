import { describe, expect, it } from "vitest";
import { applyAiResponse, buildAiPrompt, buildFoodAiPrompt, importFoodDraft, parseAiResponse } from "../src/ai";
import { createEntry, createQuickCalorieEntry, createState, normalizeFood, removeFoodFromLibrary } from "../src/model";
import { calorieGuidance, nutritionTargets, totalsFor } from "../src/nutrition";
import { exportBackup, parseBackup } from "../src/storage";
import { calendarGrid, formatMonth, shiftMonth } from "../src/calendar";

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

describe("portable storage", () => {
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
  });

  it("builds a food-only prompt with partial recipe context", () => {
    const prompt = buildFoodAiPrompt(readyState(), { name: "Taco bowls", recipe: { ingredients: [{ name: "rice" }] } });
    expect(prompt).toContain("PARTIAL FOOD");
    expect(prompt).toContain("Taco bowls");
    expect(prompt).toContain("one food");
    expect(prompt).toContain("ONE serving");
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

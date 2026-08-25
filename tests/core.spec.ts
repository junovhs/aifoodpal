import { describe, expect, it } from "vitest";
import { applyAiResponse, buildAiPrompt, buildFoodAiPrompt, importFoodDraft, parseAiResponse } from "../src/ai";
import { createEntry, createQuickCalorieEntry, createState, moveDiaryEntry, normalizeFood, protectedSnackBudget, removeFoodFromLibrary, type AppState } from "../src/model";
import { calorieGuidance, calorieTrend, exerciseCalories, goalDateFromPace, goalProgressPercent, maintenanceCalories, nutritionTargets, paceFromDailyGuide, planProfile, startWeight, totalsFor, weightProjection } from "../src/nutrition";
import { exportBackup, migrateState, parseBackup } from "../src/storage";
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
  it("counts only movement toward a weight goal as progress", () => {
    expect(goalProgressPercent(190, 196, 160)).toBe(0);
    expect(goalProgressPercent(190, 180, 160)).toBeCloseTo(33.33, 1);
    expect(goalProgressPercent(150, 145, 170)).toBe(0);
    expect(goalProgressPercent(150, 160, 170)).toBe(50);
    expect(goalProgressPercent(190, 155, 160)).toBe(100);
  });

  it("measures progress from the recorded starting weight, not the oldest surviving check-in", () => {
    const state = readyState();
    state.profile.startWeightLb = 210;
    state.profile.goalWeightLb = 160;
    state.weights.push(
      { id: "w1", date: "2026-08-10", weightLb: 202, createdAt: "", updatedAt: "" },
      { id: "w2", date: "2026-08-23", weightLb: 196, createdAt: "", updatedAt: "" },
    );
    const before = goalProgressPercent(startWeight(state)!, 196, 160);
    expect(before).toBeCloseTo(28, 0);

    // Deleting the oldest check-in must not rewrite how far the user has come.
    state.weights = state.weights.filter((weight) => weight.id !== "w1");
    expect(goalProgressPercent(startWeight(state)!, 196, 160)).toBeCloseTo(before, 5);
  });

  it("gives a single check-in real progress instead of pinning it at zero", () => {
    const state = readyState();
    state.profile.startWeightLb = 210;
    state.weights.push({ id: "w1", date: "2026-08-23", weightLb: 196, createdAt: "", updatedAt: "" });
    expect(goalProgressPercent(startWeight(state)!, 196, 160)).toBeGreaterThan(0);
  });

  it("answers every calorie calculation from the newest check-in rather than the onboarding weight", () => {
    const state = readyState();
    state.profile.weightLb = 240;
    state.weights.push({ id: "w1", date: "2026-08-23", weightLb: 180, createdAt: "", updatedAt: "" });
    expect(planProfile(state).weightLb).toBe(180);
    expect(calorieGuidance(planProfile(state)).target).toBe(calorieGuidance({ ...state.profile, weightLb: 180 }).target);
    expect(weightProjection(state, "2026-08-23")).toBe(weightProjection(state, "2026-08-23"));
  });

  it("treats pace and the daily guide as two views of one intent", () => {
    const profile = readyState().profile;
    const maintenance = maintenanceCalories(profile)!;

    // Each direction is the exact inverse of the other, so a round trip loses nothing.
    expect(paceFromDailyGuide(profile, maintenance - 750)).toBeCloseTo(1.5, 6);
    expect(calorieGuidance({ ...profile, rateLbWeek: 1.5 }).target).toBeCloseTo(maintenance - 750, 6);
    expect(calorieGuidance({ ...profile, rateLbWeek: paceFromDailyGuide(profile, 1600)! }).target).toBeCloseTo(1600, 6);

    // Gaining spends the same 500 kcal/day per lb/week in the other direction.
    expect(paceFromDailyGuide({ ...profile, goalType: "gain" }, maintenance + 500)).toBeCloseTo(1, 6);
    expect(paceFromDailyGuide({ ...profile, goalType: "maintain" }, 1600)).toBe(0);

    // Without a body baseline there is nothing to invert.
    expect(paceFromDailyGuide({ ...profile, sexForEquation: null }, 1600)).toBeNull();
  });

  it("loads a saved manual guide as one pace instead of a second plan number", () => {
    const saved = readyState();
    saved.profile.manualDailyGuide = 1600;
    saved.profile.rateLbWeek = 1.5;
    const expected = paceFromDailyGuide(planProfile(saved), 1600)!;

    const migrated = migrateState(saved);
    expect(migrated.profile.manualDailyGuide).toBeNull();
    expect(migrated.profile.rateLbWeek).toBeCloseTo(expected, 6);
    // The guide the user saved is exactly what the single intent still produces.
    expect(calorieGuidance(planProfile(migrated)).target).toBeCloseTo(1600, 6);

    // With no baseline to invert, the typed guide is kept rather than discarded.
    const bare = createState("2026-08-17");
    bare.profile.manualDailyGuide = 1800;
    expect(migrateState(bare).profile.manualDailyGuide).toBe(1800);
  });

  it("holds the calorie floor and reports that the pace is limited by it", () => {
    const profile = { ...readyState().profile, rateLbWeek: 5 };
    const guidance = calorieGuidance(profile);
    expect(guidance.target).toBe(1000);
    expect(guidance.floorLimited).toBe(true);
  });

  it("seeds a missing starting weight once, preferring the earliest check-in", () => {
    const seeded = migrateState({ ...createState("2026-08-17"), weights: [
      { id: "w1", date: "2026-08-01", weightLb: 205, createdAt: "", updatedAt: "" },
      { id: "w2", date: "2026-08-20", weightLb: 198, createdAt: "", updatedAt: "" },
    ] });
    expect(seeded.profile.startWeightLb).toBe(205);

    const state = createState("2026-08-17");
    state.profile.weightLb = 190;
    expect(migrateState(state).profile.startWeightLb).toBe(190);

    const recorded = createState("2026-08-17");
    recorded.profile.startWeightLb = 220;
    recorded.profile.weightLb = 190;
    expect(migrateState(recorded).profile.startWeightLb).toBe(220);
  });

  it("turns a saved weekly pace into a deterministic goal date", () => {
    expect(goalDateFromPace(196, 160, 1, "2026-08-25")).toBe("2027-05-04");
    expect(goalDateFromPace(196, 160, 0, "2026-08-25")).toBeNull();
  });

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

  it("calculates active-day averages and an exercise-aware weight projection", () => {
    const state = readyState();
    for (let day = 16; day <= 22; day += 1) state.entries.push(createQuickCalorieEntry(1700, `2026-08-${day}`, "dinner"));
    state.entries.push(createQuickCalorieEntry(1700, "2026-08-23", "breakfast"));
    state.exercises.push({ id: "exercise-1", date: "2026-08-22", kind: "strength", minutes: 20, createdAt: "2026-08-22T12:00:00Z", updatedAt: "2026-08-22T12:00:00Z" });

    const trend = calorieTrend(state, "2026-08-23");
    const projection = weightProjection(state, "2026-08-23");

    expect(trend.week).toMatchObject({ average: 1700, activeDays: 7, calories: 11900 });
    expect(trend.month.average).toBe(1700);
    expect(exerciseCalories("strength", 20, 180)).toBeGreaterThan(50);
    expect(projection).toMatchObject({ averageIntake: 1700, activeDays: 7, spanDays: 7 });
    expect(projection?.averageExercise).toBeGreaterThan(5);
    expect(projection?.weeklyChangeLb).toBeGreaterThan(0);
    expect(projection?.oneMonthWeightLb).toBeLessThan(180);
    expect(projection?.goalDate).not.toBeNull();

    state.entries.push(createQuickCalorieEntry(600, "2026-08-23", "dinner"));
    state.exercises.push({ id: "exercise-today", date: "2026-08-23", kind: "walkBrisk", minutes: 60, createdAt: "2026-08-23T12:00:00Z", updatedAt: "2026-08-23T12:00:00Z" });
    expect(weightProjection(state, "2026-08-23")).toEqual(projection);
  });

  it("requires seven consecutive completed food-log days for a projection", () => {
    const state = readyState();
    for (let day = 17; day <= 22; day += 1) state.entries.push(createQuickCalorieEntry(1700, `2026-08-${day}`, "dinner"));
    state.entries.push(createQuickCalorieEntry(1700, "2026-08-23", "breakfast"));
    expect(weightProjection(state, "2026-08-23")).toBeNull();

    state.entries.push(createQuickCalorieEntry(1700, "2026-08-16", "dinner"));
    expect(weightProjection(state, "2026-08-23")).toMatchObject({ activeDays: 7, spanDays: 7, averageIntake: 1700 });
  });

  it("withholds a precise goal date when the projected rate is too small to be stable", () => {
    const state = readyState();
    for (let day = 16; day <= 22; day += 1) state.entries.push(createQuickCalorieEntry(2400, `2026-08-${day}`, "dinner"));
    const projection = weightProjection(state, "2026-08-23");
    expect(projection).not.toBeNull();
    expect(Math.abs(projection!.weeklyChangeLb)).toBeLessThan(.25);
    expect(projection?.goalDate).toBeNull();
  });

  it("excludes unlogged days from active-day calorie averages", () => {
    const state = readyState();
    state.entries.push(createQuickCalorieEntry(1200, "2026-08-20", "dinner"), createQuickCalorieEntry(1800, "2026-08-23", "dinner"));
    expect(calorieTrend(state, "2026-08-23").week).toMatchObject({ average: 1500, activeDays: 2 });
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
    expect(parseBackup(JSON.stringify(legacy)).schemaVersion).toBe(3);
    expect(parseBackup(JSON.stringify(legacy)).exercises).toEqual([]);
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
    const state = readyState();
    state.foods.push(normalizeFood({ name: "Private saved breakfast", nutrition: { calories: 400 } }));
    const prompt = buildFoodAiPrompt({ name: "Taco bowls", recipe: { ingredients: [{ name: "rice" }] } });
    expect(prompt).toContain("PARTIAL FOOD");
    expect(prompt).toContain("Taco bowls");
    expect(prompt).toContain("one food");
    expect(prompt).toContain("ONE serving");
    expect(prompt).toContain("best-effort estimate");
    expect(prompt).toContain("do not leave core macros blank");
    expect(prompt).not.toContain("CURRENT APP CONTEXT");
    expect(prompt).not.toContain("Private saved breakfast");
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
    expect(() => importFoodDraft({}, "not json")).toThrow(/No usable JSON/i);
    expect(() => importFoodDraft({}, '{"schemaVersion":2,"operations":[]}')).toThrow(/not supported/i);
    expect(() => importFoodDraft({}, '{"schemaVersion":1,"operations":[]}')).toThrow(/upsertFood/i);
  });

  it("accepts JSON copied with code fences or explanatory text", () => {
    const reply = '{"schemaVersion":1,"summary":"Done","operations":[{"type":"upsertFood","food":{"name":"Toast","nutrition":{"calories":120}}}]}';
    expect(parseAiResponse(`\uFEFF\n\`\`\`json\n${reply}\n\`\`\``).summary).toBe("Done");
    expect(parseAiResponse(`Here is the result:\n${reply}\nYou can paste it into the app.`).operations).toHaveLength(1);
  });

  it("repairs common mobile AI copy formatting", () => {
    const trailing = 'Here you go: {“schemaVersion”:1,“operations”:[{“type”:“upsertFood”,“food”:{“name”:“Toast”,“nutrition”:{“calories”:120,},},}],}';
    expect(importFoodDraft({}, trailing)).toMatchObject({ name: "Toast", nutrition: { calories: 120 } });
    const encoded = JSON.stringify('{"schemaVersion":1,"operations":[{"type":"upsertFood","food":{"name":"Soup","nutrition":{"calories":90}}}]}');
    expect(importFoodDraft({}, encoded).name).toBe("Soup");
  });

  it("accepts a direct food object when an AI omits the response envelope", () => {
    expect(importFoodDraft({}, '{"name":"Apple","serving":{"amount":1,"unit":"piece"},"nutrition":{"calories":95}}')).toMatchObject({
      name: "Apple",
      serving: { amount: 1, unit: "piece" },
      nutrition: { calories: 95 },
    });
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

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { DaybookApp, type FoodCaptureDeps } from "../src/app";
import { CaptureError } from "../src/capture-client";
import { createEntry, createQuickCalorieEntry, createState, isoDate, normalizeFood, type AppState } from "../src/model";
import { calorieGuidance, formatDate, goalDateFromPace, maintenanceCalories, paceFromDailyGuide, planProfile, shiftDate, weightProjection } from "../src/nutrition";
import { migrateState, type StateRepository } from "../src/storage";

const openSettings = (root: HTMLElement): void => {
  root.querySelector<HTMLElement>('[data-action="view"][data-view="settings"]')!.click();
};

describe("weight sourcing", () => {
  it("shows real goal progress from the recorded start and quotes one weight everywhere", () => {
    const today = isoDate();
    const state = createState(today);
    Object.assign(state.profile, {
      onboardingComplete: true, age: 35, sexForEquation: "female", heightIn: 66,
      // A stale onboarding weight that disagrees with the newest check-in.
      weightLb: 240, startWeightLb: 210, goalWeightLb: 160, activityPAL: 1.2, rateLbWeek: 1,
    });
    state.weights.push({ id: "w1", date: shiftDate(today, -2), weightLb: 196, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();

    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();
    const ring = root.querySelector(".goal-ring")?.textContent ?? "";
    expect(ring).not.toContain("0%");
    expect(ring).toContain("28%");
    expect(root.querySelector(".goal-band")?.textContent).toContain("36");

    // The Settings guide must be computed from the check-in weight, not the stale 240.
    openSettings(root);
    const shown = root.querySelector<HTMLInputElement>('input[name="dailyGuide"]')!.value;
    const fromCheckIn = calorieGuidance({ ...state.profile, weightLb: 196 }).target!;
    const fromOnboarding = calorieGuidance({ ...state.profile, weightLb: 240 }).target!;
    expect(Math.round(fromCheckIn)).not.toBe(Math.round(fromOnboarding));
    expect(shown).toBe(String(Math.round(fromCheckIn)));
  });

  it("keeps goal progress steady when the oldest check-in is deleted", () => {
    const today = isoDate();
    const state = createState(today);
    Object.assign(state.profile, {
      onboardingComplete: true, age: 35, sexForEquation: "female", heightIn: 66,
      weightLb: 196, startWeightLb: 210, goalWeightLb: 160, activityPAL: 1.2, rateLbWeek: 1,
    });
    const stamp = new Date().toISOString();
    state.weights.push(
      { id: "w1", date: shiftDate(today, -20), weightLb: 202, createdAt: stamp, updatedAt: stamp },
      { id: "w2", date: shiftDate(today, -2), weightLb: 196, createdAt: stamp, updatedAt: stamp },
    );
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();
    const before = root.querySelector(".goal-ring")?.textContent;

    root.querySelector<HTMLElement>('[data-action="request-delete-weight"][data-id="w1"]')!.click();
    root.querySelector<HTMLElement>('[data-action="confirm-delete-weight"]')!.click();
    expect(root.querySelector(".goal-ring")?.textContent).toBe(before);
  });
});

const planState = (over: Partial<AppState["profile"]> = {}) => {
  const today = isoDate();
  const state = createState(today);
  Object.assign(state.profile, {
    onboardingComplete: true, age: 35, sexForEquation: "female", heightIn: 66,
    weightLb: 196, startWeightLb: 210, goalWeightLb: 160, activityPAL: 1.6,
    goalType: "lose", rateLbWeek: 1.5, ...over,
  });
  state.weights.push({ id: "w1", date: shiftDate(today, -2), weightLb: 196, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  // A complete week of logs, so the Progress forecast KPIs render.
  for (let offset = -7; offset <= -1; offset += 1) state.entries.push(createQuickCalorieEntry(1845, shiftDate(today, offset), "dinner"));
  return state;
};

const savePlan = (root: HTMLElement, values: Record<string, string>): void => {
  const form = root.querySelector<HTMLFormElement>('form[data-form="settings"]')!;
  for (const [name, value] of Object.entries(values)) form.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value = value;
  form.requestSubmit();
};

describe("one plan intent", () => {
  it("turns a typed calorie guide into the pace it implies and moves the plan date", () => {
    const state = planState();
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();
    const dateBefore = root.querySelector(".forecast-kpi.date b")?.textContent;

    openSettings(root);
    savePlan(root, { dailyGuide: "1600" });

    const implied = paceFromDailyGuide(planProfile(state), 1600)!;
    expect(implied).not.toBeCloseTo(1.5, 2);
    expect(state.profile.rateLbWeek).toBeCloseTo(implied, 6);
    // The guide is never kept as a second number that could contradict the pace.
    expect(state.profile.manualDailyGuide).toBeNull();
    // Reopening shows exactly what was typed, so the round trip loses nothing.
    openSettings(root);
    expect(root.querySelector<HTMLInputElement>('input[name="dailyGuide"]')!.value).toBe("1600");

    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();
    const dateAfter = root.querySelector(".forecast-kpi.date b")?.textContent;
    expect(dateAfter).not.toBe(dateBefore);
    expect(dateAfter).toBe(formatDate(goalDateFromPace(196, 160, state.profile.rateLbWeek)!));
  });

  it("turns a typed pace into the calorie guide it requires", () => {
    const state = planState({ rateLbWeek: 1 });
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    openSettings(root);
    const guideBefore = Number(root.querySelector<HTMLInputElement>('input[name="dailyGuide"]')!.value);

    savePlan(root, { rateLbWeek: "1.5" });

    expect(state.profile.rateLbWeek).toBe(1.5);
    expect(state.profile.manualDailyGuide).toBeNull();
    openSettings(root);
    const guideAfter = Number(root.querySelector<HTMLInputElement>('input[name="dailyGuide"]')!.value);
    // A faster pace must cost calories, by exactly the 500 kcal/day per lb/week it is defined as.
    expect(guideAfter).toBe(Math.round(maintenanceCalories(planProfile(state))! - 1.5 * 500));
    expect(guideBefore - guideAfter).toBe(250);
  });

  it("holds the calorie floor instead of promising a pace that would breach it", () => {
    const state = planState({ heightIn: 60, weightLb: 120, goalWeightLb: 100, activityPAL: 1.2, rateLbWeek: 1 });
    state.weights = [];
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    openSettings(root);

    savePlan(root, { rateLbWeek: "5" });

    openSettings(root);
    expect(root.querySelector<HTMLInputElement>('input[name="dailyGuide"]')!.value).toBe("1000");
    expect(calorieGuidance(planProfile(state)).floorLimited).toBe(true);
  });

  it("keeps the chosen pace when only the activity level changes, and moves the calories", () => {
    const state = planState({ activityPAL: 1.2 });
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    openSettings(root);
    const guideBefore = Number(root.querySelector<HTMLInputElement>('input[name="dailyGuide"]')!.value);

    savePlan(root, { activityPAL: "1.6" });

    // The pace is the stored intent, so a busier normal day buys calories rather than speed.
    expect(state.profile.rateLbWeek).toBe(1.5);
    openSettings(root);
    expect(Number(root.querySelector<HTMLInputElement>('input[name="dailyGuide"]')!.value)).toBeGreaterThan(guideBefore);
  });

  it("keeps a typed guide usable when there is no body baseline to derive a pace from", () => {
    const state = createState(isoDate());
    Object.assign(state.profile, { onboardingComplete: true });
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    openSettings(root);

    savePlan(root, { dailyGuide: "1800" });

    expect(state.profile.manualDailyGuide).toBe(1800);
    openSettings(root);
    expect(root.querySelector<HTMLInputElement>('input[name="dailyGuide"]')!.value).toBe("1800");
  });
});

describe("calorie trends and exercise", () => {
  it("shows recent averages and saves an exercise that contributes to the forecast", () => {
    const today = isoDate();
    const state = createState(today);
    Object.assign(state.profile, { onboardingComplete: true, age: 35, sexForEquation: "female", heightIn: 66, weightLb: 180, goalWeightLb: 160, activityPAL: 1.2 });
    for (let offset = -7; offset <= -1; offset += 1) state.entries.push(createQuickCalorieEntry(1700, shiftDate(today, offset), "dinner"));
    const save = vi.fn<(state: AppState) => void>();
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save }).start();

    root.querySelector<HTMLElement>('[data-action="view"][data-view="calendar"]')!.click();
    expect(root.querySelector(".history-summary")?.textContent).toContain("avg kcal / active day");
    expect(root.querySelector(".history-summary")?.textContent).toContain("7-day avg");
    expect(root.querySelector(".history-summary")?.textContent).toContain("30-day avg");

    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();
    expect(root.querySelector(".forecast")?.textContent).toContain("Your saved plan points");
    expect(root.querySelector(".forecast")?.textContent).toContain("short-term estimate from seven completed days");
    expect(root.querySelectorAll(".forecast-kpi")).toHaveLength(4);
    expect(root.querySelector(".trend-chart svg")).not.toBeNull();
    expect(root.querySelector(".trend-chart .panel-title")?.textContent).toContain("Recent 90-day estimate");
    expect(root.querySelector(".chart-month")?.textContent).toContain("1 month");
    expect(root.querySelector(".chart-goal")).toBeNull();
    expect(root.querySelector(".goal-band")?.textContent).toContain("to go");
    expect(root.querySelectorAll(".progress-panel")).toHaveLength(2);
    root.querySelector<HTMLElement>('[data-action="open-exercise"]')!.click();
    const form = root.querySelector<HTMLFormElement>('form[data-form="exercise"]')!;
    form.querySelector<HTMLSelectElement>('select[name="kind"]')!.value = "strength";
    form.querySelector<HTMLInputElement>('input[name="minutes"]')!.value = "20";
    form.requestSubmit();

    expect(state.exercises).toHaveLength(1);
    expect(state.exercises[0]).toMatchObject({ kind: "strength", minutes: 20, date: today });
    expect(save).toHaveBeenCalled();
    expect(root.querySelector(".exercise-row")?.textContent).toContain("Dumbbells / strength");
  });

  it("keeps the saved plan timeline separate from an unstable recent pace", () => {
    const today = isoDate();
    const state = createState(today);
    Object.assign(state.profile, { onboardingComplete: true, age: 35, sexForEquation: "female", heightIn: 66, weightLb: 180, goalWeightLb: 160, activityPAL: 1.6 });
    for (let offset = -7; offset <= -1; offset += 1) state.entries.push(createQuickCalorieEntry(2400, shiftDate(today, offset), "dinner"));
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    expect(root.querySelector(".forecast-copy h2")?.textContent).toContain("Your saved plan points");
    expect(root.querySelector(".forecast-copy")?.textContent).toContain("short-term estimate");
    expect(root.querySelector(".forecast-kpi.date b")?.textContent).not.toBe("—");
  });

  it("does not count weight gain as progress or extend the recent estimate to the goal", () => {
    const today = isoDate();
    const state = createState(today);
    Object.assign(state.profile, { onboardingComplete: true, age: 35, sexForEquation: "female", heightIn: 66, weightLb: 196, goalWeightLb: 160, activityPAL: 1.4, goalType: "lose", rateLbWeek: 1 });
    for (let offset = -7; offset <= -1; offset += 1) state.entries.push(createQuickCalorieEntry(1845, shiftDate(today, offset), "dinner"));
    state.weights.push(
      { id: "weight-start", date: shiftDate(today, -8), weightLb: 190, createdAt: `${shiftDate(today, -8)}T12:00:00Z`, updatedAt: `${shiftDate(today, -8)}T12:00:00Z` },
      { id: "weight-current", date: shiftDate(today, -2), weightLb: 196, createdAt: `${shiftDate(today, -2)}T12:00:00Z`, updatedAt: `${shiftDate(today, -2)}T12:00:00Z` },
    );
    const planDate = goalDateFromPace(196, 160, 1, today)!;
    const recentGoalDate = weightProjection(state, today)?.goalDate;
    expect(recentGoalDate).toBeTruthy();
    expect(recentGoalDate).not.toBe(planDate);
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    expect(root.querySelector(".goal-ring b")?.textContent).toBe("0%");
    expect(root.querySelector(".forecast-copy h2")?.textContent).toContain(formatDate(planDate));
    expect(root.querySelector(".forecast-copy h2")?.textContent).not.toContain(formatDate(recentGoalDate!));
    expect(root.querySelector(".forecast-kpi.date b")?.textContent).toBe(formatDate(planDate));
    expect(root.querySelector(".trend-chart")?.outerHTML).toContain("over 90 days");
    expect(root.querySelector(".chart-goal")).toBeNull();
  });

  it("deletes the selected weight after confirmation and promotes the next-newest check-in", () => {
    const today = "2026-08-25";
    const state = createState(today);
    Object.assign(state.profile, { onboardingComplete: true, age: 35, sexForEquation: "female", heightIn: 66, weightLb: 196, goalWeightLb: 160, goalType: "lose", rateLbWeek: 1 });
    state.weights.push(
      { id: "weight-older", date: "2026-08-17", weightLb: 190, createdAt: "2026-08-17T12:00:00Z", updatedAt: "2026-08-17T12:00:00Z" },
      { id: "weight-latest", date: "2026-08-23", weightLb: 196, createdAt: "2026-08-23T12:00:00Z", updatedAt: "2026-08-23T12:00:00Z" },
    );
    let persisted = structuredClone(state);
    const repository: StateRepository = {
      load: () => structuredClone(persisted),
      save: (next) => { persisted = structuredClone(next); },
    };
    const root = document.createElement("main");
    new DaybookApp(root, repository).start();
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    root.querySelector<HTMLElement>('[data-action="request-delete-weight"][data-id="weight-latest"]')!.click();
    expect(root.querySelector(".delete-confirm")?.textContent).toContain("196 lb");
    expect(root.querySelector(".delete-confirm")?.textContent).toContain("Aug 23, 2026");
    root.querySelector<HTMLElement>('[data-action="confirm-delete-weight"]')!.click();

    expect(persisted.weights.map((weight) => weight.id)).toEqual(["weight-older"]);
    expect(persisted.profile.weightLb).toBe(190);
    expect(root.querySelector('[data-weight-id="weight-latest"]')).toBeNull();
    expect(root.querySelector(".goal-weight.current")?.textContent).toContain("190 lb");
    expect(root.querySelector(".goal-remaining")?.textContent).toContain("30 lb to go");

    const reloadedRoot = document.createElement("main");
    new DaybookApp(reloadedRoot, repository).start();
    reloadedRoot.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();
    expect(reloadedRoot.querySelector('[data-weight-id="weight-latest"]')).toBeNull();
    expect(reloadedRoot.querySelector('[data-weight-id="weight-older"]')).not.toBeNull();
  });

  it("keeps a weight entry when deletion is canceled", () => {
    const state = createState("2026-08-25");
    Object.assign(state.profile, { onboardingComplete: true, weightLb: 196, goalWeightLb: 160 });
    state.weights.push({ id: "weight-latest", date: "2026-08-23", weightLb: 196, createdAt: "2026-08-23T12:00:00Z", updatedAt: "2026-08-23T12:00:00Z" });
    const save = vi.fn<(state: AppState) => void>();
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save }).start();
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    root.querySelector<HTMLElement>('[data-action="request-delete-weight"]')!.click();
    root.querySelector<HTMLElement>('.mfooter [data-action="close"]')!.click();

    expect(state.weights).toHaveLength(1);
    expect(save).not.toHaveBeenCalled();
    expect(root.querySelector('[data-weight-id="weight-latest"]')).not.toBeNull();
    expect(root.querySelector(".modalback")).toBeNull();
  });

  it("exposes deletion for weight entries beyond the five most recent", () => {
    const state = createState("2026-08-25");
    Object.assign(state.profile, { onboardingComplete: true, weightLb: 196, goalWeightLb: 160 });
    for (let day = 17; day <= 23; day += 1) state.weights.push({ id: `weight-${day}`, date: `2026-08-${day}`, weightLb: 190 + day - 17, createdAt: `2026-08-${day}T12:00:00Z`, updatedAt: `2026-08-${day}T12:00:00Z` });
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    expect(root.querySelectorAll('[data-action="request-delete-weight"]')).toHaveLength(7);
    expect(root.querySelector('[data-action="request-delete-weight"][data-id="weight-17"]')).not.toBeNull();
  });

  it("does not retain a deleted sole check-in as an invisible profile fallback", () => {
    const state = createState("2026-08-25");
    Object.assign(state.profile, { onboardingComplete: true, weightLb: 196, goalWeightLb: 160 });
    state.weights.push({ id: "only-weight", date: "2026-08-23", weightLb: 196, createdAt: "2026-08-23T12:00:00Z", updatedAt: "2026-08-23T12:00:00Z" });
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    root.querySelector<HTMLElement>('[data-action="request-delete-weight"]')!.click();
    root.querySelector<HTMLElement>('[data-action="confirm-delete-weight"]')!.click();

    expect(state.weights).toHaveLength(0);
    expect(state.profile.weightLb).toBeNull();
    expect(root.querySelector(".progress-panel")?.textContent).toContain("No check-ins yet");
  });

  it("loads a saved manual calorie guide as the pace it implies, with one figure on Progress", () => {
    const today = isoDate();
    const saved = createState(today);
    Object.assign(saved.profile, { onboardingComplete: true, age: 35, sexForEquation: "female", heightIn: 66, weightLb: 196, goalWeightLb: 160, goalType: "lose", rateLbWeek: 1, manualDailyGuide: 2100 });
    for (let offset = -7; offset <= -1; offset += 1) saved.entries.push(createQuickCalorieEntry(1845, shiftDate(today, offset), "dinner"));
    const state = migrateState(saved);

    // The guide the user actually saved survives; it is now expressed as one pace.
    expect(state.profile.manualDailyGuide).toBeNull();
    expect(state.profile.rateLbWeek).toBeCloseTo(paceFromDailyGuide(planProfile(saved), 2100)!, 6);

    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();
    expect(root.querySelector(".forecast-kpi.exercise b")?.textContent).toBe("2,100");
  });

  it("rebases the plan date on the latest weight check-in", () => {
    const today = isoDate();
    const state = createState(today);
    Object.assign(state.profile, { onboardingComplete: true, age: 35, sexForEquation: "female", heightIn: 66, weightLb: 180, goalWeightLb: 160, goalType: "lose", rateLbWeek: 1 });
    for (let offset = -7; offset <= -1; offset += 1) state.entries.push(createQuickCalorieEntry(1800, shiftDate(today, offset), "dinner"));
    state.weights.push({ id: "latest", date: shiftDate(today, -1), weightLb: 170, createdAt: `${shiftDate(today, -1)}T12:00:00Z`, updatedAt: `${shiftDate(today, -1)}T12:00:00Z` });
    const baselineDate = goalDateFromPace(180, 160, 1, today);
    const rebasedDate = goalDateFromPace(170, 160, 1, today)!;
    expect(rebasedDate).not.toBe(baselineDate);
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    const baselineTarget = calorieGuidance(state.profile).target;
    const rebasedTarget = calorieGuidance({ ...state.profile, weightLb: 170 }).target;
    expect(rebasedTarget).not.toBe(baselineTarget);
    expect(root.querySelector(".forecast-kpi.date b")?.textContent).toBe(formatDate(rebasedDate));
    expect(root.querySelector(".forecast-kpi.exercise b")?.textContent).toBe(new Intl.NumberFormat().format(Math.round(rebasedTarget!)));
  });

  it("keeps the plan date tied to the saved pace when calorie guidance hits its floor", () => {
    const today = isoDate();
    const state = createState(today);
    Object.assign(state.profile, { onboardingComplete: true, age: 35, sexForEquation: "female", heightIn: 60, weightLb: 120, goalWeightLb: 100, activityPAL: 1.2, goalType: "lose", rateLbWeek: 2 });
    for (let offset = -7; offset <= -1; offset += 1) state.entries.push(createQuickCalorieEntry(1400, shiftDate(today, offset), "dinner"));
    const guidance = calorieGuidance(state.profile);
    const paceDate = goalDateFromPace(120, 100, 2, today)!;
    expect(guidance.floorLimited).toBe(true);
    expect(guidance.targetDate).not.toBe(paceDate);
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    expect(root.querySelector(".forecast-kpi.date b")?.textContent).toBe(formatDate(paceDate));
  });

  it("treats a loss threshold already above the current weight as reached", () => {
    const today = isoDate();
    const state = createState(today);
    Object.assign(state.profile, { onboardingComplete: true, age: 35, sexForEquation: "female", heightIn: 66, weightLb: 180, goalWeightLb: 200, goalType: "lose", rateLbWeek: 1 });
    for (let offset = -7; offset <= -1; offset += 1) state.entries.push(createQuickCalorieEntry(1800, shiftDate(today, offset), "dinner"));
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    expect(root.querySelector(".forecast-copy h2")?.textContent).toContain("reached your saved goal");
    expect(root.querySelector(".goal-ring b")?.textContent).toBe("100%");
    expect(root.querySelector(".forecast-kpi.date b")?.textContent).toBe("—");
  });

  it("shows a reached loss goal as complete instead of mismatched", () => {
    const today = isoDate();
    const state = createState(today);
    Object.assign(state.profile, { onboardingComplete: true, age: 35, sexForEquation: "female", heightIn: 66, weightLb: 160, goalWeightLb: 160, goalType: "lose", rateLbWeek: 1 });
    for (let offset = -7; offset <= -1; offset += 1) state.entries.push(createQuickCalorieEntry(1800, shiftDate(today, offset), "dinner"));
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    expect(root.querySelector(".forecast-copy h2")?.textContent).toContain("reached your saved goal");
    expect(root.querySelector(".goal-ring b")?.textContent).toBe("100%");
    expect(root.querySelector(".forecast-kpi.date b")?.textContent).toBe("—");
  });

  it("shows a surpassed loss goal as complete with nothing left to go", () => {
    const today = isoDate();
    const state = createState(today);
    Object.assign(state.profile, { onboardingComplete: true, age: 35, sexForEquation: "female", heightIn: 66, weightLb: 155, goalWeightLb: 160, goalType: "lose", rateLbWeek: 1 });
    for (let offset = -7; offset <= -1; offset += 1) state.entries.push(createQuickCalorieEntry(1800, shiftDate(today, offset), "dinner"));
    state.weights.push(
      { id: "start", date: shiftDate(today, -30), weightLb: 190, createdAt: `${shiftDate(today, -30)}T12:00:00Z`, updatedAt: `${shiftDate(today, -30)}T12:00:00Z` },
      { id: "current", date: shiftDate(today, -1), weightLb: 155, createdAt: `${shiftDate(today, -1)}T12:00:00Z`, updatedAt: `${shiftDate(today, -1)}T12:00:00Z` },
    );
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    expect(root.querySelector(".forecast-copy h2")?.textContent).toContain("reached your saved goal");
    expect(root.querySelector(".goal-ring b")?.textContent).toBe("100%");
    expect(root.querySelector(".goal-remaining b")?.textContent).toContain("0 lb to go");
    expect(root.querySelector(".forecast-kpi.date b")?.textContent).toBe("—");
  });

  it("shows maintenance without inventing a goal date", () => {
    const today = isoDate();
    const state = createState(today);
    Object.assign(state.profile, { onboardingComplete: true, age: 35, sexForEquation: "female", heightIn: 66, weightLb: 165, goalWeightLb: 160, goalType: "maintain", rateLbWeek: 1 });
    for (let offset = -7; offset <= -1; offset += 1) state.entries.push(createQuickCalorieEntry(1800, shiftDate(today, offset), "dinner"));
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    expect(root.querySelector(".forecast-copy h2")?.textContent).toContain("set to maintain");
    expect(root.querySelector(".forecast-kpi.date b")?.textContent).toBe("—");
  });

  it("preserves the automatic-guidance safety reason on the plan card", () => {
    const today = isoDate();
    const state = createState(today);
    Object.assign(state.profile, { onboardingComplete: true, age: 17, sexForEquation: "female", heightIn: 66, weightLb: 180, goalWeightLb: 160, goalType: "lose", rateLbWeek: 1 });
    for (let offset = -7; offset <= -1; offset += 1) state.entries.push(createQuickCalorieEntry(1800, shiftDate(today, offset), "dinner"));
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    expect(root.querySelector(".forecast-copy h2")?.textContent).toContain("only provided for adults");
    expect(root.querySelector(".forecast-kpi.date b")?.textContent).toBe("—");
  });

  it("keeps a complete sparse-state dashboard before a projection is available", () => {
    const state = createState();
    Object.assign(state.profile, { onboardingComplete: true, age: 35, sexForEquation: "female", heightIn: 66, weightLb: 180, goalWeightLb: 160 });
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    expect(root.querySelector(".forecast-empty")?.textContent).toContain("Complete seven consecutive days");
    expect(root.querySelector(".trend-chart-empty")?.textContent).toContain("Your line will appear here");
    expect(root.querySelector(".goal-band")?.textContent).toContain("Current weight");
    expect(root.querySelectorAll(".progress-panel")).toHaveLength(2);
  });

  it("uses plain-language baseline activity choices in Settings", () => {
    const state = createState();
    Object.assign(state.profile, { onboardingComplete: true, activityPAL: 1.6 });
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    openSettings(root);

    const activity = root.querySelector<HTMLSelectElement>('select[name="activityPAL"]')!;
    expect(activity.selectedOptions[0]?.textContent).toContain("Moderately active");
    expect(activity.closest("label")?.textContent).toContain("before workouts");
    expect(activity.closest("label")?.textContent).toContain("not counted twice");
  });
});

describe("protected snack budget", () => {
  it("flags main-meal encroachment while keeping the control in Settings", () => {
    const state = createState("2026-08-20");
    Object.assign(state.profile, { onboardingComplete: true, manualDailyGuide: 2000 });
    Object.assign(state.prefs, { protectedSnackBudgetEnabled: true, protectedSnackCalories: 400 });
    const mainMeal = normalizeFood({ name: "Main meals", nutrition: { calories: 1700 } });
    const snack = normalizeFood({ name: "Snack", nutrition: { calories: 100 } });
    state.entries.push(createEntry(mainMeal, state.prefs.date, "dinner"), createEntry(snack, state.prefs.date, "snacks"));
    const save = vi.fn<(state: AppState) => void>();
    const repository: StateRepository = { load: () => state, save };
    const root = document.createElement("main");

    new DaybookApp(root, repository).start();

    expect(root.querySelector(".today-warning")?.textContent).toContain("100 protected snack kcal used by main meals");
    expect(root.querySelector(".today-remaining")?.textContent).toContain("200");
    expect(root.querySelector('form[data-form="snack-budget"]')).toBeNull();
    openSettings(root);
    expect(root.querySelector<HTMLInputElement>('form[data-form="snack-budget"] input[name="enabled"]')?.checked).toBe(true);
  });

  it("saves the opt-in preference from Settings", () => {
    const state = createState("2026-08-20");
    Object.assign(state.profile, { onboardingComplete: true, manualDailyGuide: 2000 });
    const save = vi.fn<(state: AppState) => void>();
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save }).start();
    openSettings(root);
    const form = root.querySelector<HTMLFormElement>('form[data-form="snack-budget"]')!;
    form.querySelector<HTMLInputElement>('input[name="enabled"]')!.checked = true;
    form.querySelector<HTMLInputElement>('input[name="calories"]')!.value = "350";

    form.requestSubmit();

    expect(state.prefs).toMatchObject({ protectedSnackBudgetEnabled: true, protectedSnackCalories: 350 });
    expect(save).toHaveBeenCalledOnce();
  });

  it("does not report a protected overrun while protection is off", () => {
    const state = createState("2026-08-20");
    Object.assign(state.profile, { onboardingComplete: true, manualDailyGuide: 2000 });
    const mainMeal = normalizeFood({ name: "Main meals", nutrition: { calories: 1700 } });
    state.entries.push(createEntry(mainMeal, state.prefs.date, "dinner"));
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();

    expect(root.querySelector(".today-warning")).toBeNull();
    expect(root.querySelector(".today-remaining")?.textContent).toContain("300");
  });

  it("rejects a snack reserve that would consume the whole daily guide", () => {
    const state = createState("2026-08-20");
    Object.assign(state.profile, { onboardingComplete: true, manualDailyGuide: 2000 });
    const save = vi.fn<(state: AppState) => void>();
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save }).start();
    openSettings(root);
    const form = root.querySelector<HTMLFormElement>('form[data-form="snack-budget"]')!;
    form.querySelector<HTMLInputElement>('input[name="enabled"]')!.checked = true;
    form.querySelector<HTMLInputElement>('input[name="calories"]')!.value = "2000";

    form.requestSubmit();

    expect(state.prefs.protectedSnackBudgetEnabled).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("clamps a saved reserve when the daily guide later becomes smaller", () => {
    const state = createState("2026-08-20");
    Object.assign(state.profile, { onboardingComplete: true, manualDailyGuide: 300 });
    Object.assign(state.prefs, { protectedSnackBudgetEnabled: true, protectedSnackCalories: 400 });
    const root = document.createElement("main");

    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    openSettings(root);

    expect(state.prefs.protectedSnackCalories).toBe(299);
    expect(root.querySelector<HTMLInputElement>('input[name="calories"]')?.value).toBe("299");
  });
});

describe("Today phone layout", () => {
  it("renders one compact dashboard with four meal links and no diary rows", () => {
    const state = createState("2026-08-21");
    Object.assign(state.profile, { onboardingComplete: true, manualDailyGuide: 2000 });
    const food = normalizeFood({
      name: "Everyday meal",
      nutrition: { calories: 180, proteinG: 12, carbsG: 20, fatG: 6, fiberG: 3 },
    });
    for (const period of ["breakfast", "lunch", "dinner", "snacks"] as const) {
      state.entries.push(createEntry(food, state.prefs.date, period));
    }
    const root = document.createElement("main");

    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();

    expect(root.querySelector(".view")?.classList.contains("today-view")).toBe(true);
    expect(root.querySelector(".today-remaining strong")?.textContent).toBe("1,280");
    expect(root.querySelector(".today-progress-label")?.textContent).toContain("720 of 2,000 kcal");
    expect(root.querySelectorAll(".today-hero .macro")).toHaveLength(4);
    const rows = [...root.querySelectorAll<HTMLElement>(".meal-row")];
    expect(rows.map((row) => row.dataset.period)).toEqual(["breakfast", "lunch", "dinner", "snacks"]);
    expect(rows.every((row) => row.dataset.action === "open-meal")).toBe(true);
    expect(rows.every((row) => row.textContent?.includes("180 kcal"))).toBe(true);
    expect(root.querySelector(".today-screen .entry")).toBeNull();
    expect(root.querySelector('.today-screen form[data-form="snack-budget"]')).toBeNull();
    expect(root.querySelector('.today-add[data-action="choose-food"]')?.textContent).toContain("Add food");

    rows[1]!.click();
    expect(root.querySelector(".meal-view h1")?.textContent).toBe("lunch");
    expect(root.querySelectorAll(".meal-view .entry")).toHaveLength(1);
    expect(root.querySelector(".meal-view")?.textContent).toContain("Everyday meal");
    expect(root.querySelector(".meal-view-add")?.textContent).toContain("Add to lunch");
    root.querySelector<HTMLElement>('[data-action="back-today"]')!.click();
    expect(root.querySelector(".today-screen")).not.toBeNull();
  });
});

describe("food photo capture", () => {
  const reply = {
    name: "Greek yogurt",
    brand: "Fage",
    serving: { amount: 170, unit: "g", description: "1 container (170 g)" },
    portion: { amount: 170, unit: "g" },
    nutrition: { calories: 100, proteinG: 18, carbsG: 6, fatG: 0, fiberG: 0, sugarG: 6, addedSugarG: 0, saturatedFatG: 0, transFatG: 0, sodiumMg: 65 },
    sourceType: "label",
    confidence: "high",
    notes: null,
    recipe: null,
  };

  const openEditor = (capture: FoodCaptureDeps) => {
    const state = createState("2026-08-20");
    Object.assign(state.profile, { onboardingComplete: true, manualDailyGuide: 2000 });
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }, undefined, capture).start();
    root.querySelector<HTMLElement>('[data-action="choose-food"]')!.click();
    return root;
  };

  const deps = (overrides: Partial<FoodCaptureDeps> = {}): FoodCaptureDeps & { send: ReturnType<typeof vi.fn>; scan: ReturnType<typeof vi.fn> } => ({
    prepare: vi.fn(async () => ({ base64: "UEhPVE8=", mimeType: "image/jpeg" as const, width: 768, height: 512, bytes: 5 })),
    send: vi.fn(async () => ({ food: reply, remaining: { today: 38, month: 498 } })),
    scan: vi.fn(async () => ({ found: false as const, reason: "no-barcode" as const })),
    ...overrides,
  } as FoodCaptureDeps & { send: ReturnType<typeof vi.fn>; scan: ReturnType<typeof vi.fn> });

  /** Choose a photo the way the file picker does, so the app's own change handler runs. */
  const choosePhoto = (root: HTMLElement, mode: "label" | "estimate"): void => {
    const input = root.querySelector<HTMLInputElement>(`[data-capture-input="${mode}"]`)!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["photo"], "photo.jpg", { type: "image/jpeg" })] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  it("sends a written description with no photo and fills the form from the reply", async () => {
    const capture = deps();
    const root = openEditor(capture);

    root.querySelector<HTMLTextAreaElement>("#ai-food-note")!.value = "1 BBQ pork bao and 2 veggie bao, about 800 calories";
    root.querySelector<HTMLElement>('[data-action="describe"]')!.click();

    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe("Greek yogurt"));
    expect(capture.send).toHaveBeenCalledWith({ mode: "describe", note: "1 BBQ pork bao and 2 veggie bao, about 800 calories" });
    expect(capture.prepare).not.toHaveBeenCalled();
    expect(capture.scan).not.toHaveBeenCalled();
    expect(root.querySelector(".ai-assist")?.textContent).toContain("Filled in from your description");
  });

  it("refuses an empty description without spending a capture", () => {
    const capture = deps();
    const root = openEditor(capture);

    root.querySelector<HTMLElement>('[data-action="describe"]')!.click();

    expect(capture.send).not.toHaveBeenCalled();
    expect(root.querySelector(".notice.warn")?.textContent).toContain("Describe what you ate first");
  });

  it("offers a camera path and no clipboard controls", () => {
    const root = openEditor(deps());

    expect(root.querySelector(".ai-assist")?.textContent).toContain("Add it without typing");
    expect(root.querySelector<HTMLElement>('[data-action="capture"][data-mode="label"]')?.textContent).toContain("Scan a package");
    expect(root.querySelector<HTMLElement>('[data-action="capture"][data-mode="estimate"]')?.textContent).toContain("Estimate this plate");
    expect(root.querySelector('[data-action="ask-food-ai"]')).toBeNull();
    expect(root.querySelector('[data-action="apply-food-clipboard"]')).toBeNull();
    expect(root.querySelector("#ai-food-manual")).toBeNull();
  });

  it("sends the photo and the note, then fills the form from the reply", async () => {
    const capture = deps();
    const root = openEditor(capture);
    root.querySelector<HTMLTextAreaElement>("#ai-food-note")!.value = "  it's lamb, not beef  ";

    root.querySelector<HTMLElement>('[data-action="capture"][data-mode="label"]')!.click();
    choosePhoto(root, "label");

    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>('form[data-form="food"] input[name="name"]')?.value).toBe("Greek yogurt"));
    expect(capture.send).toHaveBeenCalledWith({ mode: "label", imageBase64: "UEhPVE8=", mimeType: "image/jpeg", note: "it's lamb, not beef" });
    expect(root.querySelector<HTMLInputElement>('form[data-form="food"] input[name="calories"]')?.value).toBe("100");
    expect(root.querySelector<HTMLInputElement>('form[data-form="food"] input[name="proteinG"]')?.value).toBe("18");
    expect(root.querySelector<HTMLInputElement>('form[data-form="food"] input[name="servingAmount"]')?.value).toBe("170");
    expect(root.querySelector<HTMLInputElement>('form[data-form="food"] input[name="brand"]')?.value).toBe("Fage");
    expect(root.querySelector(".ai-assist")?.textContent).toContain("38 captures left today");
    expect(root.querySelector<HTMLTextAreaElement>("#ai-food-note")?.value).toBe("it's lamb, not beef");
  });

  it("routes the plate button to estimate mode", async () => {
    const capture = deps();
    const root = openEditor(capture);

    root.querySelector<HTMLElement>('[data-action="capture"][data-mode="estimate"]')!.click();
    choosePhoto(root, "estimate");

    await vi.waitFor(() => expect(capture.send).toHaveBeenCalled());
    expect(capture.send.mock.calls[0]![0]).toMatchObject({ mode: "estimate", note: null });
  });

  it("keeps hand-typed fields when the capture fails", async () => {
    const capture = deps({ send: vi.fn(async () => { throw new CaptureError("ai-unavailable", "The AI service did not respond."); }) as FoodCaptureDeps["send"] });
    const root = openEditor(capture);
    root.querySelector<HTMLInputElement>('form[data-form="food"] input[name="name"]')!.value = "Lamb stew";
    root.querySelector<HTMLInputElement>('form[data-form="food"] input[name="calories"]')!.value = "520";

    root.querySelector<HTMLElement>('[data-action="capture"][data-mode="estimate"]')!.click();
    choosePhoto(root, "estimate");

    await vi.waitFor(() => expect(root.querySelector(".notice.warn")?.textContent).toContain("The AI service did not respond."));
    expect(root.querySelector<HTMLInputElement>('form[data-form="food"] input[name="name"]')?.value).toBe("Lamb stew");
    expect(root.querySelector<HTMLInputElement>('form[data-form="food"] input[name="calories"]')?.value).toBe("520");
  });

  it("says the allowance is used up and points at the manual fields", async () => {
    const capture = deps({ send: vi.fn(async () => { throw new CaptureError("limit-reached", "Daily AI limit reached."); }) as FoodCaptureDeps["send"] });
    const root = openEditor(capture);

    root.querySelector<HTMLElement>('[data-action="capture"][data-mode="label"]')!.click();
    choosePhoto(root, "label");

    await vi.waitFor(() => expect(root.querySelector(".notice.warn")?.textContent).toContain("Daily AI limit reached."));
    expect(root.querySelector(".notice.warn")?.textContent).toContain("fill the food in by hand");
    expect(root.querySelector<HTMLInputElement>('form[data-form="food"] input[name="name"]')?.value).toBe("");
  });

  it("reports an unreadable photo without calling the server", async () => {
    const capture = deps({ prepare: vi.fn(async () => { throw new Error("That photo could not be read. Try taking it again."); }) as FoodCaptureDeps["prepare"] });
    const root = openEditor(capture);

    root.querySelector<HTMLElement>('[data-action="capture"][data-mode="label"]')!.click();
    choosePhoto(root, "label");

    await vi.waitFor(() => expect(root.querySelector(".notice.warn")?.textContent).toContain("could not be read"));
    expect(capture.send).not.toHaveBeenCalled();
  });

  it("disables both buttons while a capture is in flight", async () => {
    let release = (): void => {};
    const capture = deps({ send: vi.fn(() => new Promise((resolve) => { release = () => resolve({ food: reply, remaining: { today: 1, month: 1 } }); })) as FoodCaptureDeps["send"] });
    const root = openEditor(capture);

    root.querySelector<HTMLElement>('[data-action="capture"][data-mode="label"]')!.click();
    choosePhoto(root, "label");

    // Wait for the request to actually be in flight; the busy state renders before it.
    await vi.waitFor(() => expect(capture.send).toHaveBeenCalled());
    expect(root.querySelector(".ai-assist")?.textContent).toContain("Reading your label");
    expect([...root.querySelectorAll('[data-action="capture"]')].every((node) => node.hasAttribute("disabled"))).toBe(true);
    release();
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>('form[data-form="food"] input[name="name"]')?.value).toBe("Greek yogurt"));
  });
  it("fills the form from the free product database without spending a capture", async () => {
    const offFood = { name: "Chunky peanut butter", brand: "Skippy", serving: { amount: 32, unit: "g", description: "2 tbsp (32 g)" }, nutrition: { calories: 190, proteinG: 7 } };
    const capture = deps({ scan: vi.fn(async () => ({ found: true as const, food: offFood, code: "037600106245" })) as FoodCaptureDeps["scan"] });
    const root = openEditor(capture);

    root.querySelector<HTMLElement>('[data-action="capture"][data-mode="label"]')!.click();
    choosePhoto(root, "label");

    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>('form[data-form="food"] input[name="name"]')?.value).toBe("Chunky peanut butter"));
    expect(root.querySelector<HTMLInputElement>('form[data-form="food"] input[name="calories"]')?.value).toBe("190");
    expect(root.querySelector(".ai-assist")?.textContent).toContain("No AI capture used.");
    expect(capture.send).not.toHaveBeenCalled();
    expect(capture.prepare).not.toHaveBeenCalled();
  });

  it("falls through to the AI read when the photo holds no known barcode", async () => {
    const capture = deps();
    const root = openEditor(capture);

    root.querySelector<HTMLElement>('[data-action="capture"][data-mode="label"]')!.click();
    choosePhoto(root, "label");

    await vi.waitFor(() => expect(capture.send).toHaveBeenCalled());
    expect(capture.scan).toHaveBeenCalled();
    expect(capture.send.mock.calls[0]![0]).toMatchObject({ mode: "label" });
  });

  it("does not waste a barcode lookup on a plate of food", async () => {
    const capture = deps();
    const root = openEditor(capture);

    root.querySelector<HTMLElement>('[data-action="capture"][data-mode="estimate"]')!.click();
    choosePhoto(root, "estimate");

    await vi.waitFor(() => expect(capture.send).toHaveBeenCalled());
    expect(capture.scan).not.toHaveBeenCalled();
  });
});

describe("food library", () => {
  it("sorts consistently and filters by name, brand, or serving", () => {
    const state = createState("2026-08-20");
    state.profile.onboardingComplete = true;
    state.foods.push(
      normalizeFood({ id: "food-3", name: "zucchini bowl", brand: "Garden Co", serving: { amount: 2, unit: "cup" }, nutrition: { calories: 240 } }),
      normalizeFood({ id: "food-1", name: "Caramel Pumpkin Brûlée Latte", brand: "Dutch Bros", serving: { amount: 1, unit: "container" }, nutrition: { calories: 340 } }),
      normalizeFood({ id: "food-2", name: "Almond croissant", brand: "Private Selection", serving: { amount: 1, unit: "piece" }, nutrition: { calories: 400 } }),
    );
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    root.querySelector<HTMLElement>('[data-action="view"][data-view="library"]')!.click();

    const names = () => [...root.querySelectorAll<HTMLElement>("[data-library-card]:not([hidden]) .library-name")].map((node) => node.childNodes[0]?.textContent);
    expect(names()).toEqual(["Almond croissant", "Caramel Pumpkin Brûlée Latte", "zucchini bowl"]);
    expect(root.querySelector("[data-library-card]")?.textContent).toContain("Private Selection · 1 piece · 400 kcal");

    const search = root.querySelector<HTMLInputElement>("[data-library-search]")!;
    search.value = "brulee";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(names()).toEqual(["Caramel Pumpkin Brûlée Latte"]);
    expect(root.querySelector("[data-library-count]")?.textContent).toBe("1 of 3 foods");

    search.value = "cup";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(names()).toEqual(["zucchini bowl"]);

    search.value = "missing";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.querySelector<HTMLElement>("[data-library-empty]")?.hidden).toBe(false);

    root.querySelector<HTMLButtonElement>('[data-action="clear-library-search"]')!.click();
    expect(search.value).toBe("");
    expect(names()).toHaveLength(3);
  });
});

describe("Today layout by viewport", () => {
  const realMatchMedia = window.matchMedia;
  afterEach(() => { window.matchMedia = realMatchMedia; });

  /** Drives the one media query the app asks about, so each layout branch is testable under jsdom. */
  const stubViewport = (wide: boolean) => {
    const listeners = new Set<() => void>();
    const query = {
      matches: wide,
      addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
      removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
    };
    window.matchMedia = ((media: string) => media === "(min-width: 900px)" ? query : { matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as typeof window.matchMedia;
    return (next: boolean) => { query.matches = next; for (const listener of listeners) listener(); };
  };

  const dayState = () => {
    const state = createState("2026-08-20");
    Object.assign(state.profile, { onboardingComplete: true, manualDailyGuide: 2000 });
    const food = normalizeFood({ name: "Everyday meal", serving: { amount: 1, unit: "serving" }, nutrition: { calories: 180, proteinG: 12, carbsG: 20, fatG: 6, fiberG: 3 } });
    for (const period of ["breakfast", "lunch", "dinner", "snacks"] as const) state.entries.push(createEntry(food, state.prefs.date, period));
    return state;
  };

  it("renders the desktop diary with entries inline on a wide viewport", () => {
    stubViewport(true);
    const root = document.createElement("main");

    new DaybookApp(root, { load: () => dayState(), save: vi.fn() }).start();

    expect(root.querySelector(".today-screen")).toBeNull();
    expect(root.querySelector(".view")?.classList.contains("today-view")).toBe(false);
    expect(root.querySelector(".summary .guide .big")?.textContent).toBe("720");
    expect(root.querySelector(".summary-note")?.textContent).toContain("1,280");
    expect(root.querySelector(".calorie-scale")).not.toBeNull();
    expect(root.querySelectorAll(".summary .macro .macro-icon")).toHaveLength(4);
    const groups = [...root.querySelectorAll<HTMLElement>(".mealgroup")];
    expect(groups.map((group) => group.dataset.period)).toEqual(["breakfast", "lunch", "dinner", "snacks"]);
    expect(root.querySelectorAll(".mealgroup .entry")).toHaveLength(4);
    expect(root.querySelector('form[data-form="snack-budget"]')).toBeNull();
  });

  it("keeps the phone dashboard on a narrow viewport", () => {
    stubViewport(false);
    const root = document.createElement("main");

    new DaybookApp(root, { load: () => dayState(), save: vi.fn() }).start();

    expect(root.querySelector(".today-screen")).not.toBeNull();
    expect(root.querySelector(".view")?.classList.contains("today-view")).toBe(true);
    expect(root.querySelectorAll(".meal-row")).toHaveLength(4);
    expect(root.querySelector(".mealgroup")).toBeNull();
  });

  it("swaps layouts when the viewport crosses the breakpoint", () => {
    const setWide = stubViewport(false);
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => dayState(), save: vi.fn() }).start();

    setWide(true);
    expect(root.querySelector(".today-screen")).toBeNull();
    expect(root.querySelectorAll(".mealgroup")).toHaveLength(4);

    setWide(false);
    expect(root.querySelector(".today-screen")).not.toBeNull();
    expect(root.querySelector(".mealgroup")).toBeNull();
  });
});

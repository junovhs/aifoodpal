// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { DaybookApp, type FoodCaptureDeps } from "../src/app";
import { CaptureError } from "../src/capture-client";
import { createEntry, createQuickCalorieEntry, createState, isoDate, normalizeFood, type AppState } from "../src/model";
import { calorieGuidance, formatDate, goalDateFromPace, maintenanceCalories, paceFromDailyGuide, planProfile, round, shiftDate, weekBalance, weightProjection } from "../src/nutrition";
import { migrateState, type StateRepository } from "../src/storage";

const openSettings = (root: HTMLElement): void => {
  root.querySelector<HTMLElement>('[data-action="view"][data-view="settings"]')!.click();
};

/** The plan now has its own screen, reached from Settings. */
const openPlan = (root: HTMLElement): void => {
  openSettings(root);
  root.querySelector<HTMLElement>('[data-action="view"][data-view="plan"]')!.click();
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

    // The plan's guide must be computed from the check-in weight, not the stale 240.
    openPlan(root);
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
  const form = root.querySelector<HTMLFormElement>('form[data-form="plan"]')!;
  for (const [name, value] of Object.entries(values)) {
    const control = form.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
    control.value = value;
    // Typing is what tells the plan which half of the pair the user moved (DEC-04).
    control.dispatchEvent(new Event("input", { bubbles: true }));
  }
  form.requestSubmit();
};

describe("one plan intent", () => {
  it("turns a typed calorie guide into the pace it implies and moves the plan date", () => {
    const state = planState();
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();
    const dateBefore = root.querySelector(".forecast-kpi.date b")?.textContent;

    openPlan(root);
    savePlan(root, { dailyGuide: "1600" });

    const implied = paceFromDailyGuide(planProfile(state), 1600)!;
    expect(implied).not.toBeCloseTo(1.5, 2);
    expect(state.profile.rateLbWeek).toBeCloseTo(implied, 6);
    // The guide is never kept as a second number that could contradict the pace.
    expect(state.profile.manualDailyGuide).toBeNull();
    // Reopening shows exactly what was typed, so the round trip loses nothing.
    openPlan(root);
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
    openPlan(root);
    const guideBefore = Number(root.querySelector<HTMLInputElement>('input[name="dailyGuide"]')!.value);

    savePlan(root, { rateLbWeek: "1.5" });

    expect(state.profile.rateLbWeek).toBe(1.5);
    expect(state.profile.manualDailyGuide).toBeNull();
    openPlan(root);
    const guideAfter = Number(root.querySelector<HTMLInputElement>('input[name="dailyGuide"]')!.value);
    // A faster pace must cost calories, by exactly the 500 kcal/day per lb/week it is defined as.
    expect(guideAfter).toBe(Math.round(maintenanceCalories(planProfile(state))! - 1.5 * 500));
    expect(guideBefore - guideAfter).toBe(250);
  });

  it("caps the saved pace at the floor instead of promising a pace the guide cannot deliver", () => {
    const state = planState({ heightIn: 60, weightLb: 120, goalWeightLb: 100, activityPAL: 1.2, rateLbWeek: 1 });
    state.weights = [];
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    openPlan(root);

    savePlan(root, { rateLbWeek: "5" });

    // The pace that was stored is the capped one, not the 5 that was asked for.
    expect(state.profile.rateLbWeek).toBeLessThan(5);
    expect(calorieGuidance(planProfile(state)).floorLimited).toBe(true);

    openPlan(root);
    const guide = Number(root.querySelector<HTMLInputElement>('input[name="dailyGuide"]')!.value);
    const pace = Number(root.querySelector<HTMLInputElement>('input[name="rateLbWeek"]')!.value);
    expect(guide).toBeGreaterThanOrEqual(1200);
    expect(pace).toBe(round(state.profile.rateLbWeek, 2));
    // Reopening shows a pace and a guide that are still exact inverses of each other (DEC-04).
    expect(paceFromDailyGuide(planProfile(state), guide)).toBeCloseTo(state.profile.rateLbWeek, 2);
  });

  it("caps the real profile that used to save a pace its calorie guide could not deliver", () => {
    // 37, male, 5 foot 9, 196 lb, sedentary: a 1.5 lb/week pace used to save beside a 1,415
    // guide, which is under the 1,500 floor this profile now carries.
    const state = planState({
      age: 37, sexForEquation: "male", heightIn: 69, weightLb: 196,
      goalWeightLb: 170, activityPAL: 1.2, rateLbWeek: 1.5,
    });
    state.weights = [];
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    openPlan(root);

    savePlan(root, { rateLbWeek: "2" });

    openPlan(root);
    const guide = Number(root.querySelector<HTMLInputElement>('input[name="dailyGuide"]')!.value);
    const pace = Number(root.querySelector<HTMLInputElement>('input[name="rateLbWeek"]')!.value);
    expect(guide).toBeGreaterThanOrEqual(1500);
    expect(pace).toBeLessThan(2);
    expect(pace).toBe(round(state.profile.rateLbWeek, 2));
    expect(paceFromDailyGuide(planProfile(state), guide)).toBeCloseTo(state.profile.rateLbWeek, 2);
  });

  it("floors the same body at 1,200 when the equation sex is female", () => {
    const state = planState({
      age: 37, sexForEquation: "female", heightIn: 69, weightLb: 196,
      goalWeightLb: 170, activityPAL: 1.2, rateLbWeek: 1.5,
    });
    state.weights = [];
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    openPlan(root);

    savePlan(root, { rateLbWeek: "5" });

    openPlan(root);
    const guide = Number(root.querySelector<HTMLInputElement>('input[name="dailyGuide"]')!.value);
    expect(guide).toBeGreaterThanOrEqual(1200);
    expect(guide).toBeLessThan(1500);
  });

  it("keeps the chosen pace when only the activity level changes, and moves the calories", () => {
    const state = planState({ activityPAL: 1.2 });
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    openPlan(root);
    const guideBefore = Number(root.querySelector<HTMLInputElement>('input[name="dailyGuide"]')!.value);

    savePlan(root, { activityPAL: "1.6" });

    // The pace is the stored intent, so a busier normal day buys calories rather than speed.
    expect(state.profile.rateLbWeek).toBe(1.5);
    openPlan(root);
    expect(Number(root.querySelector<HTMLInputElement>('input[name="dailyGuide"]')!.value)).toBeGreaterThan(guideBefore);
  });

  it("keeps a typed guide usable when there is no body baseline to derive a pace from", () => {
    const state = createState(isoDate());
    Object.assign(state.profile, { onboardingComplete: true });
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    openPlan(root);

    savePlan(root, { dailyGuide: "1800" });

    expect(state.profile.manualDailyGuide).toBe(1800);
    openPlan(root);
    expect(root.querySelector<HTMLInputElement>('input[name="dailyGuide"]')!.value).toBe("1800");
  });
});

/** A plan with an explicit week of logged days, ready to read the steering sentence from. */
const steerState = (dailyCalories: number[], guide = 1600) => {
  const today = isoDate();
  const state = createState(today);
  Object.assign(state.profile, {
    onboardingComplete: true, age: 35, sexForEquation: "female", heightIn: 66,
    weightLb: 196, startWeightLb: 210, goalWeightLb: 160, activityPAL: 1.6, goalType: "lose",
  });
  state.weights.push({ id: "w1", date: shiftDate(today, -2), weightLb: 196, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  // Express the guide the way the plan now stores it: one pace (DEC-04).
  state.profile.rateLbWeek = paceFromDailyGuide(planProfile(state), guide)!;
  dailyCalories.forEach((calories, index) => state.entries.push(createQuickCalorieEntry(calories, shiftDate(today, index - 7), "dinner")));
  return state;
};

const mount = (state: AppState): HTMLElement => {
  const root = document.createElement("main");
  new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
  return root;
};

const steerText = (root: HTMLElement): string => root.querySelector(".steer")?.textContent ?? "";

describe("the plan screen", () => {
  const typeInto = (root: HTMLElement, name: string, value: string): void => {
    const control = root.querySelector<HTMLInputElement>(`form[data-form="plan"] [name="${name}"]`)!;
    control.value = value;
    control.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const resultText = (root: HTMLElement): string => root.querySelector("[data-plan-result]")?.textContent ?? "";
  const valueOf = (root: HTMLElement, name: string): string =>
    root.querySelector<HTMLInputElement>(`form[data-form="plan"] [name="${name}"]`)!.value;

  it("asks four plain questions and answers them in one sentence", () => {
    const root = mount(planState());
    openPlan(root);

    const text = root.querySelector(".plan-form")!.textContent ?? "";
    for (const question of [
      "What would you like to weigh?",
      "Which way are you going?",
      "How fast?",
      "How many calories a day?",
      "How old are you?",
      "How tall are you?",
    ]) expect(text).toContain(question);

    // The choices are said in words, not in the app's own vocabulary.
    expect(text).toContain("lose weight");
    expect(text).toContain("stay where I am");
    expect(resultText(root)).toMatch(/Eating about [\d,]+ calories a day, you would reach/);
  });

  it("moves the calorie guide and the finish date as the pace is typed, before saving", () => {
    const state = planState({ rateLbWeek: 1 });
    const root = mount(state);
    openPlan(root);
    const guideBefore = Number(valueOf(root, "dailyGuide"));
    const resultBefore = resultText(root);

    typeInto(root, "rateLbWeek", "1.5");

    expect(Number(valueOf(root, "dailyGuide"))).toBe(guideBefore - 250);
    expect(resultText(root)).not.toBe(resultBefore);
    // Nothing is committed until save is pressed.
    expect(state.profile.rateLbWeek).toBe(1);
  });

  it("moves the pace as the calorie guide is typed, before saving", () => {
    const state = planState({ rateLbWeek: 1 });
    const root = mount(state);
    openPlan(root);

    typeInto(root, "dailyGuide", "1600");

    const implied = paceFromDailyGuide(planProfile(state), 1600)!;
    expect(Number(valueOf(root, "rateLbWeek"))).toBeCloseTo(round(implied, 2), 2);
    expect(state.profile.rateLbWeek).toBe(1);
  });

  it("saves the plan and shows the new finish date on Progress", () => {
    const state = planState({ rateLbWeek: 1 });
    const save = vi.fn<(next: AppState) => void>();
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save }).start();
    openPlan(root);

    typeInto(root, "rateLbWeek", "1.5");
    root.querySelector<HTMLFormElement>('form[data-form="plan"]')!.requestSubmit();

    expect(state.profile.rateLbWeek).toBe(1.5);
    expect(save).toHaveBeenCalled();
    // Saving lands the user back on Progress, where the date it changed is shown.
    expect(root.querySelector(".forecast-kpi.date b")?.textContent)
      .toBe(formatDate(goalDateFromPace(196, 160, 1.5)!));
  });

  it("records the starting weight the user types rather than inferring one", () => {
    const state = planState();
    const root = mount(state);
    openPlan(root);

    typeInto(root, "startWeight", "205");
    root.querySelector<HTMLFormElement>('form[data-form="plan"]')!.requestSubmit();

    expect(state.profile.startWeightLb).toBe(205);
    expect(root.querySelector(".goal-ring")?.textContent).toContain("20%");
  });

  it("leaves no plan number or estimate behind in Settings", () => {
    const root = mount(planState());
    openSettings(root);

    const text = root.textContent ?? "";
    expect(root.querySelector('form[data-form="settings"]')).toBeNull();
    expect(root.querySelector('[name="dailyGuide"]')).toBeNull();
    expect(root.querySelector('[name="rateLbWeek"]')).toBeNull();
    expect(root.querySelector('[name="goalWeight"]')).toBeNull();
    expect(text).not.toContain("Automatic estimate");
    // Settings points at the plan instead of holding it.
    expect(root.querySelector('[data-action="view"][data-view="plan"]')).not.toBeNull();
  });

  it("says what is missing instead of showing numbers it cannot work out", () => {
    const state = createState(isoDate());
    Object.assign(state.profile, { onboardingComplete: true });
    const root = mount(state);
    openPlan(root);

    expect(resultText(root)).toContain("Fill in the answers below");
  });

  it("renders inside the one contained scroll pane, like every other view (DEC-02)", () => {
    const root = mount(planState());
    openPlan(root);

    // The shell contract: exactly one scroll pane, and this screen lives inside it.
    const panes = root.querySelectorAll("[data-scroll-pane]");
    expect(panes).toHaveLength(1);
    expect(root.querySelectorAll(".plan-form")).toHaveLength(1);
    expect(panes[0]!.contains(root.querySelector(".plan-form"))).toBe(true);
    expect(root.querySelector(".top")).not.toBeNull();
    expect(root.querySelector(".bottom")).not.toBeNull();
  });
});

describe("steering the week", () => {
  it("turns a heavy week into compact automatic recovery choices", () => {
    const root = mount(steerState([1232, 1768, 1677, 1738, 1784, 2442, 1720]));
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    const text = steerText(root);
    expect(text).toContain("1,161");
    expect(text).toContain("to rebalance");
    expect(text).toContain("1,434");
    expect(text).toContain("1,517");
    expect(text).toContain("recommended");
    // Nothing here may read as failing a day.
    expect(text.toLowerCase()).not.toMatch(/streak|failed|failure|missed|blew|ruined|over budget/);

    expect(text.length).toBeLessThan(220);
    // The visual leads the screen; the plan card and chart support it (DEC-07).
    expect(root.querySelector(".progress-page > section")?.className).toContain("steer");
  });

  it("shows a compact balance route and a gentle longer option for a large overage", () => {
    const state = steerState([2300, 2300, 2300, 2300, 2300, 2300, 2300]);
    const balance = weekBalance(state)!;
    const root = mount(state);
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    const text = steerText(root);
    expect(text).toContain("4,900");
    expect(text).toContain(`${balance.goalDateDriftDays} days`);
    expect(text).toContain(formatDate(balance.adjustedGoalDate!));
    expect(text).toContain("49 days");
    expect(text.toLowerCase()).not.toMatch(/streak|failed|failure/);
  });

  it("says the plan is on track when the week lands on it", () => {
    const today = isoDate();
    const state = steerState([]);
    const guide = Math.round(calorieGuidance(planProfile(state)).target!);
    for (let offset = -7; offset <= -1; offset += 1) state.entries.push(createQuickCalorieEntry(guide, shiftDate(today, offset), "dinner"));
    const root = mount(state);
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    expect(steerText(root)).toContain("landed on your plan");
    expect(steerText(root)).toContain("Keep going");
  });

  it("calls a light week calories saved rather than credit to spend", () => {
    const root = mount(steerState([1300, 1300, 1300, 1300, 1300, 1300, 1300]));
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    const text = steerText(root);
    expect(text).toContain("2,100");
    expect(text).toContain("under your plan");
    expect(text).toContain("Nothing to fix");
  });

  it("keeps a partial week's recovery visual compact", () => {
    const today = isoDate();
    const state = steerState([]);
    for (const offset of [-7, -4, -1]) state.entries.push(createQuickCalorieEntry(1900, shiftDate(today, offset), "dinner"));
    const root = mount(state);
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    expect(steerText(root)).toContain("900");
    expect(steerText(root)).toContain("to rebalance");
  });

  it("shows the same sentence on Today, above the numbers", () => {
    const root = mount(steerState([1232, 1768, 1677, 1738, 1784, 2442, 1720]));
    const text = steerText(root);
    expect(text).toContain("1,161");
    expect(text).toContain("1,434");

    // The sentence comes before the calorie hero on the day screen.
    const steer = root.querySelector(".steer")!;
    const hero = root.querySelector(".today-hero, .summary")!;
    expect(steer.compareDocumentPosition(hero) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws seven days against the plan line, with unlogged days left hollow", () => {
    const today = isoDate();
    const state = steerState([]);
    for (const offset of [-7, -6, -1]) state.entries.push(createQuickCalorieEntry(1500, shiftDate(today, offset), "dinner"));
    const root = mount(state);
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    expect(root.querySelectorAll(".steer-day")).toHaveLength(7);
    expect(root.querySelectorAll(".steer-bar")).toHaveLength(3);
    expect(root.querySelectorAll(".steer-bar-empty")).toHaveLength(4);
    expect(root.querySelector(".steer-week")?.textContent).toContain("dashed line is your plan");
    // Every day carries its own plan line, so no day is marked as failed.
    expect(root.querySelectorAll(".steer-guide")).toHaveLength(7);
  });

  it("does not offer food cuts or fasting when the saved plan is already at the floor", () => {
    const state = steerState([1800, 1800, 1800, 1800, 1800, 1800, 1800], 1500);
    state.profile.sexForEquation = "male";
    state.profile.activityPAL = 1.2;
    state.profile.rateLbWeek = paceFromDailyGuide(planProfile(state), 1500)!;
    const root = mount(state);

    const text = steerText(root);
    expect(text).toContain("2,100");
    expect(text).toContain("1,500/day");
    expect(text).toContain("+3 days");
    expect(text).toContain("Already at this app's 1,500-calorie minimum");
    expect(root.querySelector(".recovery-option")).toBeNull();
    expect(text.toLowerCase()).not.toContain("fast");

    root.querySelector<HTMLElement>('[data-action="open-exercise"]')!.click();
    const exercise = root.querySelector<HTMLFormElement>('form[data-form="exercise"]')!;
    expect(exercise).not.toBeNull();
    exercise.querySelector<HTMLSelectElement>('[name="kind"]')!.value = "walkBrisk";
    exercise.querySelector<HTMLInputElement>('[name="minutes"]')!.value = "30";
    exercise.requestSubmit();
    expect(steerText(root)).not.toContain("2,100 over");
  });

  it("activates a recovery option, changes Today's real cap, and can cancel it", () => {
    const state = steerState([1232, 1768, 1677, 1738, 1784, 2442, 1720]);
    const root = mount(state);
    const option = root.querySelector<HTMLElement>(".recovery-option.recommended")!;
    const target = option.querySelector("b")!.textContent!.split("/")[0]!;
    option.click();

    expect(state.prefs.recoveryPlan).toMatchObject({ dailyReduction: expect.any(Number), balanceCalories: expect.any(Number) });
    expect(root.querySelector(".recovery-heading")?.textContent).toContain("Recovery plan");
    expect(root.querySelector(".today-progress-label")?.textContent).toContain(`of ${target} kcal`);

    root.querySelector<HTMLElement>('[data-action="cancel-recovery"]')!.click();
    expect(state.prefs.recoveryPlan).toBeNull();
    expect(root.querySelector(".today-progress-label")?.textContent).toContain("of 1,600 kcal");
  });

  it("keeps energy jargon out of what the user reads", () => {
    const root = mount(steerState([1232, 1768, 1677, 1738, 1784, 2442, 1720]));
    for (const view of ["day", "trend", "settings", "calendar"]) {
      const tab = root.querySelector<HTMLElement>(`[data-action="view"][data-view="${view}"]`);
      tab?.click();
      const visible = root.textContent ?? "";
      expect(visible).not.toMatch(/maintenance|deficit|\bPAL\b|[Pp]rojection/);
    }
  });
});

describe("the weight chart", () => {
  const yAt = (points: string, index: number): number => Number(points.trim().split(/\s+/)[index]!.split(",")[1]);

  it("draws the plan, the weigh-ins, and where this week points as three labelled lines", () => {
    const today = isoDate();
    // Eating well above the guide, so the trend must fall short of the plan.
    const state = steerState([2100, 2100, 2100, 2100, 2100, 2100, 2100]);
    state.weights.push({ id: "w0", date: shiftDate(today, -30), weightLb: 202, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const root = mount(state);
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    const plan = root.querySelector<SVGPolylineElement>(".chart-line-plan")!;
    const real = root.querySelector<SVGPolylineElement>(".chart-line-real")!;
    const trend = root.querySelector<SVGPolylineElement>(".chart-line-trend")!;
    expect(plan).not.toBeNull();
    expect(real).not.toBeNull();
    expect(trend).not.toBeNull();

    const legend = root.querySelector(".chart-legend")!.textContent ?? "";
    for (const label of ["What you weighed", "Your plan", "Where this week points"]) expect(legend).toContain(label);

    // Every weigh-in is a point on the line that actually happened.
    expect(root.querySelectorAll(".chart-dots circle")).toHaveLength(2);

    // Falling behind means the orange line reaches the same goal farther to the right.
    const planPoints = plan.getAttribute("points")!;
    const trendPoints = trend.getAttribute("points")!;
    expect(Number(trendPoints.trim().split(/\s+/)[1]!.split(",")[0]))
      .toBeGreaterThan(Number(planPoints.trim().split(/\s+/)[1]!.split(",")[0]));
    expect(yAt(trendPoints, 1)).toBe(yAt(planPoints, 1));
    expect(root.querySelector(".chart-note")?.textContent).toContain("what this week changed");
  });

  it("runs the time axis from the first check-in through the later finish date", () => {
    const today = isoDate();
    const state = steerState([1800, 1800, 1800, 1800, 1800, 1800, 1800]);
    state.profile.sexForEquation = "male";
    state.profile.rateLbWeek = paceFromDailyGuide(planProfile(state), 1500)!;
    const firstDate = shiftDate(today, -30);
    state.weights.push({ id: "w0", date: firstDate, weightLb: 202, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const projection = weightProjection(state)!;
    const planGoalDate = goalDateFromPace(196, 160, state.profile.rateLbWeek, today)!;
    expect(projection.goalDate!.localeCompare(planGoalDate)).toBeGreaterThan(0);

    const root = mount(state);
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();
    const labels = [...root.querySelectorAll(".date-label")].map((label) => label.textContent);
    expect(labels[0]).toBe(formatDate(firstDate));
    expect(labels.at(-1)).toBe(formatDate(projection.goalDate!));

    const planPoints = root.querySelector(".chart-line-plan")!.getAttribute("points")!.trim().split(/\s+/);
    const trendPoints = root.querySelector(".chart-line-trend")!.getAttribute("points")!.trim().split(/\s+/);
    expect(Number(trendPoints.at(-1)!.split(",")[0])).toBe(935);
    expect(Number(planPoints.at(-1)!.split(",")[0])).toBeLessThan(935);
    expect(root.querySelector(".chart-stage svg")?.getAttribute("aria-label")).toContain(formatDate(projection.goalDate!));
  });

  it("says what to do instead of showing an empty frame when nothing is weighed", () => {
    const state = steerState([1600, 1600, 1600, 1600, 1600, 1600, 1600]);
    state.weights = [];
    const root = mount(state);
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    expect(root.querySelector(".chart-line-real")).toBeNull();
    expect(root.querySelector(".trend-chart-empty")?.textContent).toContain("Your lines will appear here");
    expect(root.querySelector(".trend-chart-empty")?.textContent).toContain("Check in your weight");
  });

  it("leaves the trend line out, in words, until a full week is logged", () => {
    const today = isoDate();
    const state = steerState([]);
    for (const offset of [-5, -4, -2]) state.entries.push(createQuickCalorieEntry(1700, shiftDate(today, offset), "dinner"));
    const root = mount(state);
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    expect(root.querySelector(".chart-line-trend")).toBeNull();
    expect(root.querySelector(".chart-line-real")).not.toBeNull();
    expect(root.querySelector(".chart-legend")?.textContent).not.toContain("Where this week points");
    expect(root.querySelector(".chart-note")?.textContent).toContain("Log seven days in a row");
  });

  it("leaves the plan line out, in words, until there is a goal and a pace", () => {
    const state = steerState([1600, 1600, 1600, 1600, 1600, 1600, 1600]);
    state.profile.goalWeightLb = null;
    const root = mount(state);
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    expect(root.querySelector(".chart-line-plan")).toBeNull();
    expect(root.querySelector(".chart-line-trend")).not.toBeNull();
    expect(root.querySelector(".chart-note")?.textContent).toContain("Add a goal weight");
  });

  it("keeps the plan line inside the chart when the goal is years away", () => {
    const state = steerState([1600, 1600, 1600, 1600, 1600, 1600, 1600]);
    state.profile.goalWeightLb = 120;
    const root = mount(state);
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    const points = root.querySelector(".chart-line-plan")!.getAttribute("points")!.trim().split(/\s+/);
    // Both ends stay within the drawing area rather than running off past the horizon.
    for (const point of points) {
      const [px, py] = point.split(",").map(Number);
      expect(px!).toBeGreaterThanOrEqual(55);
      expect(px!).toBeLessThanOrEqual(935);
      expect(py!).toBeGreaterThanOrEqual(0);
      expect(py!).toBeLessThanOrEqual(205);
    }
  });

  it("does not draw a check-in dated ahead of today as something that happened", () => {
    const today = isoDate();
    const state = steerState([1600, 1600, 1600, 1600, 1600, 1600, 1600]);
    state.weights.push({ id: "future", date: shiftDate(today, 5), weightLb: 150, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const root = mount(state);
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    expect(root.querySelectorAll(".chart-dots circle")).toHaveLength(1);
    expect(root.querySelector(".chart-line-real")).not.toBeNull();
  });

  it("keeps the steering sentence ahead of the chart on Progress", () => {
    const root = mount(steerState([2100, 2100, 2100, 2100, 2100, 2100, 2100]));
    root.querySelector<HTMLElement>('[data-action="view"][data-view="trend"]')!.click();

    const steer = root.querySelector(".steer")!;
    const chart = root.querySelector(".trend-chart")!;
    expect(steer.compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("calorie trends and exercise", () => {
  it("shows recent averages and saves an exercise that contributes to the forecast", () => {
    const today = isoDate();
    const state = createState(today);
    Object.assign(state.profile, { onboardingComplete: true, age: 35, sexForEquation: "female", heightIn: 66, weightLb: 180, goalWeightLb: 160, activityPAL: 1.2 });
    // The chart plots weigh-ins that actually happened, so the fixture records one (DEC-05).
    state.weights.push({ id: "w1", date: shiftDate(today, -3), weightLb: 180, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
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
    expect(root.querySelector(".trend-chart .panel-title")?.textContent).toContain("Your weight over time");
    expect(root.querySelector(".chart-legend")?.textContent).toContain("Where this week points");
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

  it("does not count weight gain as progress while showing the recent estimate's full timeline", () => {
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
    expect(root.querySelector(".chart-stage svg")?.getAttribute("aria-label")).toContain(formatDate(recentGoalDate!));
    expect([...root.querySelectorAll(".date-label")].at(-1)?.textContent).toBe(formatDate(recentGoalDate!));
    // The chart's recent line reaches its own finish while the saved-plan headline stays separate.
    expect(root.querySelector(".chart-legend")?.textContent).toContain("Where this week points");
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
    expect(root.querySelector(".trend-chart-empty")?.textContent).toContain("Your lines will appear here");
    expect(root.querySelector(".goal-band")?.textContent).toContain("Current weight");
    expect(root.querySelectorAll(".progress-panel")).toHaveLength(2);
  });

  it("uses plain-language baseline activity choices on the plan screen", () => {
    const state = createState();
    Object.assign(state.profile, { onboardingComplete: true, activityPAL: 1.6 });
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();
    openPlan(root);

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

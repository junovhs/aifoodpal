// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { DaybookApp } from "../src/app";
import { createEntry, createState, normalizeFood, type AppState } from "../src/model";
import type { StateRepository } from "../src/storage";

describe("protected snack budget", () => {
  it("renders meaningful meal sections and flags main-meal encroachment", () => {
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

    expect([...root.querySelectorAll(".scale-labels .scale-segment strong")].map((node) => node.textContent)).toEqual(["breakfast", "lunch", "dinner", "snacks"]);
    expect(root.querySelector(".scale-labels .snacks")?.textContent).toContain("400 kcal");
    expect(root.querySelector<HTMLElement>(".scale-overrun")?.style.cssText).toContain("left: 80%");
    expect(root.querySelector(".summary-note")?.textContent).toContain("100 protected snack kcal used by main meals");
    expect(root.querySelector(".summary-note")?.textContent).toContain("200 kcal remaining today");
    expect(root.querySelector<HTMLInputElement>('form[data-form="snack-budget"] input[name="enabled"]')?.checked).toBe(true);
  });

  it("saves the opt-in preference from the Snacks section", () => {
    const state = createState("2026-08-20");
    Object.assign(state.profile, { onboardingComplete: true, manualDailyGuide: 2000 });
    const save = vi.fn<(state: AppState) => void>();
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save }).start();
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

    expect(root.querySelector(".scale-overrun")).toBeNull();
    expect(root.querySelector(".summary-note")?.textContent).toContain("300 kcal remaining today");
  });

  it("rejects a snack reserve that would consume the whole daily guide", () => {
    const state = createState("2026-08-20");
    Object.assign(state.profile, { onboardingComplete: true, manualDailyGuide: 2000 });
    const save = vi.fn<(state: AppState) => void>();
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save }).start();
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

    expect(state.prefs.protectedSnackCalories).toBe(299);
    expect(root.querySelector<HTMLInputElement>('input[name="calories"]')?.value).toBe("299");
  });
});

describe("food AI clipboard flow", () => {
  it("keeps a visible native-paste path and reveals the prompt when automatic copy is blocked", async () => {
    const state = createState("2026-08-20");
    Object.assign(state.profile, { onboardingComplete: true, manualDailyGuide: 2000 });
    state.foods.push(normalizeFood({ name: "Private saved breakfast", nutrition: { calories: 400 } }));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) } });
    const root = document.createElement("main");
    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();

    root.querySelector<HTMLElement>('[data-action="choose-food"]')!.click();
    root.querySelector<HTMLElement>('[data-action="new-food"]')!.click();
    expect(root.querySelector(".ai-paste")?.textContent).toContain("Paste AI reply");
    expect(root.querySelector("details.ai-fallback")).toBeNull();
    root.querySelector<HTMLElement>('[data-action="ask-food-ai"]')!.click();

    await vi.waitFor(() => expect(root.querySelector<HTMLTextAreaElement>(".ai-copy-fallback textarea")?.value).toContain("PARTIAL FOOD"));
    expect(root.querySelector<HTMLTextAreaElement>(".ai-copy-fallback textarea")?.value).not.toContain("Private saved breakfast");
    expect(root.querySelector(".ai-assist")?.textContent).toContain("Press and hold");
  });
});

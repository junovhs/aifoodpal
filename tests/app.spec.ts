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

    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

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
});

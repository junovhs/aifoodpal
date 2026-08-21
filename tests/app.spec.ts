// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { DaybookApp, type FoodCaptureDeps } from "../src/app";
import { CaptureError } from "../src/capture-client";
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

describe("food photo capture", () => {
  const reply = {
    name: "Greek yogurt",
    brand: "Fage",
    serving: { amount: 170, unit: "g", description: "1 container (170 g)" },
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

  it("offers a camera path and no clipboard controls", () => {
    const root = openEditor(deps());

    expect(root.querySelector(".ai-assist")?.textContent).toContain("Add it from a photo");
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

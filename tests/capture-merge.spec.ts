// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { captureToFoodDraft } from "../src/capture-client";
import { normalizeFood, servingsForPortion, type FoodInput } from "../src/model";

const labelPayload = {
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

describe("captureToFoodDraft", () => {
  it("merges onto the open draft and preserves its id", () => {
    const current: FoodInput = { id: "food_1", name: "yogurt", nutrition: { calories: 1 } };

    const merged = captureToFoodDraft(current, labelPayload);

    expect(merged.id).toBe("food_1");
    expect(merged.name).toBe("Greek yogurt");
    expect(merged.nutrition?.calories).toBe(100);
    expect(merged.portion).toEqual({ amount: 170, unit: "g" });
  });

  it("does not invent an id for a food that has none", () => {
    expect(captureToFoodDraft({ name: "yogurt" }, labelPayload).id).toBeUndefined();
  });

  it("lets a null from the model leave a hand-entered value alone", () => {
    const current: FoodInput = { name: "Lamb stew", brand: "Homemade", nutrition: { calories: 0, sodiumMg: 480, sugarG: 4 }, notes: "family recipe" };
    const estimate = {
      ...labelPayload,
      name: "Lamb stew",
      brand: null,
      notes: null,
      nutrition: { calories: 520, proteinG: 34, carbsG: 18, fatG: 32, fiberG: 3, sugarG: null, addedSugarG: null, saturatedFatG: 14, transFatG: null, sodiumMg: null },
    };

    const merged = captureToFoodDraft(current, estimate);

    expect(merged.nutrition).toMatchObject({ calories: 520, proteinG: 34, sodiumMg: 480, sugarG: 4 });
    expect(merged.brand).toBe("Homemade");
    expect(merged.notes).toBe("family recipe");
  });

  it("records a nutrient the draft never had as an explicit null", () => {
    const merged = captureToFoodDraft({ name: "Lamb stew" }, { ...labelPayload, nutrition: { ...labelPayload.nutrition, transFatG: null } });

    expect(merged.nutrition?.transFatG).toBeNull();
  });

  it("keeps an estimated portion separate from the reusable library serving", () => {
    const draft = captureToFoodDraft({}, {
      ...labelPayload,
      name: "Pan-seared sirloin steak",
      serving: { amount: 100, unit: "g", description: "100 g" },
      portion: { amount: 40, unit: "g" },
      sourceType: "estimate",
    });
    const food = normalizeFood(draft);

    expect(food.serving).toEqual({ amount: 100, unit: "g", description: "100 g" });
    expect("portion" in food).toBe(false);
    expect(servingsForPortion(draft.portion, food.serving)).toBeCloseTo(0.4);
  });

  it("maps a label's default portion to exactly one serving", () => {
    const draft = captureToFoodDraft({}, labelPayload);
    const food = normalizeFood(draft);

    expect(servingsForPortion(draft.portion, food.serving)).toBe(1);
  });
});

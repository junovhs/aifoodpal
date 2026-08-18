import { normalizeFood, type Food } from "./model";
import { multiplyNutrition, sumNutrition } from "./nutrition";
import { formatQuantity, normalizeUnit, servingMultiplier } from "./units";

export interface ComboSelection {
  food: Food;
  amount: number;
  unit: string;
}

export const createComboFood = (name: string, selections: ComboSelection[]): Food => {
  const comboName = name.trim();
  if (!comboName) throw new Error("Give this combo a name.");
  if (selections.length < 2) throw new Error("Select at least two foods for a combo.");

  const portions = selections.map((selection) => {
    const unit = normalizeUnit(selection.unit, selection.food.serving.unit);
    const multiplier = servingMultiplier(selection.amount, unit, selection.food.serving);
    return { selection, unit, multiplier, nutrition: multiplyNutrition(selection.food.nutrition, multiplier) };
  });

  return normalizeFood({
    name: comboName,
    brand: "Saved combo",
    serving: { amount: 1, unit: "serving", description: "1 serving" },
    nutrition: sumNutrition(portions.map((portion) => portion.nutrition)),
    recipe: {
      ingredients: portions.map(({ selection, unit, nutrition }) => ({
        foodId: selection.food.id,
        name: selection.food.name,
        amount: selection.amount,
        unit,
        nutrition: {
          calories: nutrition.calories,
          proteinG: nutrition.proteinG,
          carbsG: nutrition.carbsG,
          fatG: nutrition.fatG,
        },
      })),
      instructions: `Saved combo: ${portions.map(({ selection, unit }) => `${formatQuantity(selection.amount, unit)} ${selection.food.name}`).join(" + ")}`,
    },
    sourceType: "user",
    confidence: "high",
  });
};

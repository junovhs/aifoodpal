export type UnitDimension = "volume" | "mass" | "count" | "custom";

export interface UnitDefinition {
  value: string;
  label: string;
  dimension: Exclude<UnitDimension, "custom">;
  baseFactor: number;
  aliases: string[];
}

export const UNIT_OPTIONS: UnitDefinition[] = [
  { value: "tsp", label: "teaspoon (tsp)", dimension: "volume", baseFactor: 4.92892159375, aliases: ["teaspoon", "teaspoons"] },
  { value: "tbsp", label: "tablespoon (tbsp)", dimension: "volume", baseFactor: 14.78676478125, aliases: ["tablespoon", "tablespoons", "tbs"] },
  { value: "fl oz", label: "fluid ounce (fl oz)", dimension: "volume", baseFactor: 29.5735295625, aliases: ["floz", "fluid ounce", "fluid ounces"] },
  { value: "cup", label: "cup", dimension: "volume", baseFactor: 236.5882365, aliases: ["cups"] },
  { value: "ml", label: "milliliter (ml)", dimension: "volume", baseFactor: 1, aliases: ["milliliter", "milliliters", "millilitre", "millilitres"] },
  { value: "l", label: "liter (L)", dimension: "volume", baseFactor: 1000, aliases: ["liter", "liters", "litre", "litres"] },
  { value: "g", label: "gram (g)", dimension: "mass", baseFactor: 1, aliases: ["gram", "grams"] },
  { value: "kg", label: "kilogram (kg)", dimension: "mass", baseFactor: 1000, aliases: ["kilogram", "kilograms"] },
  { value: "oz", label: "ounce (oz)", dimension: "mass", baseFactor: 28.349523125, aliases: ["ounce", "ounces"] },
  { value: "lb", label: "pound (lb)", dimension: "mass", baseFactor: 453.59237, aliases: ["lbs", "pound", "pounds"] },
  { value: "serving", label: "serving", dimension: "count", baseFactor: 1, aliases: ["servings"] },
  { value: "piece", label: "piece", dimension: "count", baseFactor: 1, aliases: ["pieces", "item", "items"] },
  { value: "slice", label: "slice", dimension: "count", baseFactor: 1, aliases: ["slices"] },
  { value: "container", label: "container", dimension: "count", baseFactor: 1, aliases: ["containers", "bottle", "bottles", "can", "cans"] },
];

const clean = (unit: unknown): string => String(unit ?? "").trim().toLowerCase().replaceAll(".", "").replace(/\s+/g, " ");

export const normalizeUnit = (unit: unknown, fallback = "serving"): string => {
  const value = clean(unit);
  if (!value) return fallback;
  const match = UNIT_OPTIONS.find((option) => option.value === value || option.aliases.includes(value));
  return match?.value ?? value;
};

export const unitDefinition = (unit: unknown): UnitDefinition | undefined => {
  const value = normalizeUnit(unit, "");
  return UNIT_OPTIONS.find((option) => option.value === value);
};

export const convertAmount = (amount: number, fromUnit: string, toUnit: string): number => {
  const from = normalizeUnit(fromUnit, "");
  const to = normalizeUnit(toUnit, "");
  if (from === to) return amount;
  const fromDefinition = unitDefinition(from);
  const toDefinition = unitDefinition(to);
  if (!fromDefinition || !toDefinition || fromDefinition.dimension !== toDefinition.dimension || fromDefinition.dimension === "count") {
    throw new Error(`Cannot convert ${from || "that unit"} to ${to || "that unit"}. Use a matching type of measurement.`);
  }
  return amount * fromDefinition.baseFactor / toDefinition.baseFactor;
};

export const servingMultiplier = (amount: number, unit: string, serving: { amount: number; unit: string }): number => {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter an amount greater than zero.");
  const inServingUnit = convertAmount(amount, unit, serving.unit);
  return inServingUnit / serving.amount;
};

export const formatQuantity = (amount: number, unit: string): string => {
  const normalized = normalizeUnit(unit);
  const displayAmount = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(amount);
  const plural = amount !== 1 && ["serving", "piece", "slice", "container", "cup"].includes(normalized) ? "s" : "";
  return `${displayAmount} ${normalized}${plural}`;
};

export const splitTrailingQuantity = (name: string): { name: string; amount: number; unit: string } | null => {
  const units = UNIT_OPTIONS.flatMap((unit) => [unit.value, ...unit.aliases])
    .sort((left, right) => right.length - left.length)
    .map((unit) => unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const match = name.trim().match(new RegExp(`^(.*?)(?:,|\\s[-–—]\\s)\\s*(\\d+(?:\\.\\d+)?|\\d+\\s*\/\\s*\\d+)\\s*(${units.join("|")})\\s*$`, "i"));
  if (!match) return null;
  const amountText = match[2]!.replaceAll(" ", "");
  const [numerator, denominator] = amountText.split("/").map(Number);
  const amount = denominator ? numerator! / denominator : numerator!;
  if (!Number.isFinite(amount) || amount <= 0 || !match[1]!.trim()) return null;
  return { name: match[1]!.trim(), amount, unit: normalizeUnit(match[3]) };
};

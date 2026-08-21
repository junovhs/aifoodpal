import type { FoodInput } from "./model";

/**
 * Why a barcode path produced nothing. Every case falls through to the AI label read, so
 * these are routing facts rather than errors the user needs to see.
 */
export type BarcodeMissReason = "no-barcode" | "unknown-product" | "unreadable-product" | "lookup-failed";

export type BarcodeResult =
  | { found: true; food: FoodInput; code: string }
  | { found: false; reason: BarcodeMissReason };

/** The Open Food Facts fields this app reads. Everything is optional; the API omits freely. */
export interface OpenFoodFactsProduct {
  product_name?: string;
  brands?: string;
  serving_size?: string;
  serving_quantity?: number | string;
  nutriments?: Record<string, number | string | undefined>;
}

/** Barcode decoding and product lookup, injected so both halves are testable offline. */
export interface BarcodeDeps {
  decode: (image: Blob) => Promise<string | null>;
  lookup: (code: string) => Promise<OpenFoodFactsProduct | null>;
}

const OPEN_FOOD_FACTS_FIELDS = "product_name,brands,serving_size,serving_quantity,nutriments";

const numeric = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Read one nutrient. Prefer the per-serving figure Open Food Facts already computed; fall
 * back to scaling the per-100g figure by the serving weight. Returning null rather than
 * guessing keeps an absent nutrient distinguishable from a confident zero.
 */
const nutrient = (nutriments: Record<string, number | string | undefined>, key: string, gramsPerServing: number): number | null => {
  const perServing = numeric(nutriments[`${key}_serving`]);
  if (perServing !== null) return perServing;
  const perHundred = numeric(nutriments[`${key}_100g`]);
  if (perHundred === null) return null;
  // Deliberately unrounded: sodium arrives in grams, so a 2dp round here would flatten a
  // real 2 mg figure to zero. Rounding happens per field below, in that field's own unit.
  return perHundred * (gramsPerServing / 100);
};

/** Round a gram figure for display without pretending to precision the source lacks. */
const grams = (value: number | null): number | null => (value === null ? null : Math.round(value * 100) / 100);

/**
 * Map an Open Food Facts product onto a food draft, or null when there is not enough to be
 * worth showing. Calories are the bar: a product with no energy figure is not a usable entry,
 * and falling through to the AI read will serve the user better than a mostly empty form.
 */
export const productToFood = (product: OpenFoodFactsProduct, code: string): FoodInput | null => {
  const name = (product.product_name ?? "").trim();
  const nutriments = product.nutriments ?? {};
  if (name.length === 0) return null;

  // With no stated serving weight, the panel's own per-100g basis becomes the serving, so a
  // product that only publishes per-100g figures still yields a usable entry.
  const servingAmount = numeric(product.serving_quantity) ?? 100;
  const calories = nutrient(nutriments, "energy-kcal", servingAmount);
  if (calories === null) return null;

  const servingDescription = (product.serving_size ?? "").trim() || `${servingAmount} g`;
  const sodiumG = nutrient(nutriments, "sodium", servingAmount);

  return {
    name,
    brand: (product.brands ?? "").split(",")[0]?.trim() || null,
    serving: { amount: servingAmount, unit: "g", description: servingDescription },
    nutrition: {
      calories: Math.round(calories),
      proteinG: grams(nutrient(nutriments, "proteins", servingAmount)),
      carbsG: grams(nutrient(nutriments, "carbohydrates", servingAmount)),
      fatG: grams(nutrient(nutriments, "fat", servingAmount)),
      fiberG: grams(nutrient(nutriments, "fiber", servingAmount)),
      sugarG: grams(nutrient(nutriments, "sugars", servingAmount)),
      addedSugarG: null,
      saturatedFatG: grams(nutrient(nutriments, "saturated-fat", servingAmount)),
      transFatG: grams(nutrient(nutriments, "trans-fat", servingAmount)),
      sodiumMg: sodiumG === null ? null : Math.round(sodiumG * 1000),
    },
    sourceType: "label",
    confidence: "high",
    notes: `Open Food Facts ${code}`,
    recipe: null,
  };
};

/** Look a barcode up in Open Food Facts. No key, no account, no AI spend. */
export const lookupOpenFoodFacts = async (code: string, fetchImpl: typeof fetch = fetch): Promise<OpenFoodFactsProduct | null> => {
  const response = await fetchImpl(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${OPEN_FOOD_FACTS_FIELDS}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Open Food Facts returned ${response.status}.`);
  const payload = await response.json() as { status?: number; product?: OpenFoodFactsProduct };
  if (payload.status !== 1 || !payload.product) return null;
  return payload.product;
};

/**
 * Try the free path for one photo: decode a barcode, then look the product up.
 * Every failure is a miss rather than a throw, because the caller's answer to all of them is
 * the same — fall through to the paid AI read of the same photo.
 */
export const scanBarcode = async (image: Blob, deps: BarcodeDeps): Promise<BarcodeResult> => {
  let code: string | null;
  try {
    code = await deps.decode(image);
  } catch {
    return { found: false, reason: "no-barcode" };
  }
  if (!code) return { found: false, reason: "no-barcode" };

  let product: OpenFoodFactsProduct | null;
  try {
    product = await deps.lookup(code);
  } catch {
    return { found: false, reason: "lookup-failed" };
  }
  if (!product) return { found: false, reason: "unknown-product" };

  const food = productToFood(product, code);
  return food ? { found: true, food, code } : { found: false, reason: "unreadable-product" };
};

const BARCODE_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];

interface BarcodeDetectorLike {
  detect: (image: Blob | ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>;
}

/**
 * Decode with the platform detector where it exists, and a WebAssembly reader where it does
 * not. No browser on iOS implements BarcodeDetector — they are all WebKit underneath — so the
 * wasm path is not a niche fallback, it is what iPhones actually use.
 */
export const decodeBarcode = async (image: Blob): Promise<string | null> => {
  const detectorCtor = (globalThis as { BarcodeDetector?: new (options: { formats: string[] }) => BarcodeDetectorLike }).BarcodeDetector;
  if (detectorCtor) {
    const detected = await new detectorCtor({ formats: BARCODE_FORMATS }).detect(image);
    return detected[0]?.rawValue?.trim() || null;
  }

  const { readBarcodes, prepareZXingModule } = await import("zxing-wasm/reader");
  const { default: wasmUrl } = await import("zxing-wasm/reader/zxing_reader.wasm?url");
  // Serve the wasm from our own bundle rather than the library's default CDN.
  prepareZXingModule({ overrides: { locateFile: () => wasmUrl } });
  const results = await readBarcodes(image, { formats: ["EAN-13", "EAN-8", "UPC-A", "UPC-E"] });
  return results[0]?.text?.trim() || null;
};

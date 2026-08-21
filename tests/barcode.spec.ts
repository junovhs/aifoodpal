import { describe, expect, it, vi } from "vitest";
import { lookupOpenFoodFacts, productToFood, scanBarcode, type BarcodeDeps, type OpenFoodFactsProduct } from "../src/barcode";

const perServing: OpenFoodFactsProduct = {
  product_name: "Chunky peanut butter",
  brands: "Skippy, Hormel",
  serving_size: "2 tbsp (32 g)",
  serving_quantity: 32,
  nutriments: {
    "energy-kcal_serving": 190,
    proteins_serving: 7,
    carbohydrates_serving: 6,
    fat_serving: 16,
    fiber_serving: 2,
    sugars_serving: 3,
    "saturated-fat_serving": 3.5,
    sodium_serving: 0.13,
  },
};

const perHundredOnly: OpenFoodFactsProduct = {
  product_name: "Rolled oats",
  brands: "Bob's Red Mill",
  serving_size: "40 g",
  serving_quantity: 40,
  nutriments: {
    "energy-kcal_100g": 380,
    proteins_100g: 13,
    carbohydrates_100g: 67,
    fat_100g: 7,
    fiber_100g: 10,
    sodium_100g: 0.005,
  },
};

const jsonResponse = (body: unknown, status = 200): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
} as Response);

describe("productToFood", () => {
  it("uses the per-serving figures Open Food Facts already computed", () => {
    const food = productToFood(perServing, "037600106245");

    expect(food).toMatchObject({
      name: "Chunky peanut butter",
      brand: "Skippy",
      serving: { amount: 32, unit: "g", description: "2 tbsp (32 g)" },
      nutrition: { calories: 190, proteinG: 7, carbsG: 6, fatG: 16, fiberG: 2, sugarG: 3, saturatedFatG: 3.5, sodiumMg: 130 },
    });
    expect(food?.notes).toContain("037600106245");
  });

  it("scales per-100g figures to the stated serving weight", () => {
    const food = productToFood(perHundredOnly, "039978003201");

    expect(food?.serving).toMatchObject({ amount: 40, description: "40 g" });
    expect(food?.nutrition).toMatchObject({ calories: 152, proteinG: 5.2, carbsG: 26.8, fatG: 2.8, fiberG: 4, sodiumMg: 2 });
  });

  it("falls back to a 100 g serving when no serving weight is stated", () => {
    const food = productToFood({ product_name: "Flour", nutriments: { "energy-kcal_100g": 364 } }, "1");

    expect(food?.serving).toMatchObject({ amount: 100, unit: "g", description: "100 g" });
    expect(food?.nutrition?.calories).toBe(364);
  });

  it("leaves a nutrient null rather than inventing a zero", () => {
    const food = productToFood(perHundredOnly, "1");

    expect(food?.nutrition?.sugarG).toBeNull();
    expect(food?.nutrition?.addedSugarG).toBeNull();
  });

  it("declines a product with no name or no energy figure", () => {
    expect(productToFood({ product_name: "  ", nutriments: { "energy-kcal_serving": 100 } }, "1")).toBeNull();
    expect(productToFood({ product_name: "Mystery", nutriments: {} }, "1")).toBeNull();
  });
});

describe("lookupOpenFoodFacts", () => {
  it("asks for only the fields the app reads", async () => {
    const fetchImpl = vi.fn(async (_url: string) => jsonResponse({ status: 1, product: perServing }));

    const product = await lookupOpenFoodFacts("037600106245", fetchImpl as unknown as typeof fetch);

    expect(product).toBe(perServing);
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain("/api/v2/product/037600106245.json");
    expect(url).toContain("fields=product_name,brands,serving_size,serving_quantity,nutriments");
  });

  it("treats an unknown product as absent, not as a failure", async () => {
    expect(await lookupOpenFoodFacts("0", (async () => jsonResponse({ status: 0 })) as unknown as typeof fetch)).toBeNull();
    expect(await lookupOpenFoodFacts("0", (async () => jsonResponse({}, 404)) as unknown as typeof fetch)).toBeNull();
  });

  it("raises on a server failure so the caller can fall through deliberately", async () => {
    await expect(lookupOpenFoodFacts("0", (async () => jsonResponse({}, 500)) as unknown as typeof fetch)).rejects.toThrow(/500/);
  });
});

describe("scanBarcode", () => {
  const photo = new Blob(["photo"], { type: "image/jpeg" });
  const deps = (overrides: Partial<BarcodeDeps> = {}): BarcodeDeps => ({
    decode: async () => "037600106245",
    lookup: async () => perServing,
    ...overrides,
  });

  it("returns the mapped food when the barcode and product both resolve", async () => {
    const result = await scanBarcode(photo, deps());

    expect(result).toMatchObject({ found: true, code: "037600106245" });
    expect(result.found && result.food.name).toBe("Chunky peanut butter");
  });

  it.each([
    ["no barcode in the photo", { decode: async () => null }, "no-barcode"],
    ["a decoder that throws", { decode: async () => { throw new Error("wasm failed to load"); } }, "no-barcode"],
    ["a product nobody has catalogued", { lookup: async () => null }, "unknown-product"],
    ["a lookup that fails", { lookup: async () => { throw new Error("offline"); } }, "lookup-failed"],
    ["a catalogued product with no usable nutrition", { lookup: async () => ({ product_name: "Mystery", nutriments: {} }) }, "unreadable-product"],
  ])("reports %s as a miss rather than throwing", async (_label, overrides, reason) => {
    expect(await scanBarcode(photo, deps(overrides as Partial<BarcodeDeps>))).toEqual({ found: false, reason });
  });
});

import { describe, expect, it } from "vitest";
import { icon } from "../src/icons";

describe("icon boundary", () => {
  it("emits a single accessible Lucide placeholder", () => {
    expect(icon("Sparkles", "action-icon")).toBe(
      '<i data-lucide="Sparkles" class="icon action-icon" aria-hidden="true"></i>',
    );
  });
});

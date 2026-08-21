// @vitest-environment jsdom
/// <reference types="vite/client" />

import { describe, expect, it, vi } from "vitest";
// Node types are intentionally not part of the browser app's TypeScript project.
// @ts-expect-error Vitest runs this file in Node and provides the built-in at runtime.
import { readFileSync } from "node:fs";
import indexHtml from "../index.html?raw";
import manifestText from "../public/manifest.webmanifest?raw";
import { DaybookApp } from "../src/app";
import { createState } from "../src/model";

const styles = readFileSync("src/styles.css", "utf8");

describe("mobile app shell", () => {
  it("renders one contained scroll pane with the header and tabs outside it", () => {
    const state = createState("2026-08-21");
    state.profile.onboardingComplete = true;
    const root = document.createElement("div");
    document.body.replaceChildren(root);

    new DaybookApp(root, { load: () => state, save: vi.fn() }).start();

    const panes = root.querySelectorAll("[data-scroll-pane]");
    expect(panes).toHaveLength(1);
    expect(panes[0]?.tagName).not.toBe("BODY");
    expect(root.querySelector(".main")?.children).toEqual(expect.objectContaining({ length: 3 }));
    expect(root.querySelector(".top")?.parentElement).toBe(root.querySelector(".main"));
    expect(root.querySelector(".bottom")?.parentElement).toBe(root.querySelector(".main"));
    expect(styles).toContain("body { height: 100%; margin: 0; overflow: hidden; overscroll-behavior: none;");
    expect(styles).toContain(".shell { height: 100dvh; overflow: hidden; }");
    expect(styles).toContain(".view { min-height: 0; overflow-y: auto; overscroll-behavior: contain;");
    expect(styles.match(/overflow-y:\s*auto/g)).toHaveLength(1);
  });

  it("advertises standalone installation and the iOS launch mode", () => {
    const page = new DOMParser().parseFromString(indexHtml, "text/html");
    const manifest = JSON.parse(manifestText) as { display: string; icons: { sizes: string; purpose: string; type: string }[] };

    expect(page.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.getAttribute("href")).toBe("/manifest.webmanifest");
    expect(page.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-capable"]')?.content).toBe("yes");
    expect(page.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]')?.content).toBe("default");
    expect(page.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')?.getAttribute("href")).toBe("/icons/apple-touch-icon.png");
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons.map(({ sizes }) => sizes)).toEqual(["192x192", "512x512"]);
    expect(manifest.icons.every((icon) => icon.type === "image/png")).toBe(true);
    expect(manifest.icons.every(({ purpose }) => purpose.includes("maskable"))).toBe(true);
  });
});

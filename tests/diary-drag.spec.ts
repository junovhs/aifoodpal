// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiaryDragController } from "../src/diary-drag";

const rect = (top: number, height: number, left = 0, width = 600): DOMRect => ({
  x: left, y: top, top, bottom: top + height, left, right: left + width, width, height,
  toJSON: () => ({}),
});

const diaryHtml = (): string => `
  <section class="mealgroup" data-period="breakfast">
    <div class="entrylist"><div class="entry-shell" data-entry-id="toast"><button data-drag-handle>drag</button></div></div>
  </section>
  <section class="mealgroup" data-period="lunch"><div class="entrylist"></div></section>`;

const pointerEvent = (type: string, pointerId: number, clientY: number): MouseEvent => {
  const event = new MouseEvent(type, { bubbles: true, clientX: 20, clientY });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
};

const installGeometry = (root: HTMLElement): void => {
  const breakfast = root.querySelector<HTMLElement>('[data-period="breakfast"]')!;
  const lunch = root.querySelector<HTMLElement>('[data-period="lunch"]')!;
  breakfast.getBoundingClientRect = () => rect(0, 100);
  lunch.getBoundingClientRect = () => rect(101, 199);
  const shell = root.querySelector<HTMLElement>(".entry-shell")!;
  shell.getBoundingClientRect = () => {
    if (shell.style.position === "fixed") return rect(Number.parseFloat(shell.style.top) || 30, 40);
    return shell.closest('[data-period="lunch"]') ? rect(150, 40) : rect(30, 40);
  };
  const handle = root.querySelector<HTMLElement>("[data-drag-handle]")!;
  Object.assign(handle, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
};

describe("DiaryDragController", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
  });

  it("schedules a fresh animation loop for a second drag after a committed drop", () => {
    const root = document.querySelector<HTMLElement>("#root")!;
    root.innerHTML = diaryHtml();
    installGeometry(root);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    const commit = vi.fn();
    const settled = vi.fn(() => {
      root.innerHTML = diaryHtml();
      installGeometry(root);
    });
    new DiaryDragController(root, commit, settled);

    root.querySelector<HTMLElement>("[data-drag-handle]")!.dispatchEvent(pointerEvent("pointerdown", 1, 40));
    frames.shift()!(16);
    window.dispatchEvent(pointerEvent("pointermove", 1, 180));
    frames.shift()!(32);
    window.dispatchEvent(pointerEvent("pointerup", 1, 180));

    let timestamp = 48;
    while (!settled.mock.calls.length && frames.length && timestamp < 8000) {
      frames.shift()!(timestamp);
      timestamp += 16;
    }
    expect(commit).toHaveBeenCalledWith("toast", "lunch", 0);
    expect(settled).toHaveBeenCalledOnce();
    expect(frames).toHaveLength(0);

    root.querySelector<HTMLElement>("[data-drag-handle]")!.dispatchEvent(pointerEvent("pointerdown", 2, 40));
    expect(frames).toHaveLength(1);
    expect(document.body.classList.contains("diary-dragging")).toBe(true);
  });
});

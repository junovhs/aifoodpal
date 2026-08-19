import type { Period } from "./model";

type DragCommit = (entryId: string, period: Period, index: number) => void;

class Spring {
  pos: number;
  target: number;
  velocity = 0;

  constructor(private readonly stiffness: number, private readonly damping: number, initial = 0) {
    this.pos = initial;
    this.target = initial;
  }

  set(value: number): void {
    this.pos = value;
    this.target = value;
    this.velocity = 0;
  }

  step(delta: number): void {
    let remaining = Math.min(delta, 1 / 30);
    while (remaining > .000001) {
      const step = Math.min(remaining, 1 / 120);
      const acceleration = -this.stiffness * (this.pos - this.target) - this.damping * this.velocity;
      this.velocity += acceleration * step;
      this.pos += this.velocity * step;
      remaining -= step;
    }
  }

  done(threshold = .25): boolean {
    return Math.abs(this.pos - this.target) < threshold && Math.abs(this.velocity) < threshold;
  }
}

type ActiveDrag = {
  pointerId: number;
  entryId: string;
  shell: HTMLElement;
  handle: HTMLElement;
  placeholder: HTMLElement;
  startX: number;
  startY: number;
  rawX: number;
  rawY: number;
  predictedX: number;
  predictedY: number;
  hasPrediction: boolean;
  lastX: number;
  lastY: number;
  lastTime: number;
  velocityX: number;
  velocityY: number;
  sourcePeriod: Period;
  sourceIndex: number;
  targetPeriod: Period;
  targetIndex: number;
  moved: boolean;
};

const periods = ["breakfast", "lunch", "dinner", "snacks"] as const;
const isPeriod = (value: string | undefined): value is Period => periods.includes(value as Period);

export class DiaryDragController {
  private drag: ActiveDrag | null = null;
  private frame: number | null = null;
  private lastFrame = 0;
  private readonly scale = new Spring(650, 28, 1);
  private readonly shiftSprings = new Map<HTMLElement, Spring>();

  constructor(
    private readonly root: HTMLElement,
    private readonly commit: DragCommit,
    private readonly settled: () => void,
  ) {
    root.addEventListener("pointerdown", this.onPointerDown);
    root.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("pointerrawupdate", this.onPointerRawUpdate, { passive: true });
    window.addEventListener("pointermove", this.onPointerMove, { passive: false });
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
  }

  private springFor(element: HTMLElement): Spring {
    let spring = this.shiftSprings.get(element);
    if (!spring) {
      spring = new Spring(900, 45);
      this.shiftSprings.set(element, spring);
    }
    return spring;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    const handle = (event.target as Element).closest<HTMLElement>("[data-drag-handle]");
    const shell = handle?.closest<HTMLElement>(".entry-shell[data-entry-id]");
    const group = shell?.closest<HTMLElement>(".mealgroup[data-period]");
    if (!handle || !shell || !group || !isPeriod(group.dataset.period) || this.drag) return;

    event.preventDefault();
    const list = group.querySelector<HTMLElement>(".entrylist");
    if (!list) return;
    const siblings = [...list.querySelectorAll<HTMLElement>(":scope > .entry-shell")];
    const rect = shell.getBoundingClientRect();
    const placeholder = document.createElement("div");
    placeholder.className = "entry-placeholder";
    placeholder.style.height = `${rect.height}px`;
    placeholder.setAttribute("aria-hidden", "true");
    shell.before(placeholder);
    document.body.append(shell);
    handle.setPointerCapture(event.pointerId);

    shell.classList.add("dragging");
    Object.assign(shell.style, {
      position: "fixed",
      zIndex: "70",
      top: `${rect.top}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: "0",
      willChange: "transform",
    });

    const now = event.timeStamp || performance.now();
    this.drag = {
      pointerId: event.pointerId,
      entryId: shell.dataset.entryId ?? "",
      shell,
      handle,
      placeholder,
      startX: event.clientX,
      startY: event.clientY,
      rawX: event.clientX,
      rawY: event.clientY,
      predictedX: event.clientX,
      predictedY: event.clientY,
      hasPrediction: false,
      lastX: event.clientX,
      lastY: event.clientY,
      lastTime: now,
      velocityX: 0,
      velocityY: 0,
      sourcePeriod: group.dataset.period,
      sourceIndex: siblings.indexOf(shell),
      targetPeriod: group.dataset.period,
      targetIndex: siblings.indexOf(shell),
      moved: false,
    };
    this.scale.set(1);
    this.scale.target = 1.025;
    document.body.classList.add("diary-dragging");
    this.startLoop();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const handle = (event.target as Element).closest<HTMLElement>("[data-drag-handle]");
    const shell = handle?.closest<HTMLElement>(".entry-shell[data-entry-id]");
    const group = shell?.closest<HTMLElement>(".mealgroup[data-period]");
    if (!handle || !shell || !group || !isPeriod(group.dataset.period)) return;
    const list = group.querySelector<HTMLElement>(".entrylist");
    if (!list) return;
    event.preventDefault();
    const siblings = [...list.querySelectorAll<HTMLElement>(":scope > .entry-shell")];
    const currentIndex = siblings.indexOf(shell);
    const direction = event.key === "ArrowUp" ? -1 : 1;
    let targetPeriod = group.dataset.period;
    let targetIndex = currentIndex + direction;
    if (targetIndex < 0 || targetIndex >= siblings.length) {
      const periodIndex = periods.indexOf(targetPeriod) + direction;
      if (periodIndex < 0 || periodIndex >= periods.length) return;
      targetPeriod = periods[periodIndex]!;
      const targetGroup = this.root.querySelector<HTMLElement>(`.mealgroup[data-period="${targetPeriod}"] .entrylist`);
      const count = targetGroup?.querySelectorAll(":scope > .entry-shell").length ?? 0;
      targetIndex = direction < 0 ? count : 0;
    }
    this.commit(shell.dataset.entryId ?? "", targetPeriod, targetIndex);
    this.settled();
    requestAnimationFrame(() => {
      const moved = this.root.querySelector<HTMLElement>(`.entry-shell[data-entry-id="${shell.dataset.entryId}"] [data-drag-handle]`);
      moved?.focus();
    });
  };

  private readonly onPointerRawUpdate = (rawEvent: Event): void => {
    const event = rawEvent as PointerEvent;
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const coalesced = event.getCoalescedEvents?.();
    const source = coalesced?.length ? coalesced[coalesced.length - 1]! : event;
    const time = source.timeStamp || performance.now();
    const delta = Math.max(.001, (time - drag.lastTime) / 1000);
    const instantX = (source.clientX - drag.lastX) / delta;
    const instantY = (source.clientY - drag.lastY) / delta;
    drag.velocityX += (instantX - drag.velocityX) * .35;
    drag.velocityY += (instantY - drag.velocityY) * .35;
    drag.rawX = source.clientX;
    drag.rawY = source.clientY;
    drag.lastX = source.clientX;
    drag.lastY = source.clientY;
    drag.lastTime = time;
    const predicted = event.getPredictedEvents?.();
    if (predicted?.length) {
      const point = predicted[predicted.length - 1]!;
      drag.predictedX = point.clientX;
      drag.predictedY = point.clientY;
      drag.hasPrediction = true;
    } else {
      drag.hasPrediction = false;
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    drag.rawX = event.clientX;
    drag.rawY = event.clientY;
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) drag.moved = true;
  };

  private updateTarget(pointerY: number): void {
    const drag = this.drag;
    if (!drag) return;
    const groups = [...this.root.querySelectorAll<HTMLElement>(".mealgroup[data-period]")];
    const group = groups.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return pointerY >= rect.top && pointerY <= rect.bottom;
    }) ?? groups.reduce((nearest, candidate) => {
      const rect = candidate.getBoundingClientRect();
      const distance = pointerY < rect.top ? rect.top - pointerY : pointerY - rect.bottom;
      return !nearest || distance < nearest.distance ? { element: candidate, distance } : nearest;
    }, null as { element: HTMLElement; distance: number } | null)?.element;
    if (!group || !isPeriod(group.dataset.period)) return;
    const list = group.querySelector<HTMLElement>(".entrylist");
    if (!list) return;
    const entries = [...list.querySelectorAll<HTMLElement>(":scope > .entry-shell")].filter((entry) => entry !== drag.shell);
    let index = entries.length;
    for (let i = 0; i < entries.length; i += 1) {
      const rect = entries[i]!.getBoundingClientRect();
      if (pointerY < rect.top + rect.height / 2) { index = i; break; }
    }
    if (drag.targetPeriod === group.dataset.period && drag.targetIndex === index) return;

    const moving = [...this.root.querySelectorAll<HTMLElement>(".entry-shell")].filter((entry) => entry !== drag.shell);
    const before = new Map(moving.map((entry) => [entry, entry.getBoundingClientRect().top]));
    if (index >= entries.length) list.append(drag.placeholder);
    else list.insertBefore(drag.placeholder, entries[index]!);
    list.classList.add("drop-active");
    this.root.querySelectorAll(".entrylist.drop-active").forEach((candidate) => {
      if (candidate !== list) candidate.classList.remove("drop-active");
    });
    for (const entry of moving) {
      const delta = (before.get(entry) ?? 0) - entry.getBoundingClientRect().top;
      if (Math.abs(delta) < .5) continue;
      const spring = this.springFor(entry);
      spring.pos += delta;
      spring.target = 0;
      entry.style.willChange = "transform";
    }
    drag.targetPeriod = group.dataset.period;
    drag.targetIndex = index;
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.handle.releasePointerCapture?.(event.pointerId);
    const changed = drag.targetPeriod !== drag.sourcePeriod || drag.targetIndex !== drag.sourceIndex;
    if (changed) this.commit(drag.entryId, drag.targetPeriod, drag.targetIndex);

    const before = drag.shell.getBoundingClientRect();
    drag.placeholder.replaceWith(drag.shell);
    drag.shell.classList.remove("dragging");
    Object.assign(drag.shell.style, { position: "", zIndex: "", top: "", left: "", width: "", height: "", margin: "" });
    drag.shell.style.transform = "";
    const after = drag.shell.getBoundingClientRect();
    const x = new Spring(420, 34, before.left - after.left);
    const y = new Spring(560, 40, before.top - after.top);
    x.target = 0;
    y.target = 0;
    this.scale.target = 1;
    drag.shell.classList.add("settling");
    drag.shell.dataset.settleX = String(x.pos);
    drag.shell.dataset.settleY = String(y.pos);
    (drag.shell as HTMLElement & { _dropX?: Spring; _dropY?: Spring })._dropX = x;
    (drag.shell as HTMLElement & { _dropX?: Spring; _dropY?: Spring })._dropY = y;
    this.root.querySelectorAll(".entrylist.drop-active").forEach((list) => list.classList.remove("drop-active"));
    document.body.classList.remove("diary-dragging");
    this.drag = null;
    this.startLoop(changed);
  };

  private startLoop(hasCommittedDrop = false): void {
    if (hasCommittedDrop) this.pendingSettle = true;
    if (this.frame === null) {
      this.lastFrame = performance.now();
      this.frame = requestAnimationFrame(this.loop);
    }
  }

  private pendingSettle = false;

  private readonly loop = (now: number): void => {
    const delta = Math.min((now - this.lastFrame) / 1000, 1 / 30);
    this.lastFrame = now;
    let active = false;
    const drag = this.drag;
    if (drag) {
      active = true;
      this.scale.step(delta);
      const lead = 1 / 60;
      const x = drag.hasPrediction ? drag.predictedX : drag.rawX + drag.velocityX * lead;
      const y = drag.hasPrediction ? drag.predictedY : drag.rawY + drag.velocityY * lead;
      const dx = (x - drag.startX) * .35;
      const dy = y - drag.startY;
      drag.shell.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale3d(${this.scale.pos}, ${this.scale.pos}, 1)`;
      this.updateTarget(y);
    }

    for (const [element, spring] of this.shiftSprings) {
      spring.step(delta);
      if (spring.done()) {
        element.style.transform = "";
        element.style.willChange = "";
        this.shiftSprings.delete(element);
      } else {
        element.style.transform = `translate3d(0, ${spring.pos}px, 0)`;
        active = true;
      }
    }

    const settling = this.root.querySelector<HTMLElement>(".entry-shell.settling");
    if (settling) {
      const springs = settling as HTMLElement & { _dropX?: Spring; _dropY?: Spring };
      springs._dropX?.step(delta);
      springs._dropY?.step(delta);
      this.scale.step(delta);
      const x = springs._dropX?.pos ?? 0;
      const y = springs._dropY?.pos ?? 0;
      settling.style.transform = `translate3d(${x}px, ${y}px, 0) scale3d(${this.scale.pos}, ${this.scale.pos}, 1)`;
      if (springs._dropX?.done() && springs._dropY?.done() && this.scale.done(.002)) {
        settling.classList.remove("settling");
        settling.style.transform = "";
        settling.style.willChange = "";
        delete springs._dropX;
        delete springs._dropY;
        if (this.pendingSettle) {
          this.pendingSettle = false;
          this.frame = null;
          for (const element of this.shiftSprings.keys()) {
            element.style.transform = "";
            element.style.willChange = "";
          }
          this.shiftSprings.clear();
          this.settled();
          return;
        }
      } else {
        active = true;
      }
    }
    this.frame = active ? requestAnimationFrame(this.loop) : null;
  };
}

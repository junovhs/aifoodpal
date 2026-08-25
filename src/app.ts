import { applyAiResponse, buildAiPrompt, parseAiResponse, type AiResponse } from "./ai";
import { NOTE_MAX_CHARS, type CaptureMode } from "./ai-capture";
import { prepareImage, type CapturedImage } from "./image";
import { CaptureError, captureFoodViaSupabase, captureToFoodDraft, type CaptureFoodClient } from "./capture-client";
import { decodeBarcode, lookupOpenFoodFacts, scanBarcode, type BarcodeResult } from "./barcode";
import { createEntry, createQuickCalorieEntry, isoDate, moveDiaryEntry, normalizeFood, normalizePeriod, PERIODS, protectedSnackBudget, removeFoodFromLibrary, uid, type AppState, type ExerciseKind, type Food, type FoodInput, type Period, type RecipeIngredient } from "./model";
import { calorieGuidance, calorieTrend, dailyCalorieGuide, exerciseCalories, formatDate, kgToPounds, latestWeight, nutritionTargets, parseLocalDate, poundsToKg, round, shiftDate, totalsFor, weightProjection } from "./nutrition";
import { exportBackup, parseBackup, type StateRepository } from "./storage";
import { icon, renderIcons } from "./icons";
import { calendarGrid, formatMonth, shiftMonth } from "./calendar";
import { createComboFood } from "./combos";
import { formatQuantity, normalizeUnit, servingMultiplier, UNIT_OPTIONS } from "./units";
import { DiaryDragController } from "./diary-drag";
import type { AccountController } from "./account";
import { CloudStateRepository, type SyncStatus } from "./cloud-sync";

type View = "day" | "calendar" | "library" | "trend" | "settings";
type FoodModal = { kind: "food"; food?: Food; draft?: FoodInput; aiPrompt?: string; aiMessage?: string; aiError?: string; captureNote?: string; capturing?: CaptureMode };

/** The impure half of photo capture, injected so the food editor is testable without a canvas or a server. */
export interface FoodCaptureDeps {
  prepare: (file: Blob) => Promise<CapturedImage>;
  send: CaptureFoodClient;
  /** The free path: decode a barcode and look the product up before any AI spend. */
  scan: (image: Blob) => Promise<BarcodeResult>;
}
type Modal = FoodModal | { kind: "combo"; error?: string } | { kind: "quick"; calories: number; period: Period } | { kind: "choose"; period?: Period } | { kind: "log"; food: Food; period?: Period } | { kind: "delete-food"; food: Food } | { kind: "weight" } | { kind: "exercise" } | { kind: "backup" } | { kind: "ai"; stage: "request" | "prompt" | "reply" | "preview"; prompt?: string; response?: AiResponse } | null;

const html = (value: unknown): string => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const fmt = (value: number | null | undefined, digits = 0): string => value == null ? "?" : new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value);
const searchKey = (value: string): string => value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase().replace(/\s+/g, " ").trim();
const field = (label: string, name: string, value: unknown, type = "number", attrs = ""): string => `<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${html(value)}" ${attrs}></label>`;
const getNumber = (data: FormData, key: string): number | null => { const value = data.get(key); if (value === null || value === "") return null; const number = Number(value); return Number.isFinite(number) ? number : null; };
const measurementList = (): string => `<datalist id="measurement-units">${UNIT_OPTIONS.map((unit) => `<option value="${unit.value}">${unit.label}</option>`).join("")}</datalist>`;
const ACTIVITY_LEVELS = [
  { value: 1.2, label: "Sedentary", test: "Most of the day is seated; little walking beyond daily errands." },
  { value: 1.4, label: "Lightly active", test: "You are on your feet or walking for roughly 1–3 hours most days." },
  { value: 1.6, label: "Moderately active", test: "You move for much of the day, outside intentional workouts." },
  { value: 1.8, label: "Very active", test: "Your work or routine keeps you moving and lifting most of the day." },
  { value: 2, label: "Extremely active", test: "You do sustained heavy physical work nearly every day." },
] as const;
const EXERCISE_LABELS: Record<ExerciseKind, string> = { strength: "Dumbbells / strength", walkEasy: "Easy walk", walkBrisk: "Brisk walk", workoutHard: "Hard workout" };
const activityField = (value: number, name = "activityPAL"): string => {
  const selected = ACTIVITY_LEVELS.reduce((closest, level) => Math.abs(level.value - value) < Math.abs(closest.value - value) ? level : closest);
  return `<label class="field activity-field"><span>normal day (before workouts)</span><select name="${name}">${ACTIVITY_LEVELS.map((level) => `<option value="${level.value}" ${selected.value === level.value ? "selected" : ""}>${level.label} — ${level.test}</option>`).join("")}</select><small>Pick the closest typical day. Log dumbbells, walks, and other planned workouts separately so they are not counted twice.</small></label>`;
};

export class DaybookApp {
  private state: AppState;
  private view: View = "day";
  private mealPeriod?: Period;
  private calendarMonth: string;
  private modal: Modal = null;
  private toastTimer?: number;
  private syncStatus?: SyncStatus;
  private syncOpen = false;
  private readonly mounted = new WeakMap<HTMLElement, string>();
  /** The desktop breakpoint, matching the sidebar rule in styles.css. Absent in environments without matchMedia, which then get the phone layout. */
  private readonly wideQuery = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 900px)") : null;

  constructor(
    private readonly root: HTMLElement,
    private readonly repository: StateRepository,
    private readonly account?: AccountController,
    private readonly capture: FoodCaptureDeps = {
      prepare: prepareImage,
      send: captureFoodViaSupabase,
      scan: (image) => scanBarcode(image, { decode: decodeBarcode, lookup: lookupOpenFoodFacts }),
    },
  ) {
    this.state = repository.load();
    this.normalizeSnackBudget();
    this.calendarMonth = this.state.prefs.date.slice(0, 7);
  }

  start(): void {
    this.root.addEventListener("click", (event) => this.onClick(event));
    this.root.addEventListener("submit", (event) => this.onSubmit(event));
    this.root.addEventListener("change", (event) => this.onChange(event));
    this.root.addEventListener("input", (event) => this.onInput(event));
    this.account?.start(() => this.renderAccount());
    if (this.repository instanceof CloudStateRepository) {
      this.syncStatus = this.repository.getStatus();
      this.repository.connect(
        (state) => { this.state = state; this.normalizeSnackBudget(); this.render(); },
        (status) => {
          this.syncStatus = status;
          if (status.phase === "migration" || status.phase === "conflict" || status.phase === "offline") this.syncOpen = true;
          this.renderSync();
        },
      );
    }
    this.wideQuery?.addEventListener("change", () => this.render());
    this.render();
    new DiaryDragController(
      this.root,
      (entryId, period, index) => this.moveEntry(entryId, period, index),
      () => { this.render(); this.showToast("meal order updated"); },
    );
  }

  private save(message?: string): void {
    this.normalizeSnackBudget();
    this.repository.save(this.state);
    this.render();
    if (message) this.showToast(message);
  }

  private render(): void {
    const brand = `<div class="wordmark"><span class="brandmark">${icon("NotebookTabs")}</span><span><b>AI</b>foodpal</span></div>`;
    this.root.innerHTML = `<div class="shell"><aside class="side">${brand}${this.nav()}<div class="sidebottom">${icon("ShieldCheck")}<span>Private by default.<br>Stored in this browser.</span></div></aside><main class="main"><header class="top">${brand}<div class="top-actions">${this.account ? `<div class="account-host" data-account-header>${this.account.headerHtml()}</div>` : ""}</div></header><div class="view ${this.view === "day" && !this.mealPeriod && !this.wide() ? "today-view" : ""}" data-scroll-pane>${this.content()}</div>${this.nav(true)}</main></div>${this.modalHtml()}${this.syncStatus ? `<div data-sync-modal>${this.syncModalHtml()}</div>` : ""}${this.account ? `<div data-account-modal>${this.account.modalHtml()}</div>` : ""}<div class="toast" id="toast"></div>`;
    renderIcons(this.root);
  }

  private normalizeSnackBudget(): void {
    const guide = dailyCalorieGuide(this.state.profile);
    if (this.state.prefs.protectedSnackBudgetEnabled && guide) {
      this.state.prefs.protectedSnackCalories = Math.min(this.state.prefs.protectedSnackCalories, Math.max(1, Math.floor(guide) - 1));
    }
  }

  private renderAccount(): void {
    if (!this.account) return;
    const header = this.root.querySelector<HTMLElement>("[data-account-header]");
    const modal = this.root.querySelector<HTMLElement>("[data-account-modal]");
    this.mount(header, this.account.headerHtml());
    this.mount(modal, this.account.modalHtml());
  }

  /** Replaces a host's markup only when it actually changed, so an unrelated rerender never destroys a form the visitor is using. */
  private mount(host: HTMLElement | null, markup: string): void {
    if (!host || this.mounted.get(host) === markup) return;
    this.mounted.set(host, markup);
    host.innerHTML = markup;
    renderIcons(host);
  }

  private renderSync(): void {
    if (!this.syncStatus) return;
    const settings = this.root.querySelector<HTMLElement>("[data-sync-settings]");
    const modal = this.root.querySelector<HTMLElement>("[data-sync-modal]");
    this.mount(settings, this.syncSettingsHtml());
    this.mount(modal, this.syncModalHtml());
  }

  private syncSettingsHtml(): string {
    const status = this.syncStatus!;
    const labels: Record<SyncStatus["phase"], string> = { local: "On this device", connecting: "Syncing…", migration: "Finish setup", synced: "Synced", offline: "Offline", conflict: "Sync conflict" };
    return `<button class="setting sync-setting ${status.phase}" data-sync-action="open" aria-label="Open sync details: ${html(status.message)}"><span>Cloud sync</span><span class="tiny">${icon(status.phase === "synced" ? "Check" : "DatabaseBackup")}${labels[status.phase]}</span></button>`;
  }

  private syncModalHtml(): string {
    if (!this.syncOpen || !this.syncStatus) return "";
    const status = this.syncStatus;
    const close = `<button class="close" data-sync-action="close" aria-label="Close sync details">${icon("X")}</button>`;
    let body = `<div class="sync-summary"><span>${icon("DatabaseBackup")}</span><div><strong>${html(status.message)}</strong><small>${status.revision ? `Cloud revision ${status.revision}` : "Your browser copy stays available."}</small></div></div>`;
    if (status.phase === "migration") body += `<p class="sync-copy">This account has no cloud daybook yet. Upload the data already on this device so it can become the account’s first cloud copy? After it is safely uploaded, the signed-out local copy will be cleared.</p><div class="mfooter"><button class="btn" data-sync-action="decline">Not now</button><button class="btn-primary" data-sync-action="migrate">Use this device’s daybook</button></div>`;
    if (status.phase === "conflict") body += `<p class="sync-copy">Another device saved after this one last loaded. Choose the cloud copy, or explicitly replace it with the complete copy currently on this device.</p><div class="mfooter"><button class="btn" data-sync-action="use-cloud">Use newer cloud copy</button><button class="btn-primary" data-sync-action="use-local">Keep this device’s copy</button></div>`;
    if (status.phase === "offline") body += `<p class="sync-copy">You can keep logging. Changes are cached locally and will retry when the connection returns.</p><div class="mfooter"><button class="btn-primary" data-sync-action="retry">Try again</button></div>`;
    return `<div class="modalback show sync-backdrop" data-sync-action="backdrop"><div class="modal sync-modal" role="dialog" aria-modal="true" aria-labelledby="sync-title"><div class="modalin"><div class="mhead"><div><div id="sync-title">Cloud sync</div><div class="tiny">Revision-safe account storage</div></div>${close}</div>${body}</div></div>`;
  }

  private nav(bottom = false): string {
    const items: [View, string, Parameters<typeof icon>[0]][] = [["day", "Today", "CalendarDays"], ["calendar", "History", "CalendarRange"], ["library", "Library", "BookOpen"], ["trend", "Progress", "ChartNoAxesColumnIncreasing"], ["settings", "Settings", "Settings"]];
    const buttons = items.map(([id, label, glyph]) => `<button class="nav ${this.view === id ? "active" : ""}" data-action="view" data-view="${id}">${icon(glyph)}<span>${label}</span></button>`).join("");
    return bottom ? `<nav class="bottom">${buttons}</nav>` : `<nav class="sidenav">${buttons}</nav>`;
  }

  /** True when the viewport has room for the desktop diary; false on phones and wherever matchMedia is unavailable. */
  private wide(): boolean {
    return this.wideQuery?.matches === true;
  }

  private content(): string {
    if (!this.state.profile.onboardingComplete) return this.onboarding();
    if (this.view === "day" && this.mealPeriod && !this.wide()) return this.mealView(this.mealPeriod);
    if (this.view === "calendar") return this.calendar();
    if (this.view === "library") return this.library();
    if (this.view === "trend") return this.trend();
    if (this.view === "settings") return this.settings();
    return this.wide() ? this.dayDesktop() : this.day();
  }

  private calendar(): string {
    const today = isoDate();
    const trend = calorieTrend(this.state, today);
    const days = calendarGrid(this.calendarMonth);
    const monthEntries = this.state.entries.filter((entry) => entry.date.startsWith(this.calendarMonth));
    const activeDays = new Set(monthEntries.map((entry) => entry.date)).size;
    const monthCalories = days.filter((day) => day.inMonth).reduce((sum, day) => sum + totalsFor(this.state, day.date).calories, 0);
    const cells = days.map((day) => {
      const entries = this.state.entries.filter((entry) => entry.date === day.date);
      const totals = totalsFor(this.state, day.date);
      const classes = ["calendar-day", day.inMonth ? "" : "outside", entries.length ? "has-history" : "", day.date === today ? "today" : "", day.date === this.state.prefs.date ? "selected" : ""].filter(Boolean).join(" ");
      return `<button class="${classes}" data-action="open-calendar-day" data-date="${day.date}" aria-label="Open ${formatDate(day.date)}${entries.length ? `, ${entries.length} entries, ${fmt(totals.calories)} calories` : ""}"><span class="calendar-number">${day.day}</span>${entries.length ? `<span class="calendar-kcal">${fmt(totals.calories)} <small>kcal</small></span><span class="calendar-count">${entries.length} ${entries.length === 1 ? "entry" : "entries"}</span>` : `<span class="calendar-empty">—</span>`}</button>`;
    }).join("");
    return `<div class="head calendar-head"><div><span class="eyebrow">Saved diary</span><h1 class="title">Calendar history</h1><p class="subtitle">Every logged day stays available on this device.</p></div><div class="calendar-controls"><button class="icon-btn" data-action="calendar-month" data-months="-1" aria-label="Previous month">${icon("ChevronLeft")}</button><button class="today-btn" data-action="calendar-today">Today</button><button class="icon-btn" data-action="calendar-month" data-months="1" aria-label="Next month">${icon("ChevronRight")}</button></div></div><section class="calendar-layout"><div class="calendar-card card"><div class="calendar-month-title"><strong>${formatMonth(this.calendarMonth)}</strong><span>${activeDays} active ${activeDays === 1 ? "day" : "days"}</span></div><div class="calendar-weekdays">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => `<span>${day}</span>`).join("")}</div><div class="calendar-grid">${cells}</div></div><aside class="history-summary"><span class="history-summary-icon">${icon("CalendarRange")}</span><span class="eyebrow">This month</span><strong>${fmt(monthCalories)}</strong><span>calories logged · ${monthEntries.length} ${monthEntries.length === 1 ? "entry" : "entries"}</span><div class="history-stat featured"><b>${fmt(trend.activeDayAverage.average)}</b><span>avg kcal / active day<br>${trend.activeDayAverage.activeDays} ${trend.activeDayAverage.activeDays === 1 ? "day" : "days"} total</span></div><div class="history-stat"><b>${fmt(trend.week.average)}</b><span>7-day avg<br>${trend.week.activeDays} active ${trend.week.activeDays === 1 ? "day" : "days"}</span></div><div class="history-stat"><b>${fmt(trend.month.average)}</b><span>30-day avg<br>${trend.month.activeDays} active ${trend.month.activeDays === 1 ? "day" : "days"}</span></div><p>Averages exclude unlogged days instead of treating them as zero.</p></aside></section>`;
  }

  private day(): string {
    const date = this.state.prefs.date;
    const totals = totalsFor(this.state, date);
    const guide = dailyCalorieGuide(this.state.profile);
    const targets = nutritionTargets(this.state.profile);
    const pct = guide ? Math.min(100, totals.calories / guide * 100) : 0;
    const meals = PERIODS.map((period) => this.meal(period, date)).join("");
    const remaining = guide ? Math.max(0, guide - totals.calories) : null;
    const snackTotal = totalsFor(this.state, date, "snacks").calories;
    const snackProtected = Boolean(guide && this.state.prefs.protectedSnackBudgetEnabled);
    const budget = guide ? protectedSnackBudget(guide, snackProtected ? this.state.prefs.protectedSnackCalories : guide / 4, totals.calories - snackTotal) : null;
    const budgetWarning = snackProtected && budget?.encroachmentCalories
      ? `<div class="today-warning">${fmt(budget.encroachmentCalories)} protected snack kcal used by main meals</div>`
      : "";
    const guideLine = guide ? `${fmt(totals.calories)} of ${fmt(guide)} kcal` : `${fmt(totals.calories)} kcal logged`;
    return `<div class="today-screen"><div class="today-date"><button class="icon-btn" data-action="date" data-days="-1" aria-label="Previous day">${icon("ChevronLeft")}</button><h1>${formatDate(date, true)}</h1><button class="icon-btn" data-action="date" data-days="1" aria-label="Next day">${icon("ChevronRight")}</button><button class="today-btn" data-action="today">Today</button></div><section class="today-hero" aria-label="Daily nutrition summary"><div class="today-remaining"><strong>${remaining == null ? "—" : fmt(remaining)}</strong><span>kcal remaining</span></div><div class="today-progress" role="progressbar" aria-label="${guideLine}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${fmt(pct)}"><span style="width:${pct}%"></span></div><div class="today-progress-label">${guideLine}</div>${budgetWarning}<div class="macros">${this.macro("protein", totals.proteinG, targets?.proteinG)}${this.macro("carbs", totals.carbsG, targets?.carbsG)}${this.macro("fat", totals.fatG, targets?.fatG)}${this.macro("fiber", totals.fiberG, targets?.fiberG)}</div></section><div class="today-meals" aria-label="Meals">${meals}</div><button class="btn-primary btn-icon today-add" data-action="choose-food">${icon("Plus")}<span>Add food</span></button></div>`;
  }

  /** The diary that shipped before SHEL-01, kept for viewports with room to show entries inline. */
  private dayDesktop(): string {
    const date = this.state.prefs.date;
    const totals = totalsFor(this.state, date);
    const guide = dailyCalorieGuide(this.state.profile);
    const targets = nutritionTargets(this.state.profile);
    const pct = guide ? Math.min(100, totals.calories / guide * 100) : 0;
    const meals = PERIODS.map((period) => this.mealGroup(period, date)).join("");
    const remaining = guide ? Math.max(0, guide - totals.calories) : null;
    const snackTotal = totalsFor(this.state, date, "snacks").calories;
    const snackProtected = Boolean(guide && this.state.prefs.protectedSnackBudgetEnabled);
    const budget = guide ? protectedSnackBudget(guide, snackProtected ? this.state.prefs.protectedSnackCalories : guide / 4, totals.calories - snackTotal) : null;
    const mainSegmentWidth = budget ? budget.mainPercent / 3 : 25;
    const snackSegmentWidth = budget ? 100 - budget.mainPercent : 25;
    const segmentCalories = guide && budget ? [budget.mainCalories / 3, budget.mainCalories / 3, budget.mainCalories / 3, budget.snackCalories] : [];
    const segmentLabels = PERIODS.map((period, index) => `<span class="scale-segment ${period}" style="width:${period === "snacks" ? snackSegmentWidth : mainSegmentWidth}%"><strong>${period}</strong>${guide ? `<small>${fmt(segmentCalories[index])} kcal</small>` : ""}</span>`).join("");
    const overrun = snackProtected && budget?.encroachmentCalories ? `<span class="scale-overrun" style="left:${budget.mainPercent}%;width:${budget.encroachmentPercent}%" aria-label="Main meals used ${fmt(budget.encroachmentCalories)} protected snack calories"></span>` : "";
    const budgetWarning = snackProtected && budget?.encroachmentCalories ? `<span class="budget-warning">${fmt(budget.encroachmentCalories)} protected snack kcal used by main meals</span>` : "";
    return `<div class="page-intro"><div><span class="eyebrow">Daily diary</span><h1>${formatDate(date, true)}</h1></div><div class="datebar"><button class="icon-btn" data-action="date" data-days="-1" aria-label="Previous day">${icon("ChevronLeft")}</button><button class="today-btn" data-action="today">Today</button><button class="icon-btn" data-action="date" data-days="1" aria-label="Next day">${icon("ChevronRight")}</button></div></div><section class="card summary"><div class="summary-top"><div><div class="summary-label">Calories logged</div><div class="guide"><span class="big">${fmt(totals.calories)}</span><span>${guide ? `of ${fmt(guide)} kcal` : "kcal"}</span></div></div><div class="summary-actions"><button class="btn btn-icon" data-action="open-quick">${icon("Gauge")}<span>Quick Add</span></button><button class="btn-primary btn-icon" data-action="choose-food">${icon("Plus")}<span>Add food</span></button></div></div><div class="calorie-scale" aria-label="${fmt(pct)} percent of calorie guide"><div class="scale-track"><div class="scale-sections">${segmentLabels}</div><div class="scale-fill" style="width:${pct}%"></div>${overrun}<span class="scale-flame" style="left:${pct}%">${icon("Flame")}</span></div><div class="scale-labels">${segmentLabels}</div></div><div class="summary-note">${remaining == null ? "Add your baseline to create a daily guide." : `<strong>${fmt(remaining)}</strong> kcal remaining today${budgetWarning}`}</div><div class="macros">${this.macroColumn("protein", totals.proteinG, targets?.proteinG)}${this.macroColumn("carbs", totals.carbsG, targets?.carbsG)}${this.macroColumn("fat", totals.fatG, targets?.fatG)}${this.macroColumn("fiber", totals.fiberG, targets?.fiberG)}</div></section><div class="section-heading"><span>Meals</span><span>${this.state.entries.filter((entry) => entry.date === date).length} entries</span></div>${meals}`;
  }

  /** The wide macro column: an icon, the gram figure, and its target. The phone dashboard uses the compact `macro` bar instead. */
  private macroColumn(label: string, value: number | null, target?: number): string {
    const pct = target && value != null ? Math.min(100, value / target * 100) : 0;
    const glyph: Record<string, Parameters<typeof icon>[0]> = { protein: "Dumbbell", carbs: "Wheat", fat: "Droplets", fiber: "Leaf" };
    return `<div class="macro ${label}"><span class="macro-icon">${icon(glyph[label] ?? "Gauge")}</span><div class="macro-content"><div class="k">${label}</div><div class="v">${fmt(value, 1)} <small>g</small></div>${target ? `<div class="macro-target">of ${fmt(target)} g</div>` : ""}<div class="macroline"><div style="width:${pct}%"></div></div></div></div>`;
  }

  /** A wide-layout meal card that lists its entries inline; the protected-snack control stays in Settings. */
  private mealGroup(period: Period, date: string): string {
    const entries = this.state.entries.filter((entry) => entry.date === date && entry.period === period);
    const total = totalsFor(this.state, date, period);
    const glyph: Record<Period, Parameters<typeof icon>[0]> = { breakfast: "Coffee", lunch: "Sun", dinner: "Moon", snacks: "Apple" };
    return `<section class="mealgroup card ${entries.length ? "has-entries" : ""}" data-period="${period}"><div class="mealhead"><div class="mealidentity"><span class="meal-period-icon ${period}">${icon(glyph[period])}</span><div><div class="meal-label">Meal</div><div class="mealname">${period}</div><div class="mealsum">${fmt(total.calories)} kcal · ${fmt(total.proteinG, 1)}p · ${fmt(total.carbsG, 1)}c · ${fmt(total.fatG, 1)}f</div></div></div><button class="icon-btn subtle" data-action="choose-food" data-period="${period}" aria-label="Add ${period}">${icon("Plus")}</button></div><div class="entrylist">${entries.map((entry) => this.entryHtml(entry)).join("")}</div></section>`;
  }

  private macro(label: string, value: number | null, target?: number): string {
    const pct = target && value != null ? Math.min(100, value / target * 100) : 0;
    const short: Record<string, string> = { protein: "P", carbs: "C", fat: "F", fiber: "Fi" };
    return `<div class="macro ${label}" aria-label="${label}: ${fmt(value, 1)} of ${target ? fmt(target) : "unknown"} grams"><span class="macro-key">${short[label] ?? label}</span><div class="macro-content"><div class="macro-values"><strong>${fmt(value, 1)}</strong><span>/${target ? fmt(target) : "—"} g</span></div><div class="macroline"><div style="width:${pct}%"></div></div></div></div>`;
  }

  private meal(period: Period, date: string): string {
    const total = totalsFor(this.state, date, period);
    const glyph: Record<Period, Parameters<typeof icon>[0]> = { breakfast: "Coffee", lunch: "Sun", dinner: "Moon", snacks: "Apple" };
    const calories = total.calories > 0 ? `${fmt(total.calories)} kcal` : "—";
    return `<button class="meal-row" data-action="open-meal" data-period="${period}" aria-label="Open ${period}, ${calories}"><span class="meal-period-icon ${period}">${icon(glyph[period])}</span><span class="mealname">${period}</span><span class="mealsum">${calories}</span>${icon("ChevronRight")}</button>`;
  }

  private snackBudgetForm(): string {
    const guide = dailyCalorieGuide(this.state.profile);
    const snackBudgetMax = guide ? `max="${Math.max(1, Math.floor(guide) - 1)}"` : "";
    return `<form class="snack-budget card" data-form="snack-budget"><label class="snack-budget-toggle"><input type="checkbox" name="enabled" ${this.state.prefs.protectedSnackBudgetEnabled ? "checked" : ""}><span><strong>Protect snack calories</strong><small>Warn when main meals use this reserve.</small></span></label><label class="snack-budget-amount"><span>Save</span><input type="number" name="calories" min="1" ${snackBudgetMax} step="1" inputmode="numeric" value="${this.state.prefs.protectedSnackCalories}" aria-label="Calories to save for snacks"><span>kcal</span></label><button class="tiny-btn" type="submit">Save</button></form>`;
  }

  /** Preserve access to existing entries until UX-06 replaces this compatibility meal view. */
  private mealView(period: Period): string {
    const date = this.state.prefs.date;
    const entries = this.state.entries.filter((entry) => entry.date === date && entry.period === period);
    const total = totalsFor(this.state, date, period);
    return `<div class="meal-view"><div class="meal-view-head"><button class="icon-btn" data-action="back-today" aria-label="Back to Today">${icon("ChevronLeft")}</button><h1>${period}</h1><span>${fmt(total.calories)} kcal</span></div><section class="meal-view-list card" data-period="${period}"><div class="entrylist">${entries.map((entry) => this.entryHtml(entry)).join("")}</div>${entries.length ? "" : `<div class="empty">Nothing logged for ${period}.</div>`}</section><button class="btn-primary btn-icon meal-view-add" data-action="choose-food" data-period="${period}">${icon("Plus")}<span>Add to ${period}</span></button></div>`;
  }

  private entryHtml(entry: AppState["entries"][number]): string {
    const loggedQuantity = formatQuantity(entry.servingSnapshot.amount * entry.servings, entry.servingSnapshot.unit);
    const summary = `<button class="drag-handle" data-drag-handle aria-label="Drag ${html(entry.nameSnapshot)} to reorder">${icon("GripVertical")}</button><div class="food-icon ${entry.recipeSnapshot ? "recipe" : ""}">${icon(entry.recipeSnapshot ? "ChefHat" : "Utensils")}</div><div class="entrymain"><div class="ename">${html(entry.nameSnapshot)}${entry.recipeSnapshot ? `<span class="recipe-badge">Recipe</span>` : ""}</div><div class="esub">${html(loggedQuantity)}${entry.recipeSnapshot ? ` · ${entry.recipeSnapshot.ingredients.length} components` : ""}</div></div><div class="entrymacro">${this.macroBar(entry.nutritionSnapshot.proteinG, entry.nutritionSnapshot.carbsG, entry.nutritionSnapshot.fatG)}</div><span class="ekcal">${fmt(entry.nutritionSnapshot.calories * entry.servings)} <small>kcal</small></span><button class="icon-btn danger" data-action="delete-entry" data-id="${entry.id}" aria-label="Remove ${html(entry.nameSnapshot)}">${icon("Trash2")}</button>`;
    if (!entry.recipeSnapshot) return `<div class="entry-shell" data-entry-id="${entry.id}"><div class="entry">${summary}</div></div>`;
    const ingredients = entry.recipeSnapshot.ingredients.map((ingredient) => {
      const amount = ingredient.amount == null ? "" : fmt(ingredient.amount * entry.servings, 2);
      const nutrient = ingredient.nutrition;
      const macros = [[nutrient.calories, "kcal"], [nutrient.proteinG, "p"], [nutrient.carbsG, "c"], [nutrient.fatG, "f"]].filter(([value]) => value !== null).map(([value, label]) => `${fmt((value as number) * entry.servings, 1)}${label}`).join(" · ");
      return `<li><span>${html([amount, ingredient.unit, ingredient.name].filter(Boolean).join(" "))}</span><span>${macros}</span></li>`;
    }).join("");
    return `<div class="entry-shell" data-entry-id="${entry.id}"><details class="recipe-entry"><summary class="entry">${summary}</summary><div class="recipe-entry-body"><div class="recipe-caption">Components for ${html(loggedQuantity)}</div><ul>${ingredients || "<li><span>No ingredients listed</span></li>"}</ul>${entry.recipeSnapshot.instructions ? `<div class="recipe-instructions"><strong>Instructions</strong><p>${html(entry.recipeSnapshot.instructions).replaceAll("\n", "<br>")}</p></div>` : ""}</div></details></div>`;
  }

  private moveEntry(entryId: string, period: Period, index: number): void {
    this.state.entries = moveDiaryEntry(this.state.entries, entryId, period, index);
    this.repository.save(this.state);
  }

  private macroBar(protein: number | null, carbs: number | null, fat: number | null): string {
    if (protein === null && carbs === null && fat === null) return `<div class="macro-unknown">Macros unknown</div>`;
    return `<div class="entry-macros"><span class="p"><b>${fmt(protein, 1)}g</b><small>protein</small></span><span class="c"><b>${fmt(carbs, 1)}g</b><small>carbs</small></span><span class="f"><b>${fmt(fat, 1)}g</b><small>fat</small></span></div>`;
  }

  private library(): string {
    const foods = [...this.state.foods].sort((a, b) => searchKey(a.name).localeCompare(searchKey(b.name)) || searchKey(a.brand ?? "").localeCompare(searchKey(b.brand ?? "")) || a.id.localeCompare(b.id));
    const cards = foods.map((food) => {
      const metadata = [food.brand?.trim(), food.serving.description, `${fmt(food.nutrition.calories)} kcal`, food.recipe ? `${food.recipe.ingredients.length} ingredients` : null].filter(Boolean).map((part) => html(part)).join(" · ");
      const searchable = searchKey([food.name, food.brand, food.serving.description].filter(Boolean).join(" "));
      return `<div class="library-card" data-library-card data-search="${html(searchable)}"><div class="library-symbol">${icon(food.recipe ? "ChefHat" : "Utensils")}</div><div class="grow"><div class="library-name">${html(food.name)}${food.recipe ? `<span class="recipe-badge">Recipe</span>` : ""}</div><div class="tiny library-meta">${metadata}</div></div><div class="row library-actions"><button class="tiny-btn btn-icon" data-action="log" data-id="${food.id}">${icon("Plus")}<span>Log</span></button><button class="icon-btn subtle" data-action="edit-food" data-id="${food.id}" aria-label="Edit ${html(food.name)}">${icon("Pencil")}</button><button class="icon-btn danger" data-action="request-delete-food" data-id="${food.id}" aria-label="Delete ${html(food.name)} from library">${icon("Trash2")}</button></div></div>`;
    }).join("");
    const count = foods.length === 1 ? "1 food" : `${foods.length} foods`;
    const search = foods.length ? `<div class="library-tools"><div class="library-search">${icon("Search")}<label class="sr-only" for="food-library-search">Search saved foods</label><input id="food-library-search" class="library-search-input" data-library-search type="search" placeholder="Search foods, brands, or servings" autocomplete="off"><button class="library-search-clear" type="button" data-action="clear-library-search" aria-label="Clear food search" hidden>${icon("X")}</button></div><span class="library-count" data-library-count aria-live="polite">${count}</span></div>` : "";
    const noResults = `<div class="empty library-no-results" data-library-empty hidden><strong>No matching foods</strong><span>Try a food name, brand, or serving.</span></div>`;
    return `<div class="head"><div><span class="eyebrow">Saved foods</span><h1 class="title">Food library</h1><p class="subtitle">Reusable foods and portions, ready for your next meal.</p></div><div class="head-actions"><button class="btn btn-icon" data-action="build-combo" ${this.state.foods.length < 2 ? "disabled" : ""}>${icon("ListPlus")}<span>Build combo</span></button><button class="btn-primary btn-icon" data-action="new-food">${icon("Plus")}<span>New food</span></button></div></div>${search}${cards ? `<div class="library-list">${cards}</div>${noResults}` : `<div class="empty empty-rich"><span class="empty-icon">${icon("BookOpen")}</span><strong>Your library is ready</strong><span>Create a food here, or ask an AI to structure your first meal.</span><button class="btn-primary btn-icon" data-action="new-food">${icon("Plus")}<span>Create food</span></button></div>`}`;
  }

  private filterLibrary(query: string): void {
    const key = searchKey(query);
    const cards = [...this.root.querySelectorAll<HTMLElement>("[data-library-card]")];
    let matches = 0;
    for (const card of cards) {
      card.hidden = Boolean(key) && !searchKey(card.dataset.search ?? "").includes(key);
      if (!card.hidden) matches += 1;
    }
    const count = this.root.querySelector<HTMLElement>("[data-library-count]");
    if (count) count.textContent = key ? `${matches} of ${cards.length} foods` : cards.length === 1 ? "1 food" : `${cards.length} foods`;
    const empty = this.root.querySelector<HTMLElement>("[data-library-empty]");
    if (empty) empty.hidden = matches !== 0;
    const clear = this.root.querySelector<HTMLButtonElement>('[data-action="clear-library-search"]');
    if (clear) clear.hidden = !key;
  }

  private trend(): string {
    const weights = [...this.state.weights].sort((a, b) => b.date.localeCompare(a.date));
    const exercises = [...this.state.exercises].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    const current = latestWeight(this.state);
    const goal = this.state.profile.goalWeightLb;
    const projection = weightProjection(this.state);
    const projectedDirection = projection && projection.weeklyChangeLb >= 0 ? "losing" : "gaining";
    const goalLine = projection?.goalDate && goal != null
      ? `At this rate, you may reach <em>${fmt(this.displayWeight(goal), 1)} ${this.weightUnit()}</em> around ${formatDate(projection.goalDate)}.`
      : goal != null ? "Your recent intake trend is not moving toward the goal yet." : "Add a goal weight to estimate a target date.";

    let chart = `<section class="trend-chart card trend-chart-empty"><div class="panel-title">${icon("ChartNoAxesColumnIncreasing")}<span>Projected weight trend</span></div><div><strong>Your line will appear here</strong><span>Log food on at least three active days to create a projection.</span></div></section>`;
    if (projection && current != null) {
      const startDate = isoDate();
      const goalDays = projection.goalDate ? Math.max(0, Math.round((parseLocalDate(projection.goalDate).getTime() - parseLocalDate(startDate).getTime()) / 86_400_000)) : 90;
      const horizonDays = Math.max(30, goalDays, 90);
      const pointDays = [...new Set([...Array.from({ length: 9 }, (_, index) => Math.round(index * horizonDays / 8)), 30, goalDays])].filter((day) => day >= 0 && day <= horizonDays).sort((a, b) => a - b);
      const weightAt = (day: number): number => current - projection.weeklyChangeLb * day / 7;
      const pointWeights = pointDays.map(weightAt);
      if (goal != null && projection.goalDate) pointWeights[pointDays.indexOf(goalDays)] = goal;
      const minWeight = Math.min(...pointWeights, goal ?? current);
      const maxWeight = Math.max(...pointWeights, goal ?? current);
      const padding = Math.max(4, (maxWeight - minWeight) * .16);
      const low = minWeight - padding;
      const high = maxWeight + padding;
      const x = (day: number): number => 55 + day / horizonDays * 890;
      const y = (weight: number): number => 18 + (high - weight) / (high - low) * 142;
      const points = pointDays.map((day, index) => `${round(x(day), 1)},${round(y(pointWeights[index]!), 1)}`).join(" ");
      const area = `55,160 ${points} 945,160`;
      const grid = [0, .5, 1].map((ratio) => { const value = high - (high - low) * ratio; const yy = 18 + 142 * ratio; return `<line x1="55" y1="${yy}" x2="945" y2="${yy}"/><text x="8" y="${yy + 4}">${fmt(this.displayWeight(value), 0)}</text>`; }).join("");
      const dots = pointDays.map((day, index) => `<circle cx="${x(day)}" cy="${y(pointWeights[index]!)}" r="${day === goalDays ? 6 : 4}" class="${day === goalDays ? "goal-dot" : ""}"/>`).join("");
      const monthWeight = this.displayWeight(projection.oneMonthWeightLb);
      const monthX = x(30);
      const monthY = y(projection.oneMonthWeightLb);
      const labels = [0, Math.round(horizonDays / 2), horizonDays].map((day) => `<text class="date-label" x="${x(day)}" y="190" text-anchor="${day === 0 ? "start" : day === horizonDays ? "end" : "middle"}">${formatDate(shiftDate(startDate, day))}</text>`).join("");
      chart = `<section class="trend-chart card"><div class="panel-title">${icon("ChartNoAxesColumnIncreasing")}<span>Projected weight trend</span></div><div class="chart-stage"><svg viewBox="0 0 1000 205" role="img" aria-label="Projected weight from ${fmt(this.displayWeight(current), 1)} ${this.weightUnit()} to ${fmt(this.displayWeight(pointWeights.at(-1)), 1)} ${this.weightUnit()}"><g class="chart-grid">${grid}</g><polygon class="chart-area" points="${area}"/><polyline class="chart-line" points="${points}"/><g class="chart-dots">${dots}</g>${labels}</svg><span class="chart-callout chart-start" style="--x:${x(0) / 10}%;--y:${y(current) / 2.05}%"><b>${fmt(this.displayWeight(current), 1)} ${this.weightUnit()}</b><small>Current</small></span><span class="chart-callout chart-month" style="--x:${monthX / 10}%;--y:${monthY / 2.05}%"><b>${fmt(monthWeight, 1)} ${this.weightUnit()}</b><small>1 month · ${formatDate(shiftDate(startDate, 30))}</small></span>${goal != null && projection.goalDate ? `<span class="chart-callout chart-goal" style="--x:${x(goalDays) / 10}%;--y:${y(goal) / 2.05}%"><b>${fmt(this.displayWeight(goal), 1)} ${this.weightUnit()}</b><small>Goal · ${formatDate(projection.goalDate)}</small></span>` : ""}</div></section>`;
    }

    const oldestWeight = weights.at(-1)?.weightLb ?? current;
    const goalSpan = oldestWeight != null && goal != null ? Math.abs(oldestWeight - goal) : 0;
    const goalProgress = goalSpan && current != null ? Math.max(0, Math.min(100, Math.abs(oldestWeight! - current) / goalSpan * 100)) : 0;
    const remaining = current != null && goal != null ? Math.abs(current - goal) : null;
    const goalBand = `<section class="goal-band card"><div class="goal-weight current"><span class="goal-icon">${icon("Weight")}</span><span><b>${fmt(this.displayWeight(current), 1)} <small>${this.weightUnit()}</small></b><small>Current weight</small></span></div><div class="goal-ring" style="--progress:${goalProgress * 3.6}deg"><b>${fmt(goalProgress)}%</b><small>toward goal</small></div><div class="goal-weight"><span class="goal-icon target">${icon("Target")}</span><span><b>${fmt(this.displayWeight(goal), 1)} <small>${this.weightUnit()}</small></b><small>Goal weight</small></span></div><div class="goal-remaining"><b>${fmt(this.displayWeight(remaining), 1)} ${this.weightUnit()} to go</b><span><i style="width:${goalProgress}%"></i></span></div></section>`;
    const forecast = projection ? `<section class="forecast card"><div class="forecast-copy"><span class="eyebrow">Your current pace</span><h2>${goalLine}</h2><p>Based on ${projection.activeDays} active food-log ${projection.activeDays === 1 ? "day" : "days"} across the last ${projection.spanDays} ${projection.spanDays === 1 ? "day" : "days"}.</p></div><div class="forecast-kpis"><div class="forecast-kpi intake"><span>${icon("Flame")}</span><b>${fmt(projection.averageIntake)}</b><small>avg kcal eaten</small></div><div class="forecast-kpi exercise"><span>${icon("Dumbbell")}</span><b>${fmt(projection.averageExercise)}</b><small>exercise kcal/day</small></div><div class="forecast-kpi pace"><span>${icon("ChartNoAxesColumnIncreasing")}</span><b>${fmt(Math.abs(this.displayWeight(projection.weeklyChangeLb) ?? 0), 2)}</b><small>${this.weightUnit()}/week ${projectedDirection}</small></div><div class="forecast-kpi date"><span>${icon("CalendarRange")}</span><b>${projection.goalDate ? formatDate(projection.goalDate) : "—"}</b><small>estimated goal date</small></div></div><p class="forecast-note">A planning estimate—not a promise. Food portions, workout effort, metabolism, and water weight can move the result.</p></section>` : `<section class="forecast card forecast-empty"><span class="eyebrow">Your current pace</span><h2>Keep logging to unlock a forecast</h2><p>Add baseline details in Settings and log meals on a few active days.</p></section>`;
    const weightRows = weights.length ? weights.slice(0, 5).map((weight) => `<div class="progress-row"><span class="history-dot"></span><span><b>${formatDate(weight.date)}</b><small>${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(weight.createdAt))}</small></span><strong>${fmt(this.displayWeight(weight.weightLb), 1)} ${this.weightUnit()}</strong><span class="row-arrow">${icon("ChevronRight")}</span></div>`).join("") : `<div class="empty compact-empty">No check-ins yet.</div>`;
    const exerciseRows = exercises.length ? exercises.slice(0, 5).map((entry) => `<div class="progress-row exercise-row"><span class="exercise-symbol">${icon("Dumbbell")}</span><span><b>${formatDate(entry.date)}</b><small>${html(EXERCISE_LABELS[entry.kind])} · ${fmt(entry.minutes)} min</small></span><strong>~${fmt(current ? exerciseCalories(entry.kind, entry.minutes, current) : null)} kcal</strong><span class="row-arrow">${icon("ChevronRight")}</span></div>`).join("") : `<div class="empty compact-empty">No exercise logged yet. A short dumbbell session or walk still counts.</div>`;
    return `<div class="progress-page"><div class="head"><div><span class="eyebrow">Your trend</span><h1 class="title">Progress</h1><p class="subtitle">Small check-ins make the longer pattern visible.</p></div><div class="progress-actions"><button class="btn btn-icon" data-action="open-exercise" aria-label="Add exercise">${icon("Dumbbell")}<span>Add exercise</span></button><button class="btn-primary btn-icon" data-action="open-weight" aria-label="Check in weight">${icon("Weight")}<span>Check in</span></button></div></div>${forecast}${chart}${goalBand}<div class="progress-history"><section class="progress-panel card"><div class="panel-title">${icon("ChartNoAxesColumnIncreasing")}<span>Weight history</span></div>${weightRows}</section><section class="progress-panel card"><div class="panel-title">${icon("Dumbbell")}<span>Recent exercise</span></div>${exerciseRows}</section></div></div>`;
  }

  private settings(): string {
    const profile = this.state.profile;
    const guidance = calorieGuidance(profile);
    const sync = this.syncStatus ? `<span class="sync-settings-host" data-sync-settings>${this.syncSettingsHtml()}</span>` : "";
    return `<div class="head"><div><span class="eyebrow">Preferences</span><h1 class="title">Settings</h1><p class="subtitle">Plan, portability, and privacy.</p></div></div><form data-form="settings" class="card pad stack"><div class="two">${field("daily calorie guide", "manualDailyGuide", profile.manualDailyGuide ?? "", "number", "min=500 placeholder=automatic")}${field(`goal weight (${this.weightUnit()})`, "goalWeight", this.displayWeight(profile.goalWeightLb) ?? "", "number", "step=.1")}${field("weekly pace (lb)", "rateLbWeek", profile.rateLbWeek, "number", "min=0 step=.25")}</div>${activityField(profile.activityPAL)}<label class="field"><span>goal</span><select name="goalType"><option value="lose" ${profile.goalType === "lose" ? "selected" : ""}>lose</option><option value="maintain" ${profile.goalType === "maintain" ? "selected" : ""}>maintain</option><option value="gain" ${profile.goalType === "gain" ? "selected" : ""}>gain</option></select></label><div class="notice">${guidance.ok ? `Automatic estimate: ${fmt(guidance.target)} kcal/day${guidance.weeks ? ` · roughly ${fmt(guidance.weeks)} weeks` : ""}.` : html(guidance.reason)}</div><button class="btn-primary" type="submit">save plan</button></form><section class="section"><p class="label">snack plan</p>${this.snackBudgetForm()}</section><section class="section"><p class="label">services & data</p><div class="card settings"><button class="setting" data-action="open-ai"><span>AI bridge</span><span class="tiny">copy / paste</span></button>${sync}<button class="setting" data-action="open-backup"><span>backup & restore</span><span class="tiny">portable JSON</span></button><button class="setting" data-action="onboard"><span>edit baseline</span><span class="tiny">profile setup</span></button></div></section>`;
  }

  private onboarding(): string {
    const p = this.state.profile;
    return `<div class="onboard onboard-inline"><div class="otop"><div class="wordmark"><span class="brandmark">${icon("NotebookTabs")}</span><span><b>AI</b>foodpal</span></div></div><div class="ocontent"><form data-form="onboarding"><h1 class="otitle">A small private record of your day.</h1><p class="ocopy">These basics create a starting guide. Nothing leaves this browser unless you export or copy it.</p><div class="two">${field("age", "age", p.age ?? "", "number", "min=18 max=120 required")}${field("height (inches)", "heightIn", p.heightIn ?? "", "number", "min=36 step=.1 required")}${field("current weight (lb)", "weightLb", p.weightLb ?? "", "number", "min=50 step=.1 required")}${field("goal weight (lb)", "goalWeightLb", p.goalWeightLb ?? "", "number", "min=50 step=.1")}</div><label class="field"><span>sex used by energy equation</span><select name="sex" required><option value="">choose</option><option value="female" ${p.sexForEquation === "female" ? "selected" : ""}>female</option><option value="male" ${p.sexForEquation === "male" ? "selected" : ""}>male</option></select></label>${activityField(p.activityPAL, "activity")}<div class="notice">This is a planning aid, not medical advice.</div><div class="oactions"><span></span><button class="btn-primary">enter AIfoodpal</button></div></form></div></div></div>`;
  }

  private modalHtml(): string {
    if (!this.modal) return "";
    let body = "";
    if (this.modal.kind === "food") body = this.foodForm(this.modal);
    if (this.modal.kind === "combo") body = this.comboForm(this.modal.error);
    if (this.modal.kind === "quick") body = this.quickCalorieForm(this.modal);
    if (this.modal.kind === "choose") body = `<div class="mhead"><div>choose a food</div>${this.close()}</div><div class="stack">${this.state.foods.map((food) => `<button class="searchitem" data-action="log" data-id="${food.id}"><span><span>${html(food.name)}</span><span class="tiny">${html(food.brand || food.serving.description)}</span></span><span>${fmt(food.nutrition.calories)} kcal</span></button>`).join("")}<button class="btn" data-action="new-food">create a new food</button></div>`;
    if (this.modal.kind === "log") body = this.logForm(this.modal.food, this.modal.period);
    if (this.modal.kind === "delete-food") body = `<div class="mhead"><div>Delete saved food?</div>${this.close()}</div><div class="delete-confirm"><span class="delete-confirm-icon">${icon("Trash2")}</span><div><strong>${html(this.modal.food.name)}</strong><p>This removes it from your food library. Diary entries you already logged will stay intact.</p></div></div><div class="mfooter"><button class="btn" data-action="close">Cancel</button><button class="btn-danger btn-icon" data-action="confirm-delete-food" data-id="${this.modal.food.id}">${icon("Trash2")}<span>Delete food</span></button></div>`;
    if (this.modal.kind === "weight") body = `<form data-form="weight"><div class="mhead"><div>weight check-in</div>${this.close()}</div>${field(`weight (${this.weightUnit()})`, "weight", this.displayWeight(latestWeight(this.state)) ?? "", "number", "min=1 step=.1 required")}${field("date", "date", this.state.prefs.date, "date", "required")}<div class="mfooter"><button class="btn-primary">save</button></div></form>`;
    if (this.modal.kind === "exercise") body = `<form data-form="exercise"><div class="mhead"><div>add exercise</div>${this.close()}</div><div class="stack"><label class="field"><span>activity</span><select name="kind">${(Object.entries(EXERCISE_LABELS) as [ExerciseKind, string][]).map(([kind, label]) => `<option value="${kind}">${label}</option>`).join("")}</select></label>${field("minutes", "minutes", 20, "number", "min=1 max=600 step=1 required")}${field("date", "date", isoDate(), "date", "required")}<div class="notice">Calories are estimated from broad activity intensity and your latest weight. Log the workout even when it feels small—the trend matters more than precision.</div></div><div class="mfooter"><button class="btn-primary btn-icon">${icon("Dumbbell")}<span>add exercise</span></button></div></form>`;
    if (this.modal.kind === "backup") body = `<div class="mhead"><div>backup & restore</div>${this.close()}</div><div class="stack"><button class="btn" data-action="download">download backup</button><button class="btn" data-action="copy-backup">copy backup</button><form data-form="restore"><label class="field"><span>paste an AIfoodpal backup</span><textarea class="code" name="backup" required></textarea></label><div class="notice warn">Restore replaces this browser's current copy.</div><div class="mfooter"><button class="btn-primary">restore</button></div></form></div>`;
    if (this.modal.kind === "ai") body = this.aiModal(this.modal);
    return `<div class="modalback show" data-action="backdrop"><div class="modal"><div class="modalin">${body}</div></div></div>`;
  }

  private close(): string { return `<button class="close" data-action="close" aria-label="Close">${icon("X")}</button>`; }

  private foodForm(modal: FoodModal): string {
    const food = modal.draft ?? modal.food;
    const n = food?.nutrition;
    const recipe = food?.recipe;
    const ingredients = recipe?.ingredients ?? [];
    const busy = Boolean(modal.capturing);
    return `<form data-form="food" data-id="${modal.food?.id ?? ""}"><div class="mhead"><div>${modal.food ? "edit food" : "new food"}</div>${this.close()}</div><section class="ai-assist"><div class="ai-assist-head"><span class="ai-assist-icon">${icon("Sparkles")}</span><div><strong>Add it without typing</strong><div>Point the camera at a barcode or label, at the food itself, or just describe it below.</div></div></div><div class="ai-actions"><button class="btn btn-icon" type="button" data-action="capture" data-mode="label" ${busy ? "disabled" : ""}>${icon("ScanText")}<span>Scan a package</span></button><button class="btn btn-icon" type="button" data-action="capture" data-mode="estimate" ${busy ? "disabled" : ""}>${icon("Camera")}<span>Estimate this plate</span></button></div><label class="field ai-note"><span>describe it, or add anything worth knowing</span><textarea id="ai-food-note" name="captureNote" rows="2" maxlength="${NOTE_MAX_CHARS}" placeholder="I made this — it's lamb, not beef, and it was on the fatty side">${html(modal.captureNote ?? "")}</textarea></label><button class="btn-primary ai-describe btn-icon" type="button" data-action="describe" ${busy ? "disabled" : ""}>${icon("Sparkles")}<span>Describe it — no photo</span></button><div class="ai-paste-help">Sent with a photo, the description beats the picture when they disagree. On its own, it is all the AI reads.</div><input type="file" accept="image/*" capture="environment" data-capture-input="label" hidden><input type="file" accept="image/*" data-capture-input="estimate" hidden>${busy ? `<div class="notice">${icon("Sparkles")}Reading your ${modal.capturing === "label" ? "label" : modal.capturing === "describe" ? "description" : "photo"}…</div>` : ""}${modal.aiMessage ? `<div class="notice success">${icon("Check")}${html(modal.aiMessage)}</div>` : ""}${modal.aiError ? `<div class="notice warn">${html(modal.aiError)}</div>` : ""}</section><div class="two">${field("food name", "name", food?.name ?? "", "text", "required placeholder='Cream cheese'")}${field("brand", "brand", food?.brand ?? "", "text")}${field("serving amount", "servingAmount", food?.serving?.amount ?? 1, "number", "min=.0001 step=any required")}${field("serving unit", "servingUnit", food?.serving?.unit ?? "serving", "text", "list=measurement-units required placeholder='tbsp, cup, g…'")}${field("calories", "calories", n?.calories ?? 0, "number", "min=0 required")}${field("protein (g)", "proteinG", n?.proteinG ?? "", "number", "min=0 step=.1")}${field("carbs (g)", "carbsG", n?.carbsG ?? "", "number", "min=0 step=.1")}${field("fat (g)", "fatG", n?.fatG ?? "", "number", "min=0 step=.1")}${field("fiber (g)", "fiberG", n?.fiberG ?? "", "number", "min=0 step=.1")}${field("total sugar (g)", "sugarG", n?.sugarG ?? "", "number", "min=0 step=.1")}${field("added sugar (g)", "addedSugarG", n?.addedSugarG ?? "", "number", "min=0 step=.1")}${field("saturated fat (g)", "saturatedFatG", n?.saturatedFatG ?? "", "number", "min=0 step=.1")}${field("sodium (mg)", "sodiumMg", n?.sodiumMg ?? "", "number", "min=0 step=1")}</div><div class="measurement-note">Keep quantity out of the food name. The serving above can be changed whenever you log it.</div><label class="recipe-toggle"><input type="checkbox" name="isRecipe" ${recipe ? "checked" : ""}><span>${icon("ChefHat")}<b>Is this a recipe?</b><small>Add ingredients, their optional macros, and instructions.</small></span></label>${recipe ? `<section class="recipe-editor"><div class="between"><div><strong>Ingredients</strong><div class="tiny">Amounts and component macros are optional.</div></div><button class="tiny-btn btn-icon" type="button" data-action="add-ingredient">${icon("ListPlus")}<span>Add ingredient</span></button></div><div class="ingredient-list">${ingredients.map((ingredient, index) => this.ingredientFields(ingredient, index)).join("")}</div><label class="field"><span>recipe instructions (optional)</span><textarea name="instructions" placeholder="Mix, cook, portion…">${html(recipe.instructions ?? "")}</textarea></label></section>` : ""}${measurementList()}<div class="mfooter"><button class="btn-primary">save food</button></div></form>`;
  }

  private ingredientFields(ingredient: Partial<Omit<RecipeIngredient, "nutrition">> & { nutrition?: Partial<RecipeIngredient["nutrition"]> }, index: number): string {
    return `<div class="ingredient" data-ingredient="${index}"><div class="ingredient-head"><span>Ingredient ${index + 1}</span><button class="icon-btn danger" type="button" data-action="remove-ingredient" data-index="${index}" aria-label="Remove ingredient">${icon("Trash2")}</button></div><div class="ingredient-main">${field("name", `ingredientName_${index}`, ingredient.name ?? "", "text", "placeholder='e.g. black beans'")}${field("amount", `ingredientAmount_${index}`, ingredient.amount ?? "", "number", "min=0 step=any")}${field("unit", `ingredientUnit_${index}`, ingredient.unit ?? "", "text", "list=measurement-units placeholder='cup, g, tbsp'")}</div><details class="ingredient-macros"><summary>Component macros (optional)</summary><div class="four">${field("calories", `ingredientCalories_${index}`, ingredient.nutrition?.calories ?? "", "number", "min=0")}${field("protein g", `ingredientProtein_${index}`, ingredient.nutrition?.proteinG ?? "", "number", "min=0 step=.1")}${field("carbs g", `ingredientCarbs_${index}`, ingredient.nutrition?.carbsG ?? "", "number", "min=0 step=.1")}${field("fat g", `ingredientFat_${index}`, ingredient.nutrition?.fatG ?? "", "number", "min=0 step=.1")}</div></details></div>`;
  }

  private comboForm(error?: string): string {
    const rows = [...this.state.foods].sort((a, b) => a.name.localeCompare(b.name)).map((food) => `<div class="combo-row"><label class="combo-select"><input type="checkbox" name="comboFood" value="${food.id}"><span class="combo-check">${icon("Check")}</span><span class="combo-info"><strong>${html(food.name)}</strong><small>${fmt(food.nutrition.calories)} kcal per ${html(food.serving.description)}</small></span></label><span class="combo-quantity"><input aria-label="Amount of ${html(food.name)}" name="comboAmount_${food.id}" type="number" min=".0001" step="any" value="${food.serving.amount}"><input aria-label="Unit for ${html(food.name)}" name="comboUnit_${food.id}" type="text" list="measurement-units" value="${html(food.serving.unit)}"></span></div>`).join("");
    return `<form data-form="combo"><div class="mhead"><div><div>Build a saved combo</div><div class="tiny">Select foods, set their portions, log them together later.</div></div>${this.close()}</div>${field("combo name", "comboName", "", "text", "required placeholder='Bagel + cream cheese'")}${error ? `<div class="notice warn combo-error">${html(error)}</div>` : ""}<div class="combo-list">${rows}</div>${measurementList()}<div class="mfooter"><button class="btn-primary btn-icon">${icon("Save")}<span>Save combo</span></button></div></form>`;
  }

  private quickCalorieForm(modal: Extract<Modal, { kind: "quick" }>): string {
    return `<form data-form="quick"><div class="mhead"><div><div>Quick calories</div><div class="tiny">Fast estimate, no invented macros</div></div>${this.close()}</div><div class="quick-picker"><div class="quick-screen"><input name="calories" data-quick-calories type="number" min="0" step="1" inputmode="numeric" value="${modal.calories}" aria-label="Calories"><span>kcal</span></div><div class="quick-increments">${[10, 25, 50, 100, 250].map((amount) => `<button type="button" data-action="quick-increment" data-amount="${amount}">+${amount}</button>`).join("")}</div></div><fieldset class="period-picker"><legend>Meal</legend>${PERIODS.map((period) => `<label><input type="radio" name="period" value="${period}" ${period === modal.period ? "checked" : ""}><span>${period}</span></label>`).join("")}</fieldset><button class="btn-primary quick-confirm btn-icon" type="submit">${icon("Check")}<span>Log ${fmt(modal.calories)} calories</span></button></form>`;
  }

  private logForm(food: Food, selected?: Period): string {
    return `<form data-form="log" data-id="${food.id}"><div class="mhead"><div><div>${html(food.name)}</div><div class="tiny">${fmt(food.nutrition.calories)} kcal per ${html(food.serving.description)}</div></div>${this.close()}</div><div class="two"><label class="field"><span>meal</span><select name="period">${PERIODS.map((period) => `<option value="${period}" ${period === selected ? "selected" : ""}>${period}</option>`).join("")}</select></label>${field("amount", "amount", food.serving.amount, "number", "min=.0001 step=any required")}${field("unit", "unit", food.serving.unit, "text", "list=measurement-units required")}${field("date", "date", this.state.prefs.date, "date", "required")}</div>${measurementList()}<div class="measurement-note">Nutrition scales from ${html(food.serving.description)}. Compatible kitchen and metric units convert automatically.</div><div class="mfooter"><button class="btn-primary">add to day</button></div></form>`;
  }

  private aiModal(modal: Extract<Modal, { kind: "ai" }>): string {
    if (modal.stage === "request") return `<form data-form="ai-request"><div class="mhead"><div><div>AI bridge</div><div class="tiny">clipboard in, clipboard out</div></div>${this.close()}</div><label class="field"><span>what happened, or what should change?</span><textarea name="request" placeholder="I had a bagel with cream cheese this morning." required></textarea></label><div class="notice">Nothing is sent automatically. You choose the AI, paste the packet, and bring back JSON.</div><div class="mfooter"><button class="btn-primary">build packet</button></div></form>`;
    if (modal.stage === "prompt") return `<div class="mhead"><div><div>AI packet</div><div class="tiny">copy all of this into ChatGPT</div></div>${this.close()}</div><textarea class="code" readonly>${html(modal.prompt)}</textarea><div class="mfooter"><button class="btn" data-action="copy-prompt">copy packet</button><button class="btn-primary" data-action="ai-reply">I have the reply</button></div>`;
    if (modal.stage === "reply") return `<form data-form="ai-reply"><div class="mhead"><div>paste JSON reply</div>${this.close()}</div><textarea class="code" name="reply" required></textarea><div class="notice">Nothing changes until you review and apply.</div><div class="mfooter"><button class="btn-primary">preview</button></div></form>`;
    return `<div class="mhead"><div><div>review changes</div><div class="tiny">nothing applied yet</div></div>${this.close()}</div>${modal.response?.summary ? `<div class="notice">${html(modal.response.summary)}</div>` : ""}<div class="stack">${modal.response?.operations.map((op, i) => `<div class="card pad"><div>${html(op.type)}</div><div class="tiny">change ${i + 1}</div></div>`).join("")}</div><div class="mfooter"><button class="btn-primary" data-action="apply-ai">apply ${modal.response?.operations.length ?? 0}</button></div>`;
  }

  private onClick(event: Event): void {
    const syncButton = (event.target as Element).closest<HTMLElement>("[data-sync-action]");
    if (syncButton && this.repository instanceof CloudStateRepository) {
      const action = syncButton.dataset.syncAction;
      if (action === "backdrop" && event.target !== syncButton) return;
      if (action === "open") this.syncOpen = true;
      if (action === "close" || action === "backdrop") this.syncOpen = false;
      if (action === "migrate") void this.repository.confirmMigration();
      if (action === "decline") { this.repository.declineMigration(); this.syncOpen = false; }
      if (action === "retry") void this.repository.retry();
      if (action === "use-cloud") void this.repository.resolveConflict("cloud");
      if (action === "use-local") void this.repository.resolveConflict("local");
      this.renderSync();
      return;
    }
    if (this.account?.handleClick(event)) return;
    const button = (event.target as Element).closest<HTMLElement>("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "clear-library-search") {
      const input = this.root.querySelector<HTMLInputElement>("[data-library-search]");
      if (input) { input.value = ""; this.filterLibrary(""); input.focus(); }
    }
    if (action === "view") { this.view = button.dataset.view as View; this.mealPeriod = undefined; if (this.view === "calendar") this.calendarMonth = this.state.prefs.date.slice(0, 7); this.render(); }
    if (action === "open-meal" && PERIODS.includes(button.dataset.period as Period)) { this.mealPeriod = button.dataset.period as Period; this.render(); }
    if (action === "back-today") { this.mealPeriod = undefined; this.render(); }
    if (action === "date") { this.state.prefs.date = shiftDate(this.state.prefs.date, Number(button.dataset.days)); this.save(); }
    if (action === "today") { this.state.prefs.date = isoDate(); this.save(); }
    if (action === "calendar-month") { this.calendarMonth = shiftMonth(this.calendarMonth, Number(button.dataset.months)); this.render(); }
    if (action === "calendar-today") { this.calendarMonth = isoDate().slice(0, 7); this.render(); }
    if (action === "open-calendar-day") { this.state.prefs.date = String(button.dataset.date); this.calendarMonth = this.state.prefs.date.slice(0, 7); this.view = "day"; this.save(); }
    if (action === "close" || action === "backdrop" && event.target === button) { this.modal = null; this.render(); }
    if (action === "new-food") { this.modal = { kind: "food" }; this.render(); }
    if (action === "build-combo" && this.state.foods.length >= 2) { this.modal = { kind: "combo" }; this.render(); }
    if (action === "edit-food") { const food = this.food(button.dataset.id); if (food) { this.modal = { kind: "food", food }; this.render(); } }
    if (action === "request-delete-food") { const food = this.food(button.dataset.id); if (food) { this.modal = { kind: "delete-food", food }; this.render(); } }
    if (action === "confirm-delete-food") {
      const removed = removeFoodFromLibrary(this.state, button.dataset.id ?? "");
      this.modal = null;
      if (removed) this.save("food removed from library"); else this.render();
    }
    if (action === "choose-food") { this.modal = this.state.foods.length ? { kind: "choose", period: button.dataset.period ? normalizePeriod(button.dataset.period) : undefined } : { kind: "food" }; this.render(); }
    if (action === "open-quick") { this.modal = { kind: "quick", calories: 0, period: "snacks" }; this.render(); }
    if (action === "quick-increment" && this.modal?.kind === "quick") { this.modal.calories += Number(button.dataset.amount) || 0; this.render(); }
    if (action === "log") { const food = this.food(button.dataset.id); if (food) { const period = this.modal?.kind === "choose" ? this.modal.period : undefined; this.modal = { kind: "log", food, period }; this.render(); } }
    if (action === "delete-entry") { this.state.entries = this.state.entries.filter((entry) => entry.id !== button.dataset.id); this.save("entry removed"); }
    if (action === "open-weight") { this.modal = { kind: "weight" }; this.render(); }
    if (action === "open-exercise") { this.modal = { kind: "exercise" }; this.render(); }
    if (action === "open-backup") { this.modal = { kind: "backup" }; this.render(); }
    if (action === "open-ai") { this.modal = { kind: "ai", stage: "request" }; this.render(); }
    if (action === "onboard") { this.state.profile.onboardingComplete = false; this.render(); }
    if (action === "download") this.download();
    if (action === "copy-backup") void this.copy(exportBackup(this.state), "backup copied");
    if (action === "copy-prompt" && this.modal?.kind === "ai") void this.copy(this.modal.prompt ?? "", "packet copied");
    if (action === "ai-reply") { this.modal = { kind: "ai", stage: "reply" }; this.render(); }
    if (action === "apply-ai" && this.modal?.kind === "ai" && this.modal.response) { const result = applyAiResponse(this.state, this.modal.response); this.state = result.state; this.modal = null; this.save(`${result.applied} changes applied`); }
    if (action === "capture" && this.modal?.kind === "food" && !this.modal.capturing) {
      // Remember the note and the typed-in fields before the picker steals focus: opening it
      // can rerender or background the page, and an unsaved form would be lost.
      this.modal = { ...this.modal, draft: this.captureFoodDraft(), captureNote: this.currentNote(), aiMessage: undefined, aiError: undefined };
      this.root.querySelector<HTMLInputElement>(`[data-capture-input="${button.dataset.mode}"]`)?.click();
    }
    if (action === "describe" && this.modal?.kind === "food" && !this.modal.capturing) {
      this.modal = { ...this.modal, draft: this.captureFoodDraft(), captureNote: this.currentNote(), aiMessage: undefined, aiError: undefined };
      void this.runCapture("describe", null);
    }
    if (action === "add-ingredient" && this.modal?.kind === "food") {
      const draft = this.captureFoodDraft();
      draft.recipe ??= { ingredients: [], instructions: null };
      draft.recipe.ingredients ??= [];
      draft.recipe.ingredients.push({ name: "", amount: null, unit: "", nutrition: {} });
      this.modal = { ...this.modal, draft, captureNote: this.currentNote(), aiMessage: undefined, aiError: undefined };
      this.render();
    }
    if (action === "remove-ingredient" && this.modal?.kind === "food") {
      const draft = this.captureFoodDraft();
      draft.recipe?.ingredients?.splice(Number(button.dataset.index), 1);
      this.modal = { ...this.modal, draft, captureNote: this.currentNote(), aiMessage: undefined, aiError: undefined };
      this.render();
    }
  }

  private onChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    const captureMode = target.dataset.captureInput;
    if (captureMode) {
      const file = target.files?.[0];
      target.value = "";
      if (file) void this.runCapture(captureMode as CaptureMode, file);
      return;
    }
    if (target.name !== "isRecipe" || this.modal?.kind !== "food") return;
    const draft = this.captureFoodDraft();
    draft.recipe = target.checked ? (draft.recipe ?? { ingredients: [{ name: "", amount: null, unit: "", nutrition: {} }], instructions: null }) : null;
    this.modal = { ...this.modal, draft, captureNote: this.currentNote(), aiMessage: undefined, aiError: undefined };
    this.render();
  }

  private onInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    if (target.matches("[data-library-search]")) { this.filterLibrary(target.value); return; }
    if (!target.matches("[data-quick-calories]") || this.modal?.kind !== "quick") return;
    this.modal.calories = Math.max(0, Math.round(Number(target.value) || 0));
    const label = this.root.querySelector<HTMLElement>(".quick-confirm span");
    if (label) label.textContent = `Log ${this.modal.calories} calories`;
  }

  private onSubmit(event: Event): void {
    const form = (event.target as Element).closest<HTMLFormElement>("form[data-form], form[data-account-form]");
    if (!form) return;
    event.preventDefault();
    if (this.account?.handlesForm(form)) { void this.account.submit(form); return; }
    const data = new FormData(form);
    const kind = form.dataset.form;
    try {
      if (kind === "onboarding") this.submitOnboarding(data);
      if (kind === "food") this.submitFood(data, form.dataset.id);
      if (kind === "combo") this.submitCombo(data);
      if (kind === "quick") this.submitQuick(data);
      if (kind === "log") this.submitLog(data, form.dataset.id);
      if (kind === "weight") this.submitWeight(data);
      if (kind === "exercise") this.submitExercise(data);
      if (kind === "restore") { this.state = parseBackup(String(data.get("backup"))); this.modal = null; this.save("backup restored"); }
      if (kind === "settings") this.submitSettings(data);
      if (kind === "snack-budget") this.submitSnackBudget(data);
      if (kind === "ai-request") { this.modal = { kind: "ai", stage: "prompt", prompt: buildAiPrompt(this.state, String(data.get("request"))) }; this.render(); }
      if (kind === "ai-reply") { const response = parseAiResponse(String(data.get("reply"))); this.modal = { kind: "ai", stage: "preview", response }; this.render(); }
    } catch (error) { this.showToast(error instanceof Error ? error.message : "Could not apply that change."); }
  }

  private submitOnboarding(data: FormData): void {
    Object.assign(this.state.profile, { onboardingComplete: true, age: getNumber(data, "age"), heightIn: getNumber(data, "heightIn"), weightLb: getNumber(data, "weightLb"), goalWeightLb: getNumber(data, "goalWeightLb"), activityPAL: getNumber(data, "activity") ?? 1.6, sexForEquation: data.get("sex") });
    if (!this.state.weights.length && this.state.profile.weightLb) this.addWeight(this.state.prefs.date, this.state.profile.weightLb);
    this.save("saved locally");
  }

  private submitFood(data: FormData, id?: string): void {
    const previous = this.food(id);
    const draft = this.captureFoodDraft(data);
    const imported = this.modal?.kind === "food" ? this.modal.draft : undefined;
    const food = normalizeFood({ ...previous, ...imported, ...draft, id: previous?.id });
    const index = previous ? this.state.foods.findIndex((item) => item.id === previous.id) : -1;
    if (index >= 0) this.state.foods[index] = food; else this.state.foods.push(food);
    this.modal = null; this.save("food saved");
  }

  private submitQuick(data: FormData): void {
    const calories = getNumber(data, "calories");
    if (!calories || calories <= 0) throw new Error("Add at least 1 calorie.");
    this.state.entries.push(createQuickCalorieEntry(calories, this.state.prefs.date, normalizePeriod(data.get("period"))));
    this.modal = null;
    this.save(`${Math.round(calories)} calories logged`);
  }

  private submitCombo(data: FormData): void {
    try {
      const selectedIds = data.getAll("comboFood").map(String);
      const selections = selectedIds.map((id) => {
        const food = this.food(id);
        if (!food) throw new Error("One of those foods is no longer in the library.");
        return { food, amount: getNumber(data, `comboAmount_${id}`) ?? 0, unit: String(data.get(`comboUnit_${id}`) ?? food.serving.unit) };
      });
      this.state.foods.push(createComboFood(String(data.get("comboName") ?? ""), selections));
      this.modal = null;
      this.save("combo saved to your library");
    } catch (error) {
      this.modal = { kind: "combo", error: error instanceof Error ? error.message : "Could not save that combo." };
      this.render();
    }
  }

  private submitLog(data: FormData, id?: string): void {
    const food = this.food(id);
    if (!food) throw new Error("Food no longer exists.");
    const amount = getNumber(data, "amount") ?? food.serving.amount;
    const multiplier = servingMultiplier(amount, String(data.get("unit") ?? food.serving.unit), food.serving);
    this.state.entries.push(createEntry(food, String(data.get("date")), normalizePeriod(data.get("period")), multiplier));
    this.modal = null;
    this.save("added to day");
  }
  private submitWeight(data: FormData): void { const raw = getNumber(data, "weight"); if (!raw) throw new Error("Enter a weight."); this.addWeight(String(data.get("date")), this.state.profile.units === "metric" ? kgToPounds(raw) : raw); this.modal = null; this.save("check-in saved"); }
  private submitExercise(data: FormData): void {
    const kind = String(data.get("kind")) as ExerciseKind;
    const minutes = getNumber(data, "minutes");
    if (!(kind in EXERCISE_LABELS) || !minutes || minutes < 1) throw new Error("Choose an activity and add at least 1 minute.");
    const now = new Date().toISOString();
    this.state.exercises.push({ id: uid("exercise"), date: String(data.get("date")), kind, minutes, createdAt: now, updatedAt: now });
    this.modal = null;
    this.save("exercise added");
  }
  private submitSettings(data: FormData): void { const goal = getNumber(data, "goalWeight"); Object.assign(this.state.profile, { manualDailyGuide: getNumber(data, "manualDailyGuide"), activityPAL: getNumber(data, "activityPAL") ?? 1.6, goalWeightLb: goal && this.state.profile.units === "metric" ? kgToPounds(goal) : goal, rateLbWeek: getNumber(data, "rateLbWeek") ?? 0, goalType: data.get("goalType") }); this.save("plan saved"); }
  private submitSnackBudget(data: FormData): void {
    const enabled = data.get("enabled") === "on";
    const calories = Math.round(getNumber(data, "calories") ?? this.state.prefs.protectedSnackCalories);
    if (enabled && calories < 1) throw new Error("Save at least 1 calorie for snacks.");
    const guide = dailyCalorieGuide(this.state.profile);
    if (enabled && guide && calories >= guide) throw new Error(`Save fewer than ${fmt(guide)} calories for snacks.`);
    this.state.prefs.protectedSnackBudgetEnabled = enabled;
    this.state.prefs.protectedSnackCalories = Math.max(1, calories);
    this.save(enabled ? `${this.state.prefs.protectedSnackCalories} snack calories protected` : "snack calorie protection off");
  }
  private addWeight(date: string, weightLb: number): void { const now = new Date().toISOString(); const existing = this.state.weights.find((item) => item.date === date); if (existing) { existing.weightLb = weightLb; existing.updatedAt = now; } else this.state.weights.push({ id: uid("weight"), date, weightLb, createdAt: now, updatedAt: now }); this.state.profile.weightLb = weightLb; }
  private food(id?: string): Food | undefined { return this.state.foods.find((food) => food.id === id); }
  private displayWeight(value: number | null | undefined): number | null { return value == null ? null : round(this.state.profile.units === "metric" ? poundsToKg(value) : value, 1); }
  private weightUnit(): string { return this.state.profile.units === "metric" ? "kg" : "lb"; }
  private captureFoodDraft(existingData?: FormData): FoodInput {
    const form = this.root.querySelector<HTMLFormElement>('form[data-form="food"]');
    const data = existingData ?? (form ? new FormData(form) : new FormData());
    const base = this.modal?.kind === "food" ? (this.modal.draft ?? this.modal.food ?? {}) : {};
    const recipeEnabled = data.get("isRecipe") === "on";
    const ingredients = form ? [...form.querySelectorAll<HTMLElement>("[data-ingredient]")].map((_row, index) => ({
      id: base.recipe?.ingredients?.[index]?.id,
      foodId: base.recipe?.ingredients?.[index]?.foodId,
      name: String(data.get(`ingredientName_${index}`) ?? ""),
      amount: getNumber(data, `ingredientAmount_${index}`),
      unit: normalizeUnit(data.get(`ingredientUnit_${index}`), ""),
      nutrition: {
        calories: getNumber(data, `ingredientCalories_${index}`),
        proteinG: getNumber(data, `ingredientProtein_${index}`),
        carbsG: getNumber(data, `ingredientCarbs_${index}`),
        fatG: getNumber(data, `ingredientFat_${index}`),
      },
    })) : (base.recipe?.ingredients ?? []);
    return {
      ...base,
      name: String(data.get("name") ?? base.name ?? ""),
      brand: String(data.get("brand") ?? base.brand ?? "") || null,
      serving: {
        ...(base.serving ?? {}),
        amount: getNumber(data, "servingAmount") ?? base.serving?.amount ?? 1,
        unit: normalizeUnit(data.get("servingUnit") ?? base.serving?.unit),
      },
      nutrition: {
        ...(base.nutrition ?? {}),
        calories: getNumber(data, "calories") ?? 0,
        proteinG: getNumber(data, "proteinG"),
        carbsG: getNumber(data, "carbsG"),
        fatG: getNumber(data, "fatG"),
        fiberG: getNumber(data, "fiberG"),
        sugarG: getNumber(data, "sugarG"),
        addedSugarG: getNumber(data, "addedSugarG"),
        saturatedFatG: getNumber(data, "saturatedFatG"),
        sodiumMg: getNumber(data, "sodiumMg"),
      },
      recipe: recipeEnabled ? { ingredients, instructions: String(data.get("instructions") ?? base.recipe?.instructions ?? "") || null } : null,
    };
  }

  private currentNote(): string {
    return this.root.querySelector<HTMLTextAreaElement>("#ai-food-note")?.value.trim() ?? "";
  }

  /**
   * Downscale the photo, send it with the note, and merge the reply into the open form.
   * Nothing is saved: the user reviews the filled fields and presses save themselves, so a
   * wrong estimate is a correction rather than a bad entry in the library.
   */
  private async runCapture(mode: CaptureMode, file: Blob | null): Promise<void> {
    if (this.modal?.kind !== "food") return;
    const draft = this.modal.draft ?? this.captureFoodDraft();
    const note = this.modal.captureNote ?? this.currentNote();
    // A description is the whole request, so an empty one is refused here rather than at the
    // server: there is nothing to read, and a round trip would spend a capture to say so.
    if (mode === "describe" && note.trim().length === 0) {
      this.modal = { ...this.modal, draft, captureNote: note, capturing: undefined, aiMessage: undefined, aiError: "Describe what you ate first, then press Describe it." };
      this.render();
      return;
    }
    this.modal = { ...this.modal, draft, captureNote: note, capturing: mode, aiMessage: undefined, aiError: undefined };
    this.render();

    try {
      // The free path first. A packaged food with a readable barcode never reaches the model,
      // which is both instant and the reason most days cost nothing at all.
      if (mode === "label" && file && await this.applyBarcode(file, draft, note)) return;

      const image = file ? await this.prepareCapture(file) : null;
      const result = await this.capture.send(
        image ? { mode, imageBase64: image.base64, mimeType: image.mimeType, note: note || null } : { mode, note: note || null },
      );
      if (this.modal?.kind !== "food") return;
      this.modal = {
        ...this.modal,
        draft: captureToFoodDraft(draft, result.food),
        capturing: undefined,
        captureNote: note,
        aiMessage: `Filled in from your ${mode === "describe" ? "description" : "photo"}. Check it, then save. ${result.remaining.today} captures left today.`,
        aiError: undefined,
      };
    } catch (error) {
      if (this.modal?.kind !== "food") return;
      this.modal = { ...this.modal, draft, capturing: undefined, captureNote: note, aiMessage: undefined, aiError: this.captureMessage(error) };
    }
    this.render();
  }

  /**
   * Try Open Food Facts for this photo. Returns true when it filled the form, false to fall
   * through to the AI read of the same photo — a miss is routing, not an error, so the user
   * is never told that a lookup they did not ask for failed.
   */
  private async applyBarcode(file: Blob, draft: FoodInput, note: string): Promise<boolean> {
    let result: BarcodeResult;
    try {
      result = await this.capture.scan(file);
    } catch {
      return false;
    }
    if (!result.found || this.modal?.kind !== "food") return false;
    const portion = {
      amount: result.food.serving?.amount ?? 1,
      unit: result.food.serving?.unit ?? "serving",
    };
    this.modal = {
      ...this.modal,
      draft: captureToFoodDraft(draft, { ...result.food, portion }),
      capturing: undefined,
      captureNote: note,
      aiMessage: "Found in the free product database. No AI capture used.",
      aiError: undefined,
    };
    this.render();
    return true;
  }

  private async prepareCapture(file: Blob): Promise<CapturedImage> {
    try {
      return await this.capture.prepare(file);
    } catch (error) {
      throw new CaptureError("bad-request", error instanceof Error ? error.message : "That photo could not be read.");
    }
  }

  private captureMessage(error: unknown): string {
    if (error instanceof CaptureError && error.code === "limit-reached") {
      return `${error.message} You can still fill the food in by hand.`;
    }
    if (error instanceof Error && error.message) return error.message;
    return "Photo capture failed. Try again.";
  }

  private async writeClipboard(value: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(value); return; } catch { /* Fall back for browsers with partial clipboard support. */ }
    }
    const area = document.createElement("textarea");
    area.value = value;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    if (!copied) throw new Error("Clipboard unavailable");
  }

  private async copy(value: string, message: string): Promise<void> { await this.writeClipboard(value); this.showToast(message); }
  private download(): void { const url = URL.createObjectURL(new Blob([exportBackup(this.state)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = `aifoodpal-backup-${this.state.prefs.date}.json`; link.click(); URL.revokeObjectURL(url); }
  private showToast(message: string): void { requestAnimationFrame(() => { const toast = this.root.querySelector("#toast"); if (!toast) return; toast.textContent = message; toast.classList.add("show"); clearTimeout(this.toastTimer); this.toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2200); }); }
}

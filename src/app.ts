import { applyAiResponse, buildAiPrompt, buildFoodAiPrompt, importFoodDraft, parseAiResponse, type AiResponse } from "./ai";
import { createEntry, createQuickCalorieEntry, isoDate, moveDiaryEntry, normalizeFood, normalizePeriod, PERIODS, removeFoodFromLibrary, uid, type AppState, type Food, type FoodInput, type Period, type RecipeIngredient } from "./model";
import { calorieGuidance, dailyCalorieGuide, formatDate, kgToPounds, latestWeight, nutritionTargets, poundsToKg, round, shiftDate, totalsFor } from "./nutrition";
import { exportBackup, parseBackup, type StateRepository } from "./storage";
import { icon, renderIcons } from "./icons";
import { calendarGrid, formatMonth, shiftMonth } from "./calendar";
import { createComboFood } from "./combos";
import { formatQuantity, normalizeUnit, servingMultiplier, UNIT_OPTIONS } from "./units";
import { DiaryDragController } from "./diary-drag";
import type { AccountController } from "./account";
import { CloudStateRepository, type SyncStatus } from "./cloud-sync";

type View = "day" | "calendar" | "library" | "trend" | "settings";
type FoodModal = { kind: "food"; food?: Food; draft?: FoodInput; aiMessage?: string; aiError?: string };
type Modal = FoodModal | { kind: "combo"; error?: string } | { kind: "quick"; calories: number; period: Period } | { kind: "choose"; period?: Period } | { kind: "log"; food: Food; period?: Period } | { kind: "delete-food"; food: Food } | { kind: "weight" } | { kind: "backup" } | { kind: "ai"; stage: "request" | "prompt" | "reply" | "preview"; prompt?: string; response?: AiResponse } | null;

const html = (value: unknown): string => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const fmt = (value: number | null | undefined, digits = 0): string => value == null ? "?" : new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value);
const field = (label: string, name: string, value: unknown, type = "number", attrs = ""): string => `<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${html(value)}" ${attrs}></label>`;
const getNumber = (data: FormData, key: string): number | null => { const value = data.get(key); if (value === null || value === "") return null; const number = Number(value); return Number.isFinite(number) ? number : null; };
const measurementList = (): string => `<datalist id="measurement-units">${UNIT_OPTIONS.map((unit) => `<option value="${unit.value}">${unit.label}</option>`).join("")}</datalist>`;

export class DaybookApp {
  private state: AppState;
  private view: View = "day";
  private calendarMonth: string;
  private modal: Modal = null;
  private toastTimer?: number;
  private syncStatus?: SyncStatus;
  private syncOpen = false;

  constructor(private readonly root: HTMLElement, private readonly repository: StateRepository, private readonly account?: AccountController) {
    this.state = repository.load();
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
        (state) => { this.state = state; this.render(); },
        (status) => {
          this.syncStatus = status;
          if (status.phase === "migration" || status.phase === "conflict" || status.phase === "offline") this.syncOpen = true;
          this.renderSync();
        },
      );
    }
    this.render();
    new DiaryDragController(
      this.root,
      (entryId, period, index) => this.moveEntry(entryId, period, index),
      () => { this.render(); this.showToast("meal order updated"); },
    );
  }

  private save(message?: string): void {
    this.repository.save(this.state);
    this.render();
    if (message) this.showToast(message);
  }

  private render(): void {
    const brand = `<div class="wordmark"><span class="brandmark">${icon("NotebookTabs")}</span><span><b>AI</b>foodpal</span></div>`;
    this.root.innerHTML = `<div class="shell"><aside class="side">${brand}${this.nav()}<div class="sidebottom">${icon("ShieldCheck")}<span>Private by default.<br>Stored in this browser.</span></div></aside><main class="main"><header class="top">${brand}<div class="top-actions"><button class="btn btn-icon" data-action="open-ai">${icon("Sparkles")}<span>AI bridge</span></button>${this.syncStatus ? `<div class="sync-host" data-sync-header>${this.syncHeaderHtml()}</div>` : ""}${this.account ? `<div class="account-host" data-account-header>${this.account.headerHtml()}</div>` : ""}</div></header><div class="view">${this.content()}</div></main></div>${this.nav(true)}${this.modalHtml()}${this.syncStatus ? `<div data-sync-modal>${this.syncModalHtml()}</div>` : ""}${this.account ? `<div data-account-modal>${this.account.modalHtml()}</div>` : ""}<div class="toast" id="toast"></div>`;
    renderIcons(this.root);
  }

  private renderAccount(): void {
    if (!this.account) return;
    const header = this.root.querySelector<HTMLElement>("[data-account-header]");
    const modal = this.root.querySelector<HTMLElement>("[data-account-modal]");
    if (header) { header.innerHTML = this.account.headerHtml(); renderIcons(header); }
    if (modal) { modal.innerHTML = this.account.modalHtml(); renderIcons(modal); }
  }

  private renderSync(): void {
    if (!this.syncStatus) return;
    const header = this.root.querySelector<HTMLElement>("[data-sync-header]");
    const modal = this.root.querySelector<HTMLElement>("[data-sync-modal]");
    if (header) { header.innerHTML = this.syncHeaderHtml(); renderIcons(header); }
    if (modal) { modal.innerHTML = this.syncModalHtml(); renderIcons(modal); }
  }

  private syncHeaderHtml(): string {
    const status = this.syncStatus!;
    const labels: Record<SyncStatus["phase"], string> = { local: "On this device", connecting: "Syncing…", migration: "Finish setup", synced: "Synced", offline: "Offline", conflict: "Sync conflict" };
    return `<button class="btn btn-icon sync-trigger ${status.phase}" data-sync-action="open" aria-label="Open sync details: ${html(status.message)}">${icon(status.phase === "synced" ? "Check" : "DatabaseBackup")}<span>${labels[status.phase]}</span></button>`;
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

  private content(): string {
    if (!this.state.profile.onboardingComplete) return this.onboarding();
    if (this.view === "calendar") return this.calendar();
    if (this.view === "library") return this.library();
    if (this.view === "trend") return this.trend();
    if (this.view === "settings") return this.settings();
    return this.day();
  }

  private calendar(): string {
    const today = isoDate();
    const days = calendarGrid(this.calendarMonth);
    const monthEntries = this.state.entries.filter((entry) => entry.date.startsWith(this.calendarMonth));
    const activeDays = new Set(monthEntries.map((entry) => entry.date)).size;
    const monthCalories = days.filter((day) => day.inMonth).reduce((sum, day) => sum + totalsFor(this.state, day.date).calories, 0);
    const average = activeDays ? monthCalories / activeDays : 0;
    const cells = days.map((day) => {
      const entries = this.state.entries.filter((entry) => entry.date === day.date);
      const totals = totalsFor(this.state, day.date);
      const classes = ["calendar-day", day.inMonth ? "" : "outside", entries.length ? "has-history" : "", day.date === today ? "today" : "", day.date === this.state.prefs.date ? "selected" : ""].filter(Boolean).join(" ");
      return `<button class="${classes}" data-action="open-calendar-day" data-date="${day.date}" aria-label="Open ${formatDate(day.date)}${entries.length ? `, ${entries.length} entries, ${fmt(totals.calories)} calories` : ""}"><span class="calendar-number">${day.day}</span>${entries.length ? `<span class="calendar-kcal">${fmt(totals.calories)} <small>kcal</small></span><span class="calendar-count">${entries.length} ${entries.length === 1 ? "entry" : "entries"}</span>` : `<span class="calendar-empty">—</span>`}</button>`;
    }).join("");
    return `<div class="head calendar-head"><div><span class="eyebrow">Saved diary</span><h1 class="title">Calendar history</h1><p class="subtitle">Every logged day stays available on this device.</p></div><div class="calendar-controls"><button class="icon-btn" data-action="calendar-month" data-months="-1" aria-label="Previous month">${icon("ChevronLeft")}</button><button class="today-btn" data-action="calendar-today">Today</button><button class="icon-btn" data-action="calendar-month" data-months="1" aria-label="Next month">${icon("ChevronRight")}</button></div></div><section class="calendar-layout"><div class="calendar-card card"><div class="calendar-month-title"><strong>${formatMonth(this.calendarMonth)}</strong><span>${activeDays} active ${activeDays === 1 ? "day" : "days"}</span></div><div class="calendar-weekdays">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => `<span>${day}</span>`).join("")}</div><div class="calendar-grid">${cells}</div></div><aside class="history-summary"><span class="history-summary-icon">${icon("CalendarRange")}</span><span class="eyebrow">This month</span><strong>${fmt(monthCalories)}</strong><span>calories logged</span><div class="history-stat"><b>${monthEntries.length}</b><span>entries</span></div><div class="history-stat"><b>${fmt(average)}</b><span>avg kcal / active day</span></div><p>Select any day to open its complete diary.</p></aside></section>`;
  }

  private day(): string {
    const date = this.state.prefs.date;
    const totals = totalsFor(this.state, date);
    const guide = dailyCalorieGuide(this.state.profile);
    const targets = nutritionTargets(this.state.profile);
    const pct = guide ? Math.min(100, totals.calories / guide * 100) : 0;
    const meals = PERIODS.map((period) => this.meal(period, date)).join("");
    const remaining = guide ? Math.max(0, guide - totals.calories) : null;
    const scale = guide ? [0, .25, .5, .75, 1].map((step) => `<span>${fmt(guide * step)}</span>`).join("") : "";
    return `<div class="page-intro"><div><span class="eyebrow">Daily diary</span><h1>${formatDate(date, true)}</h1></div><div class="datebar"><button class="icon-btn" data-action="date" data-days="-1" aria-label="Previous day">${icon("ChevronLeft")}</button><button class="today-btn" data-action="today">Today</button><button class="icon-btn" data-action="date" data-days="1" aria-label="Next day">${icon("ChevronRight")}</button></div></div><section class="card summary"><div class="summary-top"><div><div class="summary-label">Calories logged</div><div class="guide"><span class="big">${fmt(totals.calories)}</span><span>${guide ? `of ${fmt(guide)} kcal` : "kcal"}</span></div></div><div class="summary-actions"><button class="btn btn-icon" data-action="open-quick">${icon("Gauge")}<span>Quick Add</span></button><button class="btn-primary btn-icon" data-action="choose-food">${icon("Plus")}<span>Add food</span></button></div></div><div class="calorie-scale" aria-label="${fmt(pct)} percent of calorie guide"><div class="scale-track"><div class="scale-fill" style="width:${pct}%"></div><span class="scale-flame" style="left:${pct}%">${icon("Flame")}</span></div>${guide ? `<div class="scale-labels">${scale}</div>` : ""}</div><div class="summary-note">${remaining == null ? "Add your baseline to create a daily guide." : `<strong>${fmt(remaining)}</strong> kcal remaining today`}</div><div class="macros">${this.macro("protein", totals.proteinG, targets?.proteinG)}${this.macro("carbs", totals.carbsG, targets?.carbsG)}${this.macro("fat", totals.fatG, targets?.fatG)}${this.macro("fiber", totals.fiberG, targets?.fiberG)}</div></section><div class="section-heading"><span>Meals</span><span>${this.state.entries.filter((entry) => entry.date === date).length} entries</span></div>${meals}`;
  }

  private macro(label: string, value: number | null, target?: number): string {
    const pct = target && value != null ? Math.min(100, value / target * 100) : 0;
    const glyph: Record<string, Parameters<typeof icon>[0]> = { protein: "Dumbbell", carbs: "Wheat", fat: "Droplets", fiber: "Leaf" };
    return `<div class="macro ${label}"><span class="macro-icon">${icon(glyph[label] ?? "Gauge")}</span><div class="macro-content"><div class="k">${label}</div><div class="v">${fmt(value, 1)} <small>g</small></div>${target ? `<div class="macro-target">of ${fmt(target)} g</div>` : ""}<div class="macroline"><div style="width:${pct}%"></div></div></div></div>`;
  }

  private meal(period: Period, date: string): string {
    const entries = this.state.entries.filter((entry) => entry.date === date && entry.period === period);
    const total = totalsFor(this.state, date, period);
    const glyph: Record<Period, Parameters<typeof icon>[0]> = { breakfast: "Coffee", lunch: "Sun", dinner: "Moon", snacks: "Apple" };
    return `<section class="mealgroup card ${entries.length ? "has-entries" : ""}" data-period="${period}"><div class="mealhead"><div class="mealidentity"><span class="meal-period-icon ${period}">${icon(glyph[period])}</span><div><div class="meal-label">Meal</div><div class="mealname">${period}</div><div class="mealsum">${fmt(total.calories)} kcal · ${fmt(total.proteinG, 1)}p · ${fmt(total.carbsG, 1)}c · ${fmt(total.fatG, 1)}f</div></div></div><button class="icon-btn subtle" data-action="choose-food" data-period="${period}" aria-label="Add ${period}">${icon("Plus")}</button></div><div class="entrylist">${entries.map((entry) => this.entryHtml(entry)).join("")}</div></section>`;
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
    const cards = [...this.state.foods].sort((a, b) => a.name.localeCompare(b.name)).map((food) => `<div class="library-card"><div class="library-symbol">${icon(food.recipe ? "ChefHat" : "Utensils")}</div><div class="grow"><div class="library-name">${html(food.name)}${food.recipe ? `<span class="recipe-badge">Recipe</span>` : ""}</div><div class="tiny">${html(food.brand || food.serving.description)} · ${fmt(food.nutrition.calories)} kcal${food.recipe ? ` · ${food.recipe.ingredients.length} ingredients` : ""}</div></div><div class="row library-actions"><button class="tiny-btn btn-icon" data-action="log" data-id="${food.id}">${icon("Plus")}<span>Log</span></button><button class="icon-btn subtle" data-action="edit-food" data-id="${food.id}" aria-label="Edit ${html(food.name)}">${icon("Pencil")}</button><button class="icon-btn danger" data-action="request-delete-food" data-id="${food.id}" aria-label="Delete ${html(food.name)} from library">${icon("Trash2")}</button></div></div>`).join("");
    return `<div class="head"><div><span class="eyebrow">Saved foods</span><h1 class="title">Food library</h1><p class="subtitle">Reusable foods and portions, ready for your next meal.</p></div><div class="head-actions"><button class="btn btn-icon" data-action="build-combo" ${this.state.foods.length < 2 ? "disabled" : ""}>${icon("ListPlus")}<span>Build combo</span></button><button class="btn-primary btn-icon" data-action="new-food">${icon("Plus")}<span>New food</span></button></div></div>${cards || `<div class="empty empty-rich"><span class="empty-icon">${icon("BookOpen")}</span><strong>Your library is ready</strong><span>Create a food here, or ask an AI to structure your first meal.</span><button class="btn-primary btn-icon" data-action="new-food">${icon("Plus")}<span>Create food</span></button></div>`}`;
  }

  private trend(): string {
    const weights = [...this.state.weights].sort((a, b) => b.date.localeCompare(a.date));
    const current = latestWeight(this.state);
    const goal = this.state.profile.goalWeightLb;
    return `<div class="head"><div><span class="eyebrow">Your trend</span><h1 class="title">Progress</h1><p class="subtitle">Small check-ins make the longer pattern visible.</p></div><button class="btn-primary btn-icon" data-action="open-weight">${icon("Weight")}<span>Check in</span></button></div><div class="metricgrid"><div class="metric"><span class="metric-icon">${icon("Weight")}</span><div class="metricv">${fmt(this.displayWeight(current), 1)}</div><div class="metricl">current ${this.weightUnit()}</div></div><div class="metric"><span class="metric-icon">${icon("Target")}</span><div class="metricv">${fmt(this.displayWeight(goal), 1)}</div><div class="metricl">goal ${this.weightUnit()}</div></div></div><section class="section"><p class="label">History</p>${weights.length ? weights.map((weight) => `<div class="history-row"><span class="history-dot"></span><span>${formatDate(weight.date)}</span><strong>${fmt(this.displayWeight(weight.weightLb), 1)} ${this.weightUnit()}</strong></div>`).join("") : `<div class="empty empty-rich"><span class="empty-icon">${icon("ChartNoAxesColumnIncreasing")}</span><strong>No check-ins yet</strong><span>Add your first weight to begin a private trend.</span></div>`}</section>`;
  }

  private settings(): string {
    const profile = this.state.profile;
    const guidance = calorieGuidance(profile);
    return `<div class="head"><div><span class="eyebrow">Preferences</span><h1 class="title">Settings</h1><p class="subtitle">Plan, portability, and privacy.</p></div></div><form data-form="settings" class="card pad stack"><div class="two">${field("daily calorie guide", "manualDailyGuide", profile.manualDailyGuide ?? "", "number", "min=500 placeholder=automatic")}${field("activity multiplier", "activityPAL", profile.activityPAL, "number", "min=1.2 max=2.4 step=.1")}${field(`goal weight (${this.weightUnit()})`, "goalWeight", this.displayWeight(profile.goalWeightLb) ?? "", "number", "step=.1")}${field("weekly pace (lb)", "rateLbWeek", profile.rateLbWeek, "number", "min=0 step=.25")}</div><label class="field"><span>goal</span><select name="goalType"><option value="lose" ${profile.goalType === "lose" ? "selected" : ""}>lose</option><option value="maintain" ${profile.goalType === "maintain" ? "selected" : ""}>maintain</option><option value="gain" ${profile.goalType === "gain" ? "selected" : ""}>gain</option></select></label><div class="notice">${guidance.ok ? `Automatic estimate: ${fmt(guidance.target)} kcal/day${guidance.weeks ? ` · roughly ${fmt(guidance.weeks)} weeks` : ""}.` : html(guidance.reason)}</div><button class="btn-primary" type="submit">save plan</button></form><section class="section"><p class="label">data</p><div class="card settings"><button class="setting" data-action="open-ai"><span>AI bridge</span><span class="tiny">copy / paste</span></button><button class="setting" data-action="open-backup"><span>backup & restore</span><span class="tiny">portable JSON</span></button><button class="setting" data-action="onboard"><span>edit baseline</span><span class="tiny">profile setup</span></button></div></section>`;
  }

  private onboarding(): string {
    const p = this.state.profile;
    return `<div class="onboard onboard-inline"><div class="otop"><div class="wordmark"><span class="brandmark">${icon("NotebookTabs")}</span><span><b>AI</b>foodpal</span></div></div><div class="ocontent"><form data-form="onboarding"><h1 class="otitle">A small private record of your day.</h1><p class="ocopy">These basics create a starting guide. Nothing leaves this browser unless you export or copy it.</p><div class="two">${field("age", "age", p.age ?? "", "number", "min=18 max=120 required")}${field("height (inches)", "heightIn", p.heightIn ?? "", "number", "min=36 step=.1 required")}${field("current weight (lb)", "weightLb", p.weightLb ?? "", "number", "min=50 step=.1 required")}${field("goal weight (lb)", "goalWeightLb", p.goalWeightLb ?? "", "number", "min=50 step=.1")}</div><label class="field"><span>sex used by energy equation</span><select name="sex" required><option value="">choose</option><option value="female" ${p.sexForEquation === "female" ? "selected" : ""}>female</option><option value="male" ${p.sexForEquation === "male" ? "selected" : ""}>male</option></select></label><label class="field"><span>ordinary activity</span><select name="activity"><option value="1.4">mostly still</option><option value="1.6" selected>lightly moving</option><option value="1.8">regularly active</option><option value="2">very active</option><option value="2.2">exceptionally active</option></select></label><div class="notice">This is a planning aid, not medical advice.</div><div class="oactions"><span></span><button class="btn-primary">enter AIfoodpal</button></div></form></div></div></div>`;
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
    return `<form data-form="food" data-id="${modal.food?.id ?? ""}"><div class="mhead"><div>${modal.food ? "edit food" : "new food"}</div>${this.close()}</div><section class="ai-assist"><div class="ai-assist-head"><span class="ai-assist-icon">${icon("Sparkles")}</span><div><strong>AI Assist</strong><div>Use ChatGPT to estimate or extract this food.</div></div></div><div class="ai-actions"><button class="btn btn-icon" type="button" data-action="ask-food-ai">${icon("Copy")}<span>Ask AI</span></button><button class="btn btn-icon" type="button" data-action="apply-food-clipboard">${icon("ClipboardPaste")}<span>Apply Clipboard</span></button></div>${modal.aiMessage ? `<div class="notice success">${icon("Check")}${html(modal.aiMessage)}</div>` : ""}${modal.aiError ? `<div class="notice warn">${html(modal.aiError)}</div>` : ""}<details class="ai-fallback"><summary>Paste AI response manually</summary><textarea class="code" id="ai-food-manual" placeholder='{"schemaVersion":1,...}'></textarea><button class="tiny-btn" type="button" data-action="apply-food-manual">Apply</button></details></section><div class="two">${field("food name", "name", food?.name ?? "", "text", "required placeholder='Cream cheese'")}${field("brand", "brand", food?.brand ?? "", "text")}${field("serving amount", "servingAmount", food?.serving?.amount ?? 1, "number", "min=.0001 step=any required")}${field("serving unit", "servingUnit", food?.serving?.unit ?? "serving", "text", "list=measurement-units required placeholder='tbsp, cup, g…'")}${field("calories", "calories", n?.calories ?? 0, "number", "min=0 required")}${field("protein (g)", "proteinG", n?.proteinG ?? "", "number", "min=0 step=.1")}${field("carbs (g)", "carbsG", n?.carbsG ?? "", "number", "min=0 step=.1")}${field("fat (g)", "fatG", n?.fatG ?? "", "number", "min=0 step=.1")}${field("fiber (g)", "fiberG", n?.fiberG ?? "", "number", "min=0 step=.1")}${field("total sugar (g)", "sugarG", n?.sugarG ?? "", "number", "min=0 step=.1")}${field("added sugar (g)", "addedSugarG", n?.addedSugarG ?? "", "number", "min=0 step=.1")}${field("saturated fat (g)", "saturatedFatG", n?.saturatedFatG ?? "", "number", "min=0 step=.1")}${field("sodium (mg)", "sodiumMg", n?.sodiumMg ?? "", "number", "min=0 step=1")}</div><div class="measurement-note">Keep quantity out of the food name. The serving above can be changed whenever you log it.</div><label class="recipe-toggle"><input type="checkbox" name="isRecipe" ${recipe ? "checked" : ""}><span>${icon("ChefHat")}<b>Is this a recipe?</b><small>Add ingredients, their optional macros, and instructions.</small></span></label>${recipe ? `<section class="recipe-editor"><div class="between"><div><strong>Ingredients</strong><div class="tiny">Amounts and component macros are optional.</div></div><button class="tiny-btn btn-icon" type="button" data-action="add-ingredient">${icon("ListPlus")}<span>Add ingredient</span></button></div><div class="ingredient-list">${ingredients.map((ingredient, index) => this.ingredientFields(ingredient, index)).join("")}</div><label class="field"><span>recipe instructions (optional)</span><textarea name="instructions" placeholder="Mix, cook, portion…">${html(recipe.instructions ?? "")}</textarea></label></section>` : ""}${measurementList()}<div class="mfooter"><button class="btn-primary">save food</button></div></form>`;
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
    if (action === "view") { this.view = button.dataset.view as View; if (this.view === "calendar") this.calendarMonth = this.state.prefs.date.slice(0, 7); this.render(); }
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
    if (action === "open-backup") { this.modal = { kind: "backup" }; this.render(); }
    if (action === "open-ai") { this.modal = { kind: "ai", stage: "request" }; this.render(); }
    if (action === "onboard") { this.state.profile.onboardingComplete = false; this.render(); }
    if (action === "download") this.download();
    if (action === "copy-backup") void this.copy(exportBackup(this.state), "backup copied");
    if (action === "copy-prompt" && this.modal?.kind === "ai") void this.copy(this.modal.prompt ?? "", "packet copied");
    if (action === "ai-reply") { this.modal = { kind: "ai", stage: "reply" }; this.render(); }
    if (action === "apply-ai" && this.modal?.kind === "ai" && this.modal.response) { const result = applyAiResponse(this.state, this.modal.response); this.state = result.state; this.modal = null; this.save(`${result.applied} changes applied`); }
    if (action === "ask-food-ai") void this.askFoodAi();
    if (action === "apply-food-clipboard") void this.applyFoodClipboard();
    if (action === "apply-food-manual") {
      const raw = this.root.querySelector<HTMLTextAreaElement>("#ai-food-manual")?.value ?? "";
      this.applyFoodImport(raw);
    }
    if (action === "add-ingredient" && this.modal?.kind === "food") {
      const draft = this.captureFoodDraft();
      draft.recipe ??= { ingredients: [], instructions: null };
      draft.recipe.ingredients ??= [];
      draft.recipe.ingredients.push({ name: "", amount: null, unit: "", nutrition: {} });
      this.modal = { ...this.modal, draft, aiMessage: undefined, aiError: undefined };
      this.render();
    }
    if (action === "remove-ingredient" && this.modal?.kind === "food") {
      const draft = this.captureFoodDraft();
      draft.recipe?.ingredients?.splice(Number(button.dataset.index), 1);
      this.modal = { ...this.modal, draft, aiMessage: undefined, aiError: undefined };
      this.render();
    }
  }

  private onChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    if (target.name !== "isRecipe" || this.modal?.kind !== "food") return;
    const draft = this.captureFoodDraft();
    draft.recipe = target.checked ? (draft.recipe ?? { ingredients: [{ name: "", amount: null, unit: "", nutrition: {} }], instructions: null }) : null;
    this.modal = { ...this.modal, draft, aiMessage: undefined, aiError: undefined };
    this.render();
  }

  private onInput(event: Event): void {
    const target = event.target as HTMLInputElement;
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
      if (kind === "restore") { this.state = parseBackup(String(data.get("backup"))); this.modal = null; this.save("backup restored"); }
      if (kind === "settings") this.submitSettings(data);
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
  private submitSettings(data: FormData): void { const goal = getNumber(data, "goalWeight"); Object.assign(this.state.profile, { manualDailyGuide: getNumber(data, "manualDailyGuide"), activityPAL: getNumber(data, "activityPAL") ?? 1.6, goalWeightLb: goal && this.state.profile.units === "metric" ? kgToPounds(goal) : goal, rateLbWeek: getNumber(data, "rateLbWeek") ?? 0, goalType: data.get("goalType") }); this.save("plan saved"); }
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

  private async askFoodAi(): Promise<void> {
    if (this.modal?.kind !== "food") return;
    const current = this.modal;
    const draft = this.captureFoodDraft();
    try {
      await this.writeClipboard(buildFoodAiPrompt(this.state, draft));
      this.modal = { ...current, draft, aiMessage: "AI prompt copied — paste it into ChatGPT.", aiError: undefined };
    } catch {
      this.modal = { ...current, draft, aiMessage: undefined, aiError: "Could not copy automatically. Your browser may block clipboard access." };
    }
    this.render();
  }

  private async applyFoodClipboard(): Promise<void> {
    if (this.modal?.kind !== "food") return;
    const current = this.modal;
    const draft = this.captureFoodDraft();
    try {
      const raw = await navigator.clipboard.readText();
      this.applyFoodImport(raw, draft);
    } catch {
      this.modal = { ...current, draft, aiMessage: undefined, aiError: "Clipboard access was denied. Expand ‘Paste AI response manually’ below." };
      this.render();
    }
  }

  private applyFoodImport(raw: string, current = this.captureFoodDraft()): void {
    if (this.modal?.kind !== "food") return;
    const modal = this.modal;
    try {
      const draft = importFoodDraft(current, raw);
      this.modal = { ...modal, draft, aiMessage: "AI response applied to the form. Review it, then save when ready.", aiError: undefined };
    } catch (error) {
      this.modal = { ...modal, draft: current, aiMessage: undefined, aiError: error instanceof Error ? error.message : "Could not apply that AI response." };
    }
    this.render();
  }

  private async writeClipboard(value: string): Promise<void> {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
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

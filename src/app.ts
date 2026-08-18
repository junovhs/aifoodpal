import { applyAiResponse, buildAiPrompt, parseAiResponse, type AiResponse } from "./ai";
import { createEntry, normalizeFood, normalizePeriod, PERIODS, uid, type AppState, type Food, type Period } from "./model";
import { calorieGuidance, dailyCalorieGuide, formatDate, kgToPounds, latestWeight, nutritionTargets, poundsToKg, round, shiftDate, totalsFor } from "./nutrition";
import { exportBackup, parseBackup, type StateRepository } from "./storage";
import { icon, renderIcons } from "./icons";

type View = "day" | "library" | "trend" | "settings";
type Modal = { kind: "food"; food?: Food } | { kind: "choose" } | { kind: "log"; food: Food } | { kind: "weight" } | { kind: "backup" } | { kind: "ai"; stage: "request" | "prompt" | "reply" | "preview"; prompt?: string; response?: AiResponse } | null;

const html = (value: unknown): string => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const fmt = (value: number | null | undefined, digits = 0): string => value == null ? "?" : new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value);
const field = (label: string, name: string, value: unknown, type = "number", attrs = ""): string => `<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${html(value)}" ${attrs}></label>`;
const getNumber = (data: FormData, key: string): number | null => { const value = data.get(key); if (value === null || value === "") return null; const number = Number(value); return Number.isFinite(number) ? number : null; };

export class DaybookApp {
  private state: AppState;
  private view: View = "day";
  private modal: Modal = null;
  private toastTimer?: number;

  constructor(private readonly root: HTMLElement, private readonly repository: StateRepository) {
    this.state = repository.load();
  }

  start(): void {
    this.root.addEventListener("click", (event) => this.onClick(event));
    this.root.addEventListener("submit", (event) => this.onSubmit(event));
    this.render();
  }

  private save(message?: string): void {
    this.repository.save(this.state);
    this.render();
    if (message) this.showToast(message);
  }

  private render(): void {
    const brand = `<div class="wordmark"><span class="brandmark">${icon("NotebookTabs")}</span><span><b>AI</b>foodpal</span></div>`;
    this.root.innerHTML = `<div class="shell"><aside class="side">${brand}${this.nav()}<div class="sidebottom">${icon("ShieldCheck")}<span>Private by default.<br>Stored in this browser.</span></div></aside><main class="main"><header class="top">${brand}<button class="btn btn-icon" data-action="open-ai">${icon("Sparkles")}<span>AI bridge</span></button></header><div class="view">${this.content()}</div></main></div>${this.nav(true)}${this.modalHtml()}${this.state.profile.onboardingComplete ? "" : this.onboarding()}<div class="toast" id="toast"></div>`;
    renderIcons(this.root);
  }

  private nav(bottom = false): string {
    const items: [View, string, Parameters<typeof icon>[0]][] = [["day", "Today", "CalendarDays"], ["library", "Library", "BookOpen"], ["trend", "Progress", "ChartNoAxesColumnIncreasing"], ["settings", "Settings", "Settings"]];
    const buttons = items.map(([id, label, glyph]) => `<button class="nav ${this.view === id ? "active" : ""}" data-action="view" data-view="${id}">${icon(glyph)}<span>${label}</span></button>`).join("");
    return bottom ? `<nav class="bottom">${buttons}</nav>` : `<nav class="sidenav">${buttons}</nav>`;
  }

  private content(): string {
    if (this.view === "library") return this.library();
    if (this.view === "trend") return this.trend();
    if (this.view === "settings") return this.settings();
    return this.day();
  }

  private day(): string {
    const date = this.state.prefs.date;
    const totals = totalsFor(this.state, date);
    const guide = dailyCalorieGuide(this.state.profile);
    const targets = nutritionTargets(this.state.profile);
    const pct = guide ? Math.min(100, totals.calories / guide * 100) : 0;
    const meals = PERIODS.map((period) => this.meal(period, date)).join("");
    const remaining = guide ? Math.max(0, guide - totals.calories) : null;
    return `<div class="page-intro"><div><span class="eyebrow">Daily diary</span><h1>${formatDate(date, true)}</h1></div><div class="datebar"><button class="icon-btn" data-action="date" data-days="-1" aria-label="Previous day">${icon("ChevronLeft")}</button><button class="today-btn" data-action="today">Today</button><button class="icon-btn" data-action="date" data-days="1" aria-label="Next day">${icon("ChevronRight")}</button></div></div><section class="card summary"><div class="summary-top"><div><div class="summary-label">Calories logged</div><div class="guide"><span class="big">${fmt(totals.calories)}</span><span>${guide ? `of ${fmt(guide)}` : "kcal"}</span></div><div class="summary-note">${remaining == null ? "Add your baseline to create a daily guide." : `${fmt(remaining)} kcal remaining today`}</div></div><button class="btn-primary btn-icon" data-action="choose-food">${icon("Plus")}<span>Add food</span></button></div><div class="progress" aria-label="${fmt(pct)} percent of calorie guide"><div style="width:${pct}%"></div></div><div class="macros">${this.macro("protein", totals.proteinG, targets?.proteinG)}${this.macro("carbs", totals.carbsG, targets?.carbsG)}${this.macro("fat", totals.fatG, targets?.fatG)}${this.macro("fiber", totals.fiberG, targets?.fiberG)}</div></section><div class="section-heading"><span>Meals</span><span>${this.state.entries.filter((entry) => entry.date === date).length} entries</span></div>${meals}`;
  }

  private macro(label: string, value: number | null, target?: number): string {
    const pct = target && value != null ? Math.min(100, value / target * 100) : 0;
    return `<div class="macro"><div class="v">${fmt(value, 1)} g</div><div class="k"><span>${label}</span>${target ? `<span>/ ${fmt(target)}g</span>` : ""}</div><div class="macroline"><div style="width:${pct}%"></div></div></div>`;
  }

  private meal(period: Period, date: string): string {
    const entries = this.state.entries.filter((entry) => entry.date === date && entry.period === period);
    const total = totalsFor(this.state, date, period);
    return `<section class="mealgroup card"><div class="mealhead"><div><div class="mealname">${period}</div><div class="mealsum">${fmt(total.calories)} kcal · ${fmt(total.proteinG, 1)}p · ${fmt(total.carbsG, 1)}c · ${fmt(total.fatG, 1)}f</div></div><button class="icon-btn subtle" data-action="choose-food" data-period="${period}" aria-label="Add ${period}">${icon("Plus")}</button></div>${entries.length ? `<div class="entrylist">${entries.map((entry) => `<div class="entry"><div class="food-icon">${icon("Utensils")}</div><div class="entrymain"><div class="ename">${html(entry.nameSnapshot)}</div><div class="esub">${html(entry.servingSnapshot.description)} × ${fmt(entry.servings, 2)}</div></div><div class="entrymacro">${this.macroBar(entry.nutritionSnapshot.proteinG, entry.nutritionSnapshot.carbsG, entry.nutritionSnapshot.fatG)}</div><span class="ekcal">${fmt(entry.nutritionSnapshot.calories * entry.servings)} <small>kcal</small></span><button class="icon-btn danger" data-action="delete-entry" data-id="${entry.id}" aria-label="Remove ${html(entry.nameSnapshot)}">${icon("Trash2")}</button></div>`).join("")}</div>` : `<button class="mealempty" data-action="choose-food" data-period="${period}">${icon("Plus")}<span>Add something to ${period}</span></button>`}</section>`;
  }

  private macroBar(protein: number, carbs: number, fat: number): string {
    const calories = protein * 4 + carbs * 4 + fat * 9 || 1;
    return `<div class="macrobar"><span class="p" style="width:${protein * 4 / calories * 100}%"></span><span class="c" style="width:${carbs * 4 / calories * 100}%"></span><span class="f" style="width:${fat * 9 / calories * 100}%"></span></div><div class="macrolegend"><span><b>${fmt(protein, 1)}g</b> protein</span><span><b>${fmt(carbs, 1)}g</b> carbs</span><span><b>${fmt(fat, 1)}g</b> fat</span></div>`;
  }

  private library(): string {
    const cards = [...this.state.foods].sort((a, b) => a.name.localeCompare(b.name)).map((food) => `<div class="library-card"><div class="library-symbol">${icon("Utensils")}</div><div class="grow"><div class="library-name">${html(food.name)}</div><div class="tiny">${html(food.brand || food.serving.description)} · ${fmt(food.nutrition.calories)} kcal</div></div><div class="row"><button class="tiny-btn btn-icon" data-action="log" data-id="${food.id}">${icon("Plus")}<span>Log</span></button><button class="icon-btn subtle" data-action="edit-food" data-id="${food.id}" aria-label="Edit ${html(food.name)}">${icon("Pencil")}</button></div></div>`).join("");
    return `<div class="head"><div><span class="eyebrow">Saved foods</span><h1 class="title">Food library</h1><p class="subtitle">Reusable nutrition records, ready for your next meal.</p></div><button class="btn-primary btn-icon" data-action="new-food">${icon("Plus")}<span>New food</span></button></div>${cards || `<div class="empty empty-rich"><span class="empty-icon">${icon("BookOpen")}</span><strong>Your library is ready</strong><span>Create a food here, or ask an AI to structure your first meal.</span><button class="btn-primary btn-icon" data-action="new-food">${icon("Plus")}<span>Create food</span></button></div>`}`;
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
    return `<div class="overlay show"><div class="onboard"><div class="otop"><div class="wordmark"><span class="brandmark">${icon("NotebookTabs")}</span><span><b>AI</b>foodpal</span></div></div><div class="ocontent"><form data-form="onboarding"><h1 class="otitle">A small private record of your day.</h1><p class="ocopy">These basics create a starting guide. Nothing leaves this browser unless you export or copy it.</p><div class="two">${field("age", "age", p.age ?? "", "number", "min=18 max=120 required")}${field("height (inches)", "heightIn", p.heightIn ?? "", "number", "min=36 step=.1 required")}${field("current weight (lb)", "weightLb", p.weightLb ?? "", "number", "min=50 step=.1 required")}${field("goal weight (lb)", "goalWeightLb", p.goalWeightLb ?? "", "number", "min=50 step=.1")}</div><label class="field"><span>sex used by energy equation</span><select name="sex" required><option value="">choose</option><option value="female" ${p.sexForEquation === "female" ? "selected" : ""}>female</option><option value="male" ${p.sexForEquation === "male" ? "selected" : ""}>male</option></select></label><label class="field"><span>ordinary activity</span><select name="activity"><option value="1.4">mostly still</option><option value="1.6" selected>lightly moving</option><option value="1.8">regularly active</option><option value="2">very active</option><option value="2.2">exceptionally active</option></select></label><div class="notice">This is a planning aid, not medical advice.</div><div class="oactions"><span></span><button class="btn-primary">enter AIfoodpal</button></div></form></div></div></div>`;
  }

  private modalHtml(): string {
    if (!this.modal) return "";
    let body = "";
    if (this.modal.kind === "food") body = this.foodForm(this.modal.food);
    if (this.modal.kind === "choose") body = `<div class="mhead"><div>choose a food</div>${this.close()}</div><div class="stack">${this.state.foods.map((food) => `<button class="searchitem" data-action="log" data-id="${food.id}"><span><span>${html(food.name)}</span><span class="tiny">${html(food.brand || food.serving.description)}</span></span><span>${fmt(food.nutrition.calories)} kcal</span></button>`).join("")}<button class="btn" data-action="new-food">create a new food</button></div>`;
    if (this.modal.kind === "log") body = this.logForm(this.modal.food);
    if (this.modal.kind === "weight") body = `<form data-form="weight"><div class="mhead"><div>weight check-in</div>${this.close()}</div>${field(`weight (${this.weightUnit()})`, "weight", this.displayWeight(latestWeight(this.state)) ?? "", "number", "min=1 step=.1 required")}${field("date", "date", this.state.prefs.date, "date", "required")}<div class="mfooter"><button class="btn-primary">save</button></div></form>`;
    if (this.modal.kind === "backup") body = `<div class="mhead"><div>backup & restore</div>${this.close()}</div><div class="stack"><button class="btn" data-action="download">download backup</button><button class="btn" data-action="copy-backup">copy backup</button><form data-form="restore"><label class="field"><span>paste an AIfoodpal backup</span><textarea class="code" name="backup" required></textarea></label><div class="notice warn">Restore replaces this browser's current copy.</div><div class="mfooter"><button class="btn-primary">restore</button></div></form></div>`;
    if (this.modal.kind === "ai") body = this.aiModal(this.modal);
    return `<div class="modalback show" data-action="backdrop"><div class="modal"><div class="modalin">${body}</div></div></div>`;
  }

  private close(): string { return `<button class="close" data-action="close" aria-label="Close">${icon("X")}</button>`; }

  private foodForm(food?: Food): string {
    const n = food?.nutrition;
    return `<form data-form="food" data-id="${food?.id ?? ""}"><div class="mhead"><div>${food ? "edit food" : "new food"}</div>${this.close()}</div><div class="two">${field("name", "name", food?.name ?? "", "text", "required")}${field("brand", "brand", food?.brand ?? "", "text")}${field("serving description", "description", food?.serving.description ?? "1 serving", "text", "required")}${field("calories", "calories", n?.calories ?? 0, "number", "min=0 required")}${field("protein (g)", "proteinG", n?.proteinG ?? 0, "number", "min=0 step=.1 required")}${field("carbs (g)", "carbsG", n?.carbsG ?? 0, "number", "min=0 step=.1 required")}${field("fat (g)", "fatG", n?.fatG ?? 0, "number", "min=0 step=.1 required")}${field("fiber (g)", "fiberG", n?.fiberG ?? "", "number", "min=0 step=.1")}${field("total sugar (g)", "sugarG", n?.sugarG ?? "", "number", "min=0 step=.1")}${field("added sugar (g)", "addedSugarG", n?.addedSugarG ?? "", "number", "min=0 step=.1")}${field("saturated fat (g)", "saturatedFatG", n?.saturatedFatG ?? "", "number", "min=0 step=.1")}${field("sodium (mg)", "sodiumMg", n?.sodiumMg ?? "", "number", "min=0 step=1")}</div><div class="mfooter"><button class="btn-primary">save food</button></div></form>`;
  }

  private logForm(food: Food): string {
    return `<form data-form="log" data-id="${food.id}"><div class="mhead"><div><div>${html(food.name)}</div><div class="tiny">${fmt(food.nutrition.calories)} kcal per ${html(food.serving.description)}</div></div>${this.close()}</div><div class="two"><label class="field"><span>meal</span><select name="period">${PERIODS.map((p) => `<option value="${p}">${p}</option>`).join("")}</select></label>${field("servings", "servings", 1, "number", "min=.01 step=.01 required")}${field("date", "date", this.state.prefs.date, "date", "required")}</div><div class="mfooter"><button class="btn-primary">add to day</button></div></form>`;
  }

  private aiModal(modal: Extract<Modal, { kind: "ai" }>): string {
    if (modal.stage === "request") return `<form data-form="ai-request"><div class="mhead"><div><div>AI bridge</div><div class="tiny">clipboard in, clipboard out</div></div>${this.close()}</div><label class="field"><span>what happened, or what should change?</span><textarea name="request" placeholder="I had a bagel with cream cheese this morning." required></textarea></label><div class="notice">Nothing is sent automatically. You choose the AI, paste the packet, and bring back JSON.</div><div class="mfooter"><button class="btn-primary">build packet</button></div></form>`;
    if (modal.stage === "prompt") return `<div class="mhead"><div><div>AI packet</div><div class="tiny">copy all of this into ChatGPT</div></div>${this.close()}</div><textarea class="code" readonly>${html(modal.prompt)}</textarea><div class="mfooter"><button class="btn" data-action="copy-prompt">copy packet</button><button class="btn-primary" data-action="ai-reply">I have the reply</button></div>`;
    if (modal.stage === "reply") return `<form data-form="ai-reply"><div class="mhead"><div>paste JSON reply</div>${this.close()}</div><textarea class="code" name="reply" required></textarea><div class="notice">Nothing changes until you review and apply.</div><div class="mfooter"><button class="btn-primary">preview</button></div></form>`;
    return `<div class="mhead"><div><div>review changes</div><div class="tiny">nothing applied yet</div></div>${this.close()}</div>${modal.response?.summary ? `<div class="notice">${html(modal.response.summary)}</div>` : ""}<div class="stack">${modal.response?.operations.map((op, i) => `<div class="card pad"><div>${html(op.type)}</div><div class="tiny">change ${i + 1}</div></div>`).join("")}</div><div class="mfooter"><button class="btn-primary" data-action="apply-ai">apply ${modal.response?.operations.length ?? 0}</button></div>`;
  }

  private onClick(event: Event): void {
    const button = (event.target as Element).closest<HTMLElement>("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "view") { this.view = button.dataset.view as View; this.render(); }
    if (action === "date") { this.state.prefs.date = shiftDate(this.state.prefs.date, Number(button.dataset.days)); this.save(); }
    if (action === "today") { this.state.prefs.date = new Date().toISOString().slice(0, 10); this.save(); }
    if (action === "close" || action === "backdrop" && event.target === button) { this.modal = null; this.render(); }
    if (action === "new-food") { this.modal = { kind: "food" }; this.render(); }
    if (action === "edit-food") { const food = this.food(button.dataset.id); if (food) { this.modal = { kind: "food", food }; this.render(); } }
    if (action === "choose-food") { this.modal = this.state.foods.length ? { kind: "choose" } : { kind: "food" }; this.render(); }
    if (action === "log") { const food = this.food(button.dataset.id); if (food) { this.modal = { kind: "log", food }; this.render(); } }
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
  }

  private onSubmit(event: Event): void {
    const form = (event.target as Element).closest<HTMLFormElement>("form[data-form]");
    if (!form) return;
    event.preventDefault();
    const data = new FormData(form);
    const kind = form.dataset.form;
    try {
      if (kind === "onboarding") this.submitOnboarding(data);
      if (kind === "food") this.submitFood(data, form.dataset.id);
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
    const food = normalizeFood({ ...previous, id: previous?.id, name: String(data.get("name")), brand: String(data.get("brand")) || null, serving: { ...previous?.serving, amount: 1, unit: "serving", description: String(data.get("description")) }, nutrition: { calories: getNumber(data, "calories") ?? 0, proteinG: getNumber(data, "proteinG") ?? 0, carbsG: getNumber(data, "carbsG") ?? 0, fatG: getNumber(data, "fatG") ?? 0, fiberG: getNumber(data, "fiberG"), sugarG: getNumber(data, "sugarG"), addedSugarG: getNumber(data, "addedSugarG"), saturatedFatG: getNumber(data, "saturatedFatG"), sodiumMg: getNumber(data, "sodiumMg") } });
    const index = previous ? this.state.foods.findIndex((item) => item.id === previous.id) : -1;
    if (index >= 0) this.state.foods[index] = food; else this.state.foods.push(food);
    this.modal = null; this.save("food saved");
  }

  private submitLog(data: FormData, id?: string): void { const food = this.food(id); if (!food) throw new Error("Food no longer exists."); this.state.entries.push(createEntry(food, String(data.get("date")), normalizePeriod(data.get("period")), getNumber(data, "servings") ?? 1)); this.modal = null; this.save("added to day"); }
  private submitWeight(data: FormData): void { const raw = getNumber(data, "weight"); if (!raw) throw new Error("Enter a weight."); this.addWeight(String(data.get("date")), this.state.profile.units === "metric" ? kgToPounds(raw) : raw); this.modal = null; this.save("check-in saved"); }
  private submitSettings(data: FormData): void { const goal = getNumber(data, "goalWeight"); Object.assign(this.state.profile, { manualDailyGuide: getNumber(data, "manualDailyGuide"), activityPAL: getNumber(data, "activityPAL") ?? 1.6, goalWeightLb: goal && this.state.profile.units === "metric" ? kgToPounds(goal) : goal, rateLbWeek: getNumber(data, "rateLbWeek") ?? 0, goalType: data.get("goalType") }); this.save("plan saved"); }
  private addWeight(date: string, weightLb: number): void { const now = new Date().toISOString(); const existing = this.state.weights.find((item) => item.date === date); if (existing) { existing.weightLb = weightLb; existing.updatedAt = now; } else this.state.weights.push({ id: uid("weight"), date, weightLb, createdAt: now, updatedAt: now }); this.state.profile.weightLb = weightLb; }
  private food(id?: string): Food | undefined { return this.state.foods.find((food) => food.id === id); }
  private displayWeight(value: number | null | undefined): number | null { return value == null ? null : round(this.state.profile.units === "metric" ? poundsToKg(value) : value, 1); }
  private weightUnit(): string { return this.state.profile.units === "metric" ? "kg" : "lb"; }
  private async copy(value: string, message: string): Promise<void> { await navigator.clipboard.writeText(value); this.showToast(message); }
  private download(): void { const url = URL.createObjectURL(new Blob([exportBackup(this.state)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = `aifoodpal-backup-${this.state.prefs.date}.json`; link.click(); URL.revokeObjectURL(url); }
  private showToast(message: string): void { requestAnimationFrame(() => { const toast = this.root.querySelector("#toast"); if (!toast) return; toast.textContent = message; toast.classList.add("show"); clearTimeout(this.toastTimer); this.toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2200); }); }
}

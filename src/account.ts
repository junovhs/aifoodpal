import type { AuthChangeEvent, Session, SupabaseClient } from "@supabase/supabase-js";
import { icon } from "./icons";
import type { Database } from "./supabase-database";

type AccountMode = "sign-in" | "sign-up" | "forgot" | "account" | "recovery";
type AuthClient = SupabaseClient<Database>["auth"];

const escapeHtml = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const emailField = (value = ""): string => `<label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" value="${escapeHtml(value)}" required></label>`;
const passwordField = (name: string, label: string, autocomplete: string): string => `<label class="field"><span>${label}</span><input name="${name}" type="password" autocomplete="${autocomplete}" minlength="8" required></label>`;

/** Owns the browser's email/password session UI without owning daybook persistence. */
export class AccountController {
  private session: Session | null = null;
  private restored = false;
  private mode: AccountMode | null = null;
  private busy = false;
  private message = "";
  private error = "";
  private rerender: () => void = () => undefined;

  constructor(private readonly auth: AuthClient | null) {}

  start(rerender: () => void): void {
    this.rerender = rerender;
    if (!this.auth) return;
    this.auth.onAuthStateChange((event, session) => this.authChanged(event, session));
    void this.auth.getSession()
      .then(({ data }) => {
        const previousEmail = this.session?.user.email ?? "";
        const previousMode = this.mode;
        this.session = data.session;
        this.restored = true;
        if (data.session && (this.mode === "sign-in" || this.mode === "sign-up" || this.mode === "forgot")) this.mode = "account";
        if (!data.session && this.mode === null) this.mode = "sign-in";
        if ((this.session?.user.email ?? "") !== previousEmail || this.mode !== previousMode) this.rerender();
      })
      .catch(() => {
        this.restored = true;
        this.rerender();
      });
  }

  /** True while a configured deployment still owes the visitor the account gate, so the app defers its own overlays. */
  blocksApp(): boolean {
    if (!this.auth || this.session) return false;
    return !this.restored || this.mode !== null;
  }

  headerHtml(): string {
    const label = this.session?.user.email ?? (this.auth ? "Account" : "Cloud off");
    return `<button class="btn btn-icon account-trigger ${this.session ? "signed-in" : ""}" data-account-action="open" aria-label="Open account controls">${icon("UserRound")}<span>${escapeHtml(label)}</span></button>`;
  }

  modalHtml(): string {
    if (!this.mode) return "";
    const content = this.auth ? this.configuredModal() : this.unconfiguredModal();
    return `<div class="modalback show account-backdrop" data-account-action="backdrop"><div class="modal account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title"><div class="modalin">${content}</div></div></div>`;
  }

  handleClick(event: Event): boolean {
    const button = (event.target as Element).closest<HTMLElement>("[data-account-action]");
    if (!button) return false;
    const action = button.dataset.accountAction;
    if (action === "backdrop" && event.target !== button) return true;
    if (action === "open") this.mode = this.session ? "account" : "sign-in";
    if (action === "close" || action === "backdrop") this.mode = null;
    if (action === "sign-in" || action === "sign-up" || action === "forgot" || action === "account") this.mode = action;
    if (action === "sign-out") void this.signOut();
    this.clearFeedback();
    this.rerender();
    return true;
  }

  handlesForm(form: HTMLFormElement): boolean {
    return form.dataset.accountForm !== undefined;
  }

  async submit(form: HTMLFormElement): Promise<void> {
    if (!this.auth || this.busy) return;
    const data = new FormData(form);
    const kind = form.dataset.accountForm;
    this.busy = true;
    this.clearFeedback();
    this.rerender();
    try {
      if (kind === "sign-in") await this.signIn(data);
      if (kind === "sign-up") await this.signUp(data);
      if (kind === "forgot") await this.forgotPassword(data);
      if (kind === "recovery-password") await this.updatePassword(data);
      if (kind === "account-email") await this.updateEmail(data);
      if (kind === "account-password") await this.updatePassword(data, true);
    } finally {
      this.busy = false;
      this.rerender();
    }
  }

  private configuredModal(): string {
    const close = `<button class="close" data-account-action="close" aria-label="Close account controls">${icon("X")}</button>`;
    const feedback = `${this.message ? `<div class="notice success" role="status">${icon("Check")}<span>${escapeHtml(this.message)}</span></div>` : ""}${this.error ? `<div class="notice warn" role="alert">${escapeHtml(this.error)}</div>` : ""}`;
    if (this.mode === "account" && this.session) {
      const email = this.session.user.email ?? "Signed in";
      return `<div class="mhead"><div><div id="account-title">Your account</div><div class="tiny">${escapeHtml(email)}</div></div>${close}</div>${feedback}<div class="account-status"><span>${icon("ShieldCheck")}</span><div><strong>Signed in</strong><small>Your session stays on this device until you sign out.</small></div></div><form data-account-form="account-email" class="account-section stack"><strong>Change email</strong>${emailField(email)}<button class="btn" ${this.disabled()}>Send confirmation</button></form><form data-account-form="account-password" class="account-section stack"><strong>Change password</strong>${passwordField("password", "New password", "new-password")}${passwordField("confirmPassword", "Confirm new password", "new-password")}<button class="btn" ${this.disabled()}>Update password</button></form><div class="mfooter"><button class="btn-danger" type="button" data-account-action="sign-out" ${this.disabled()}>Sign out</button></div>`;
    }
    if (this.mode === "sign-up") {
      return `<form data-account-form="sign-up"><div class="mhead"><div><div id="account-title">Create your account</div><div class="tiny">Set up secure sign-in for AIfoodpal</div></div>${close}</div>${feedback}${emailField()}${passwordField("password", "Password", "new-password")}${passwordField("confirmPassword", "Confirm password", "new-password")}<button class="btn-primary account-submit" ${this.disabled()}>Create account</button><button class="account-link" type="button" data-account-action="sign-in">Already have an account? Sign in</button></form>`;
    }
    if (this.mode === "forgot") {
      return `<form data-account-form="forgot"><div class="mhead"><div><div id="account-title">Reset your password</div><div class="tiny">We’ll email a secure recovery link</div></div>${close}</div>${feedback}${emailField()}<button class="btn-primary account-submit" ${this.disabled()}>Send recovery link</button><button class="account-link" type="button" data-account-action="sign-in">Back to sign in</button></form>`;
    }
    if (this.mode === "recovery") {
      return `<form data-account-form="recovery-password"><div class="mhead"><div><div id="account-title">Choose a new password</div><div class="tiny">Finish recovering your account</div></div>${close}</div>${feedback}${passwordField("password", "New password", "new-password")}${passwordField("confirmPassword", "Confirm new password", "new-password")}<button class="btn-primary account-submit" ${this.disabled()}>Update password</button></form>`;
    }
    return `<form data-account-form="sign-in"><div class="mhead"><div><div id="account-title">Welcome back</div><div class="tiny">Sign in to your AIfoodpal account</div></div>${close}</div>${feedback}${emailField()}${passwordField("password", "Password", "current-password")}<button class="btn-primary account-submit" ${this.disabled()}>Sign in</button><button class="account-link" type="button" data-account-action="forgot">Forgot password?</button><div class="account-divider"><span>New here?</span></div><button class="btn account-submit" type="button" data-account-action="sign-up">Create an account</button></form>`;
  }

  private unconfiguredModal(): string {
    return `<div class="mhead"><div><div id="account-title">Cloud accounts aren’t configured</div><div class="tiny">Local mode is still available</div></div><button class="close" data-account-action="close" aria-label="Close account controls">${icon("X")}</button></div><div class="account-status local"><span>${icon("ShieldCheck")}</span><div><strong>Your data remains in this browser</strong><small>Add the Supabase project URL and publishable key at deploy time to enable accounts.</small></div></div>`;
  }

  private async signIn(data: FormData): Promise<void> {
    const { data: result, error } = await this.auth!.signInWithPassword({ email: String(data.get("email")), password: String(data.get("password")) });
    if (error || !result.session) {
      this.error = "Email or password was not accepted.";
      return;
    }
    this.session = result.session;
    this.mode = "account";
    this.message = "Signed in.";
  }

  private async signUp(data: FormData): Promise<void> {
    if (!this.passwordsMatch(data)) return;
    const email = String(data.get("email"));
    const { data: result, error } = await this.auth!.signUp({
      email,
      password: String(data.get("password")),
      options: { emailRedirectTo: `${this.redirectUrl()}?confirmed=1` },
    });
    if (error) {
      this.error = "Could not create the account. Check the email and password and try again.";
      return;
    }
    this.session = result.session;
    this.message = "If that address can receive an account email, a confirmation link is on its way.";
    if (result.session) this.mode = "account";
  }

  private async forgotPassword(data: FormData): Promise<void> {
    const { error } = await this.auth!.resetPasswordForEmail(String(data.get("email")), { redirectTo: this.redirectUrl() });
    if (error) {
      this.error = "Could not send a recovery link right now. Try again in a moment.";
      return;
    }
    this.message = "If an account exists for that address, a recovery link is on its way.";
  }

  private async updatePassword(data: FormData, stayInAccount = false): Promise<void> {
    if (!this.passwordsMatch(data)) return;
    const { data: result, error } = await this.auth!.updateUser({ password: String(data.get("password")) });
    if (error) {
      this.error = "Could not update the password. Request a fresh recovery link and try again.";
      return;
    }
    this.session = result.user ? { ...this.session!, user: result.user } : this.session;
    this.mode = stayInAccount || this.session ? "account" : "sign-in";
    this.message = "Password updated.";
    this.clearAuthMarker();
  }

  private async updateEmail(data: FormData): Promise<void> {
    const email = String(data.get("email"));
    const { error } = await this.auth!.updateUser({ email }, { emailRedirectTo: `${this.redirectUrl()}?confirmed=1` });
    this.message = error ? "" : "Check both email addresses to confirm the change.";
    this.error = error ? "Could not start the email change." : "";
  }

  private async signOut(): Promise<void> {
    if (!this.auth || this.busy) return;
    this.busy = true;
    this.rerender();
    const { error } = await this.auth.signOut({ scope: "local" });
    this.busy = false;
    if (error) {
      this.error = "Could not sign out. Try again.";
    } else {
      this.session = null;
      this.mode = "sign-in";
      this.message = "Signed out on this device.";
    }
    this.rerender();
  }

  private authChanged(event: AuthChangeEvent, session: Session | null): void {
    const previous = `${this.session?.user.email ?? ""}|${this.mode ?? ""}|${this.message}|${this.error}`;
    this.session = session;
    if (event === "PASSWORD_RECOVERY") this.mode = "recovery";
    if (event === "SIGNED_OUT") this.mode = this.mode ? "sign-in" : null;
    if (event === "SIGNED_IN" && this.hasConfirmationMarker()) {
      this.mode = "account";
      this.message = "Email confirmed. You’re signed in.";
      this.clearAuthMarker();
    }
    const visible = `${this.session?.user.email ?? ""}|${this.mode ?? ""}|${this.message}|${this.error}`;
    if (visible !== previous) this.rerender();
  }

  private passwordsMatch(data: FormData): boolean {
    if (String(data.get("password")).length < 8) {
      this.error = "Use at least 8 characters for the password.";
      return false;
    }
    if (data.get("password") !== data.get("confirmPassword")) {
      this.error = "The passwords do not match.";
      return false;
    }
    return true;
  }

  private disabled(): string { return this.busy ? "disabled aria-busy=\"true\"" : ""; }
  private clearFeedback(): void { this.message = ""; this.error = ""; }
  private redirectUrl(): string { return `${window.location.origin}${window.location.pathname}`; }
  private hasConfirmationMarker(): boolean { return /(?:[?#&])(confirmed=1|type=signup)(?:&|$)/.test(window.location.href); }
  private clearAuthMarker(): void {
    const url = new URL(window.location.href);
    url.searchParams.delete("confirmed");
    url.searchParams.delete("recovery");
    if (url.hash === "#type=signup" || url.hash === "#type=recovery") url.hash = "";
    window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
  }
}

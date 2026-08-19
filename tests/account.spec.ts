// @vitest-environment jsdom

import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountController } from "../src/account";
import { DaybookApp } from "../src/app";
import { createState } from "../src/model";

const session = (email: string): Session => ({
  access_token: "access",
  refresh_token: "refresh",
  expires_in: 3600,
  token_type: "bearer",
  user: { id: "11111111-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated", email, app_metadata: {}, user_metadata: {}, created_at: "2026-08-19T00:00:00Z" },
} as Session);

describe("Supabase account browser flow", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="account-root"></div>';
    window.history.replaceState({}, "", "/");
  });

  it("covers restored sessions, signup, signin, signout, reset, recovery, and password update", async () => {
    let listener: ((event: AuthChangeEvent, session: Session | null) => void) | undefined;
    const restored = session("restored@example.com");
    const signedIn = session("person@example.com");
    const auth = {
      onAuthStateChange: vi.fn((callback: typeof listener) => {
        listener = callback;
        return { data: { subscription: { id: "test", callback, unsubscribe: vi.fn() } } };
      }),
      getSession: vi.fn(async () => ({ data: { session: restored }, error: null })),
      signUp: vi.fn(async () => ({ data: { user: null, session: null }, error: null })),
      signInWithPassword: vi.fn(async () => ({ data: { user: signedIn.user, session: signedIn }, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
      resetPasswordForEmail: vi.fn()
        .mockResolvedValueOnce({ data: {}, error: { message: "Unknown email: do not expose this" } })
        .mockResolvedValue({ data: {}, error: null }),
      updateUser: vi.fn(async () => ({ data: { user: signedIn.user }, error: null })),
    };
    const controller = new AccountController(auth as unknown as ConstructorParameters<typeof AccountController>[0]);
    const root = document.querySelector<HTMLElement>("#account-root")!;
    const render = (): void => { root.innerHTML = `${controller.headerHtml()}${controller.modalHtml()}`; };
    root.addEventListener("click", (event) => { controller.handleClick(event); });
    root.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = (event.target as Element).closest<HTMLFormElement>("form[data-form], form[data-account-form]")!;
      if (controller.handlesForm(form)) void controller.submit(form);
    });
    window.history.replaceState({}, "", "/?recovery=1");
    controller.start(render);
    render();

    await vi.waitFor(() => expect(root.querySelector(".account-trigger")?.textContent).toContain("restored@example.com"));
    root.querySelector<HTMLElement>('[data-account-action="open"]')!.click();
    expect(root.textContent).toContain("Your account");
    expect(root.textContent).not.toContain("Choose a new password");
    const unfinishedEmail = root.querySelector<HTMLInputElement>('form[data-account-form="account-email"] input[name="email"]')!;
    unfinishedEmail.value = "unfinished@example.com";
    listener?.("TOKEN_REFRESHED", { ...restored, access_token: "refreshed-access" });
    expect(root.querySelector<HTMLInputElement>('form[data-account-form="account-email"] input[name="email"]')?.value).toBe("unfinished@example.com");
    window.history.replaceState({}, "", "/?confirmed=1");
    listener?.("SIGNED_IN", restored);
    expect(root.textContent).toContain("Email confirmed");
    expect(window.location.search).toBe("");

    root.querySelector<HTMLElement>('[data-account-action="sign-out"]')!.click();
    await vi.waitFor(() => expect(root.textContent).toContain("Signed out on this device"));
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });

    root.querySelector<HTMLElement>('[data-account-action="sign-up"]')!.click();
    submit(root, "sign-up", { email: "new@example.com", password: "long-password", confirmPassword: "long-password" });
    await vi.waitFor(() => expect(root.textContent).toContain("a confirmation link is on its way"));
    expect(auth.signUp).toHaveBeenCalledOnce();

    root.querySelector<HTMLElement>('[data-account-action="sign-in"]')!.click();
    submit(root, "sign-in", { email: "person@example.com", password: "long-password" });
    await vi.waitFor(() => expect(root.textContent).toContain("person@example.com"));
    expect(auth.signInWithPassword).toHaveBeenCalledOnce();

    root.querySelector<HTMLElement>('[data-account-action="sign-out"]')!.click();
    await vi.waitFor(() => expect(root.textContent).toContain("Signed out on this device"));
    root.querySelector<HTMLElement>('[data-account-action="forgot"]')!.click();
    submit(root, "forgot", { email: "missing@example.com" });
    await vi.waitFor(() => expect(root.textContent).toContain("Could not send a recovery link right now"));
    expect(root.textContent).not.toContain("Unknown email");
    submit(root, "forgot", { email: "person@example.com" });
    await vi.waitFor(() => expect(root.textContent).toContain("If an account exists for that address"));
    expect(auth.resetPasswordForEmail).toHaveBeenCalledTimes(2);

    listener?.("PASSWORD_RECOVERY", signedIn);
    expect(root.textContent).toContain("Choose a new password");
    submit(root, "recovery-password", { password: "new-password", confirmPassword: "new-password" });
    await vi.waitFor(() => expect(root.textContent).toContain("Password updated"));
    expect(auth.updateUser).toHaveBeenCalledWith({ password: "new-password" });
    expect(root.textContent).toContain("Your account");
  });

  it("restores a delayed session without replacing an in-progress app form", async () => {
    let finishRestore: ((value: { data: { session: Session }; error: null }) => void) | undefined;
    const auth = {
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { id: "test", callback: vi.fn(), unsubscribe: vi.fn() } } })),
      getSession: vi.fn(() => new Promise<{ data: { session: Session }; error: null }>((resolve) => { finishRestore = resolve; })),
    };
    const root = document.querySelector<HTMLElement>("#account-root")!;
    const account = new AccountController(auth as unknown as ConstructorParameters<typeof AccountController>[0]);
    new DaybookApp(root, { load: () => createState("2026-08-18"), save: vi.fn() }, account).start();
    root.querySelector<HTMLElement>('[data-account-action="open"]')!.click();
    const signInEmail = root.querySelector<HTMLInputElement>('form[data-account-form="sign-in"] input[name="email"]')!;
    signInEmail.value = "typing@example.com";
    const age = root.querySelector<HTMLInputElement>('form[data-form="onboarding"] input[name="age"]')!;
    age.value = "47";

    finishRestore?.({ data: { session: session("restored@example.com") }, error: null });
    await vi.waitFor(() => expect(root.querySelector(".account-trigger")?.textContent).toContain("restored@example.com"));
    expect(root.textContent).toContain("Your account");
    expect(root.querySelector<HTMLInputElement>('form[data-form="onboarding"] input[name="age"]')).toBe(age);
    expect(age.value).toBe("47");
  });

  it("keeps sign-in input when delayed restoration finds no session", async () => {
    let finishRestore: ((value: { data: { session: null }; error: null }) => void) | undefined;
    const auth = {
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { id: "test", callback: vi.fn(), unsubscribe: vi.fn() } } })),
      getSession: vi.fn(() => new Promise<{ data: { session: null }; error: null }>((resolve) => { finishRestore = resolve; })),
    };
    const controller = new AccountController(auth as unknown as ConstructorParameters<typeof AccountController>[0]);
    const root = document.querySelector<HTMLElement>("#account-root")!;
    const render = (): void => { root.innerHTML = `${controller.headerHtml()}${controller.modalHtml()}`; };
    root.addEventListener("click", (event) => { controller.handleClick(event); });
    controller.start(render);
    render();
    root.querySelector<HTMLElement>('[data-account-action="open"]')!.click();
    const email = root.querySelector<HTMLInputElement>('form[data-account-form="sign-in"] input[name="email"]')!;
    email.value = "unfinished@example.com";

    finishRestore?.({ data: { session: null }, error: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.querySelector<HTMLInputElement>('form[data-account-form="sign-in"] input[name="email"]')).toBe(email);
    expect(email.value).toBe("unfinished@example.com");
  });
});

const submit = (root: HTMLElement, kind: string, values: Record<string, string>): void => {
  const form = root.querySelector<HTMLFormElement>(`form[data-account-form="${kind}"]`)!;
  for (const [name, value] of Object.entries(values)) {
    const input = form.elements.namedItem(name) as HTMLInputElement;
    input.value = value;
  }
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
};

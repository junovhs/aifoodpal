import { createClient } from "@supabase/supabase-js";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. See docs/supabase-setup.md.`);
  return value;
};

const url = required("SUPABASE_VERIFY_URL");
const key = required("SUPABASE_VERIFY_PUBLISHABLE_KEY");
const jwtRole = (value) => {
  const payload = value.split(".")[1];
  if (!payload) return null;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).role ?? null; }
  catch { return null; }
};
if (!url.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url)) {
  throw new Error("SUPABASE_VERIFY_URL must use HTTPS except for local Supabase.");
}
if (key.startsWith("sb_secret_") || /service[_-]?role/i.test(key) || jwtRole(key) === "service_role") {
  throw new Error("Use a publishable key. This verifier refuses elevated secrets.");
}

const credentials = {
  a: { email: required("SUPABASE_VERIFY_USER_A_EMAIL"), password: required("SUPABASE_VERIFY_USER_A_PASSWORD") },
  b: { email: required("SUPABASE_VERIFY_USER_B_EMAIL"), password: required("SUPABASE_VERIFY_USER_B_PASSWORD") },
};

const client = () => createClient(url, key, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});

const signIn = async (credentials) => {
  const instance = client();
  const { data, error } = await instance.auth.signInWithPassword(credentials);
  if (error || !data.user) throw new Error(`Could not sign in ${credentials.email}: ${error?.message ?? "no user returned"}`);
  return { instance, user: data.user };
};

const readOwn = async (instance) => {
  const { data, error } = await instance.from("daybooks").select("*").maybeSingle();
  if (error) throw error;
  return data;
};

const save = async (instance, expectedRevision, state) => {
  const { data, error } = await instance.rpc("save_daybook", {
    expected_revision: expectedRevision,
    next_state: state,
  });
  if (error) throw error;
  if (!data) throw new Error("save_daybook returned no row.");
  return data;
};

const marker = `verification-${new Date().toISOString()}`;
const state = (owner, step) => ({ schemaVersion: 1, verification: { marker, owner, step } });
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const a = await signIn(credentials.a);
const b = await signIn(credentials.b);
assert(a.user.id !== b.user.id, "Verification accounts must be different users.");

const existingA = await readOwn(a.instance);
const existingB = await readOwn(b.instance);
const savedA = await save(a.instance, existingA?.revision ?? 0, state("a", 1));
const savedB = await save(b.instance, existingB?.revision ?? 0, state("b", 1));
assert(savedA.user_id === a.user.id, "Account A saved another user's row.");
assert(savedB.user_id === b.user.id, "Account B saved another user's row.");

const secondBrowserA = await signIn(credentials.a);
const loadedA = await readOwn(secondBrowserA.instance);
const loadedB = await readOwn(b.instance);
assert(loadedA?.user_id === a.user.id && loadedA.state?.verification?.owner === "a", "A second client did not load account A's daybook.");
assert(loadedB?.user_id === b.user.id && loadedB.state?.verification?.owner === "b", "Account B did not remain isolated.");

const newerA = await save(secondBrowserA.instance, loadedA.revision, state("a", 2));
const { error: staleError } = await a.instance.rpc("save_daybook", {
  expected_revision: savedA.revision,
  next_state: state("a", "stale"),
});
assert(staleError?.code === "PT409", `Expected stale revision PT409, received ${staleError?.code ?? "no error"}.`);
assert(newerA.revision === loadedA.revision + 1, "Account A revision did not advance exactly once.");
assert((await readOwn(b.instance))?.state?.verification?.owner === "b", "Account A activity changed account B's row.");

await Promise.all([a.instance.auth.signOut(), b.instance.auth.signOut(), secondBrowserA.instance.auth.signOut()]);
console.log(`Supabase verification passed for two isolated users at marker ${marker}.`);

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./supabase-database";

export interface SupabaseConfig {
  url: string;
  publishableKey: string;
}

const isAllowedUrl = (url: URL): boolean =>
  url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);

const jwtRole = (key: string): string | null => {
  const payload = key.split(".")[1];
  if (!payload) return null;
  try {
    const base64 = payload.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const value = JSON.parse(atob(base64)) as { role?: unknown };
    return typeof value.role === "string" ? value.role : null;
  } catch {
    return null;
  }
};

export const readSupabaseConfig = (env: Record<string, unknown> = import.meta.env): SupabaseConfig | null => {
  const urlValue = String(env.VITE_SUPABASE_URL ?? "").trim();
  const key = String(env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "").trim();
  if (!urlValue && !key) return null;
  if (!urlValue || !key) throw new Error("Supabase requires both VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.");
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error("VITE_SUPABASE_URL must be a valid URL.");
  }
  if (!isAllowedUrl(url)) throw new Error("VITE_SUPABASE_URL must use HTTPS, except for localhost development.");
  if (/service[_-]?role/i.test(key) || key.startsWith("sb_secret_") || jwtRole(key) === "service_role") {
    throw new Error("Use a Supabase publishable key in the browser, never a secret or service-role key.");
  }
  return { url: url.href.replace(/\/$/, ""), publishableKey: key };
};

export const createBrowserSupabaseClient = (config: SupabaseConfig): SupabaseClient<Database> =>
  createClient<Database>(config.url, config.publishableKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce",
      persistSession: true,
    },
  });

export const supabaseConfig = readSupabaseConfig();
export const supabase = supabaseConfig ? createBrowserSupabaseClient(supabaseConfig) : null;

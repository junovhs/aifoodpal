import { supabase, supabaseConfig } from "./supabase";
import { validateCapturePayload, type CaptureMode } from "./ai-capture";
import type { FoodInput } from "./model";

/** Why a capture could not be completed, mirroring the function's codes plus client-only cases. */
export type CaptureErrorCode =
  | "signed-out"
  | "not-configured"
  | "limit-reached"
  | "bad-request"
  | "ai-unavailable"
  | "ai-invalid"
  | "offline";

/** A capture failure carrying a code the food editor can branch on and a message it can show. */
export class CaptureError extends Error {
  readonly code: CaptureErrorCode;

  constructor(code: CaptureErrorCode, message: string) {
    super(message);
    this.name = "CaptureError";
    this.code = code;
  }
}

/** What the browser sends to the ai-food function. */
export interface CaptureRequest {
  mode: CaptureMode;
  imageBase64: string;
  mimeType: string;
  note: string | null;
}

/** A validated food draft plus what is left of the caller's allowance. */
export interface CaptureResult {
  food: FoodInput;
  remaining: { today: number; month: number };
}

/** Sends one prepared photo for interpretation; injected into the food editor so tests can fake it. */
export type CaptureFoodClient = (request: CaptureRequest) => Promise<CaptureResult>;

/**
 * Call the ai-food Edge Function with the caller's session token.
 *
 * Plain fetch rather than functions.invoke, because a refusal is carried in the response
 * body — a limit-reached 429 has to reach the user as its own message, and invoke collapses
 * non-2xx replies into an opaque error.
 */
export const captureFoodViaSupabase: CaptureFoodClient = async (request) => {
  if (!supabase || !supabaseConfig) {
    throw new CaptureError("not-configured", "Photo capture needs a cloud account. Sign in to use it.");
  }

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new CaptureError("signed-out", "Sign in to use photo capture.");

  let response: Response;
  try {
    response = await fetch(`${supabaseConfig.url}/functions/v1/ai-food`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        apikey: supabaseConfig.publishableKey,
      },
      body: JSON.stringify(request),
    });
  } catch {
    throw new CaptureError("offline", "Could not reach the server. Check your connection and try again.");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CaptureError("ai-unavailable", "The server sent an unreadable reply.");
  }

  const body = payload as Partial<{ ok: boolean; code: CaptureErrorCode; error: string; food: FoodInput; remaining: { today: number; month: number } }>;
  if (!body.ok || !body.food) {
    throw new CaptureError(body.code ?? "ai-unavailable", body.error ?? "Photo capture failed. Try again.");
  }
  return { food: body.food, remaining: body.remaining ?? { today: 0, month: 0 } };
};

/**
 * Merge a validated reply onto the draft currently in the food form.
 *
 * Lives here rather than in the wire contract because it is the one piece of capture that
 * needs the app's domain model, and the contract has to stay importable by the Edge Function.
 *
 * A null or absent value never erases something the user already knows: the model returns
 * null for "not stated on the panel", which must not wipe a figure typed by hand.
 */
export const captureToFoodDraft = (current: FoodInput, payload: unknown): FoodInput => {
  const incoming = validateCapturePayload(payload);
  const nutrition: Record<string, unknown> = { ...(current.nutrition ?? {}) };
  for (const [key, value] of Object.entries(incoming.nutrition ?? {})) {
    if (value !== null && value !== undefined) nutrition[key] = value;
    else if (!(key in nutrition)) nutrition[key] = null;
  }

  const merged: FoodInput = {
    ...current,
    ...incoming,
    brand: incoming.brand ?? current.brand ?? null,
    notes: incoming.notes ?? current.notes ?? null,
    serving: { ...(current.serving ?? {}), ...(incoming.serving ?? {}) },
    nutrition: nutrition as FoodInput["nutrition"],
    recipe: incoming.recipe ?? current.recipe ?? null,
  };
  if (current.id) merged.id = current.id;
  else delete merged.id;
  return merged;
};

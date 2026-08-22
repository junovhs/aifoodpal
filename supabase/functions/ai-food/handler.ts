import {
  CAPTURE_MODES,
  CAPTURE_RESPONSE_SCHEMA,
  CREDIT_KIND_FOR_MODE,
  CaptureContractError,
  MODEL_FOR_MODE,
  NOTE_MAX_CHARS,
  buildCapturePrompt,
  validateCapturePayload,
  type CaptureMode,
  type CapturedFood,
} from "../../../src/ai-capture.ts";

/**
 * Decoded-byte ceiling for an uploaded photo. IMG-01 fits captures to a 768px long edge,
 * which lands well under 300KB, so this is headroom rather than a working limit: its job is
 * to stop an unbounded upload from reaching Gemini and being billed as dozens of tiles.
 */
export const MAX_IMAGE_BYTES = 1_500_000;

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** Why a capture request failed, so the food editor can pick the right message and status. */
export type AiFoodErrorCode =
  | "bad-request"
  | "limit-reached"
  | "not-configured"
  | "ai-unavailable"
  | "ai-invalid";

/** Remaining allowance after the call that was just charged, mirroring ai_credit_grant. */
export interface AiCreditGrant {
  remaining_today: number;
  remaining_month: number;
}

/** What the browser posts to /functions/v1/ai-food. A describe request carries no photo. */
export interface AiFoodRequest {
  mode: CaptureMode;
  imageBase64?: string | null;
  mimeType?: string | null;
  note?: string | null;
}

/** A validated food draft plus the caller's remaining allowance. */
export interface AiFoodSuccessBody {
  ok: true;
  food: CapturedFood;
  remaining: { today: number; month: number };
}

/** A refusal the browser can act on; `error` is safe to show the user verbatim. */
export interface AiFoodErrorBody {
  ok: false;
  code: AiFoodErrorCode;
  error: string;
}

/** HTTP status and body the Deno entry point serializes. */
export interface AiFoodResponse {
  status: number;
  body: AiFoodSuccessBody | AiFoodErrorBody;
}

/** One Gemini generation, already narrowed to what this function needs. */
export interface GenerateRequest {
  model: string;
  prompt: string;
  /** Absent for a describe request, which is text alone. */
  imageBase64: string | null;
  mimeType: string | null;
  schema: unknown;
}

/**
 * Everything the handler touches that is not pure, injected so the request rules can be
 * tested without Deno, a network, or a database.
 */
export interface AiFoodDeps {
  apiKey: string | null;
  /** Charges the caller's allowance against the mode's ledger kind; rejects with `{ code: "PT429" }` when a cap is hit. */
  consumeCredit: (kind: "label" | "estimate") => Promise<AiCreditGrant>;
  /** Returns the model's raw JSON text. */
  generate: (request: GenerateRequest) => Promise<string>;
}

const errorBody = (status: number, code: AiFoodErrorCode, error: string): AiFoodResponse => ({ status, body: { ok: false, code, error } });

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Byte length of a base64 payload without allocating the decoded buffer. */
export const base64Bytes = (value: string): number => {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(value.length / 4) * 3 - padding);
};

const errorCode = (error: unknown): string => (isRecord(error) && typeof error.code === "string" ? error.code : "");

/**
 * The whole request pipeline: validate, charge, generate, validate again.
 *
 * Order matters. Every cheap check runs before `consumeCredit`, so a malformed request can
 * never burn a credit, and `consumeCredit` runs before `generate`, so a caller at their cap
 * cannot spend money. A generation that comes back off-contract is refused outright rather
 * than half-applied to the user's food form.
 */
export const handleAiFood = async (payload: unknown, deps: AiFoodDeps): Promise<AiFoodResponse> => {
  if (!deps.apiKey) {
    return errorBody(503, "not-configured", "AI capture is not configured on this server yet.");
  }
  if (!isRecord(payload)) {
    return errorBody(400, "bad-request", "Send a JSON object.");
  }

  const { mode, imageBase64, mimeType, note } = payload as Partial<AiFoodRequest>;
  if (typeof mode !== "string" || !CAPTURE_MODES.includes(mode as CaptureMode)) {
    return errorBody(400, "bad-request", "Choose either label or estimate.");
  }
  if (note != null && (typeof note !== "string" || note.length > NOTE_MAX_CHARS)) {
    return errorBody(400, "bad-request", `Keep the note under ${NOTE_MAX_CHARS} characters.`);
  }

  // A describe request is the note alone: there is no photo to size or type-check, and the
  // note stops being optional context and becomes the only evidence the model gets.
  const describing = mode === "describe";
  if (describing) {
    if (typeof note !== "string" || note.trim().length === 0) {
      return errorBody(400, "bad-request", "Describe what you ate before sending it.");
    }
    if (typeof imageBase64 === "string" && imageBase64.length > 0) {
      return errorBody(400, "bad-request", "Choose a photo mode to send a photo.");
    }
  } else {
    if (typeof mimeType !== "string" || !ALLOWED_MIME_TYPES.includes(mimeType)) {
      return errorBody(400, "bad-request", "Send a JPEG, PNG, or WebP photo.");
    }
    if (typeof imageBase64 !== "string" || imageBase64.length === 0) {
      return errorBody(400, "bad-request", "Send a photo with the request.");
    }
    if (base64Bytes(imageBase64) > MAX_IMAGE_BYTES) {
      return errorBody(413, "bad-request", "That photo is too large. Take it again from the app so it is resized.");
    }
  }

  let grant: AiCreditGrant;
  try {
    grant = await deps.consumeCredit(CREDIT_KIND_FOR_MODE[mode as CaptureMode]);
  } catch (error) {
    if (errorCode(error) === "PT429") {
      return errorBody(429, "limit-reached", error instanceof Error ? error.message : "You have used up your AI capture allowance.");
    }
    throw error;
  }

  let raw: string;
  try {
    raw = await deps.generate({
      model: MODEL_FOR_MODE[mode as CaptureMode],
      prompt: buildCapturePrompt(mode as CaptureMode, note ?? null),
      imageBase64: describing ? null : imageBase64 as string,
      mimeType: describing ? null : mimeType as string,
      schema: CAPTURE_RESPONSE_SCHEMA,
    });
  } catch (error) {
    return errorBody(502, "ai-unavailable", error instanceof Error ? error.message : "The AI service did not respond.");
  }

  let food: CapturedFood;
  try {
    food = validateCapturePayload(JSON.parse(raw) as unknown);
  } catch (error) {
    const detail = error instanceof CaptureContractError || error instanceof Error ? error.message : "";
    return errorBody(502, "ai-invalid", `The AI reply did not match the expected format. ${detail}`.trim());
  }

  return {
    status: 200,
    body: { ok: true, food, remaining: { today: grant.remaining_today, month: grant.remaining_month } },
  };
};

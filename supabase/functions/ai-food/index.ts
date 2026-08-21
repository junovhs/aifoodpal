// Deno entry point for the ai-food Edge Function. Everything decidable without Deno, a
// network, or a database lives in ./handler.ts and is covered by tests/ai-food-function.spec.ts;
// this file is only the transport: read the request, build the real dependencies, serve.
//
// Deployment note for OPS-01: handler.ts imports the shared contract from ../../../src, whose
// modules use extensionless specifiers. deno.json in this directory enables sloppy-imports so
// Deno resolves them. If `supabase functions deploy ai-food` rejects that, the contained fix is
// to add explicit .ts extensions to the imports in handler.ts and src/ai-capture.ts.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleAiFood, type AiCreditGrant, type GenerateRequest } from "./handler.ts";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

/** Ask Gemini for one food, constrained to the shared response schema. */
const generate = async (apiKey: string, request: GenerateRequest): Promise<string> => {
  const response = await fetch(`${GEMINI_ENDPOINT}/${request.model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [
          { text: request.prompt },
          { inline_data: { mime_type: request.mimeType, data: request.imageBase64 } },
        ],
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: request.schema,
        temperature: 0,
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Gemini returned ${response.status}. ${detail.slice(0, 300)}`.trim());
  }

  const payload = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  };
  const candidate = payload.candidates?.[0];
  const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  if (text.trim().length === 0) {
    // A blocked or truncated generation returns no usable text; say which, so the browser
    // can tell "try a clearer photo" apart from "the service is down".
    throw new Error(`Gemini returned no usable content${candidate?.finishReason ? ` (${candidate.finishReason})` : ""}.`);
  }
  return text;
};

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json(405, { ok: false, code: "bad-request", error: "Use POST." });

  // Forward the caller's JWT so the RPC runs as them: consume_ai_credit resolves the user
  // from the request claims and RLS confines it to their own rows. No service key is used.
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization) return json(401, { ok: false, code: "bad-request", error: "Sign in to use AI capture." });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } },
  );

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json(400, { ok: false, code: "bad-request", error: "Send a JSON body." });
  }

  const apiKey = Deno.env.get("GEMINI_API_KEY") ?? null;

  try {
    const result = await handleAiFood(payload, {
      apiKey,
      consumeCredit: async (mode): Promise<AiCreditGrant> => {
        const { data, error } = await supabase.rpc("consume_ai_credit", { capture_kind: mode });
        if (error) throw error;
        return data as AiCreditGrant;
      },
      generate: (generateRequest) => generate(apiKey as string, generateRequest),
    });
    return json(result.status, result.body);
  } catch (error) {
    console.error("ai-food failed", error);
    return json(500, { ok: false, code: "ai-unavailable", error: "AI capture failed. Try again." });
  }
});

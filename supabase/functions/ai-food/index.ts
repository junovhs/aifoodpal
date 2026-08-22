// Deno entry point for the ai-food Edge Function. Everything decidable without Deno, a
// network, or a database lives in ./handler.ts and is covered by tests/ai-food-function.spec.ts;
// this file is only the transport: read the request, build the real dependencies, serve.
//
// Deployment note for OPS-01: this file and handler.ts import the shared contract from ../../../src, whose
// modules use extensionless specifiers. deno.json in this directory enables sloppy-imports so
// Deno resolves them. If `supabase functions deploy ai-food` rejects that, the contained fix is
// to add explicit .ts extensions to the imports in handler.ts and src/ai-capture.ts.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleAiFood, type AiCreditGrant, type GenerateRequest } from "./handler.ts";
import { CAPTURE_RESPONSE_FORMAT } from "../../../src/ai-capture.ts";

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

/**
 * Ask OpenRouter for one food, constrained to the shared response schema.
 *
 * OpenRouter is a passthrough at the provider's own rates, so this costs the same per call as
 * talking to Google directly; it exists so the key is an OpenRouter key with its own hard
 * per-key spend limit rather than a Google Cloud billing account.
 */
const generate = async (apiKey: string, request: GenerateRequest): Promise<string> => {
  const response = await fetch(OPENROUTER_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      // Attribution headers; OpenRouter shows these on the activity page per app.
      "HTTP-Referer": "https://aifoodpal.app",
      "X-Title": "AIfoodpal",
    },
    body: JSON.stringify({
      model: request.model,
      messages: [{
        role: "user",
        // A describe request carries no image part at all — an empty data URI would be an
        // upload failure to the provider, not an absent photo.
        content: request.imageBase64
          ? [
            { type: "text", text: request.prompt },
            { type: "image_url", image_url: { url: `data:${request.mimeType};base64,${request.imageBase64}` } },
          ]
          : [{ type: "text", text: request.prompt }],
      }],
      response_format: CAPTURE_RESPONSE_FORMAT,
      temperature: 0,
      usage: { include: true },
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`OpenRouter returned ${response.status}. ${detail.slice(0, 300)}`.trim());
  }

  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    error?: { message?: string };
  };

  if (payload.error?.message) throw new Error(`OpenRouter: ${payload.error.message}`);

  // Real token counts, so the caps and model choices can be tuned against observed cost
  // instead of estimates. Visible in `supabase functions logs ai-food`.
  const usage = payload.usage;
  if (usage) {
    console.log(`ai-food usage model=${request.model} in=${usage.prompt_tokens ?? "?"} out=${usage.completion_tokens ?? "?"} cost=${usage.cost ?? "?"}`);
  }

  const choice = payload.choices?.[0];
  const text = choice?.message?.content ?? "";
  if (text.trim().length === 0) {
    // A blocked or truncated generation returns no usable text; say which, so the browser
    // can tell "try a clearer photo" apart from "the service is down".
    throw new Error(`OpenRouter returned no usable content${choice?.finish_reason ? ` (${choice.finish_reason})` : ""}.`);
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

  const apiKey = Deno.env.get("OPENROUTER_API_KEY") ?? null;

  try {
    const result = await handleAiFood(payload, {
      apiKey,
      consumeCredit: async (kind): Promise<AiCreditGrant> => {
        const { data, error } = await supabase.rpc("consume_ai_credit", { capture_kind: kind });
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

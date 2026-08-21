# AI photo capture

How a photo of a package or a plate becomes a food entry, and everything you need to
operate it. This path is deployed and working; the notes below are what a fresh session
needs in order to change it safely.

For accounts and daybook sync, see [the Supabase setup guide](supabase-setup.md). This
document covers only the capture path built on top of it.

## What happens when you take a photo

```
browser                                 Supabase                       OpenRouter
───────                                 ────────                       ──────────
prepareImage()      fit to 768px long edge, JPEG q0.8
   │
   ├─ scanBarcode()  ── Open Food Facts ──►  free, no AI, no credit
   │                    hit? done.
   │  miss ▼
captureFoodViaSupabase()
   │  POST /functions/v1/ai-food  (session JWT)
   └──────────────────────────────►  ai-food
                                       │ validate request
                                       │ consume_ai_credit()  ── charge or refuse
                                       │ generate() ──────────────────►  model
                                       │ validate reply against schema  ◄──
                                       ▼
                                     { ok, food, remaining }
   ◄───────────────────────────────────
captureToFoodDraft()  merge into the open form; the user reviews and saves
```

Nothing is saved automatically. The capture fills the form; the user presses save. A wrong
estimate is a correction, not a bad entry in the library.

## The pieces

| Concern | Lives in |
| --- | --- |
| Downscaling a capture | `src/image.ts` |
| The wire contract: modes, prompts, schema | `src/ai-capture.ts` |
| Merging a reply into the open form | `src/capture-client.ts` |
| Calling the function from the browser | `src/capture-client.ts` |
| Barcode decode and Open Food Facts | `src/barcode.ts` |
| Request pipeline (pure, tested) | `supabase/functions/ai-food/handler.ts` |
| Deno transport and the model call | `supabase/functions/ai-food/index.ts` |
| Spend ledger and caps | `supabase/migrations/20260821000000_create_ai_usage.sql` |

### `src/ai-capture.ts` must not import anything

This is load-bearing, not stylistic. The Edge Function imports this module, and Supabase
uploads only the files the function's module graph reaches. An `import type` is erased when
Deno emits, but Deno still resolves it while building the graph — so importing the app's
domain model uploaded a file that pulled in `./units`, and the function failed to start with
`BOOT_ERROR`. See FIX-11.

The rule: `src/ai-capture.ts` is a leaf. Anything the function needs goes in it or in
`handler.ts`. Anything needing the domain model goes in `capture-client.ts`. Cross-directory
imports inside `supabase/functions/` carry an explicit `.ts` extension so Deno never guesses;
`allowImportingTsExtensions` is on in `tsconfig.json` to keep TypeScript happy with that.

## Two capture modes

Both send the same request shape. They differ in prompt and model.

| | `label` | `estimate` |
| --- | --- | --- |
| Reads | a printed nutrition panel | a plate of food |
| Model | `google/gemini-2.5-flash-lite` | `google/gemini-2.5-flash` |
| Cost per capture | ~$0.00041 | ~$0.00175 |
| Rule | transcribe, never estimate | judge the portion; the note wins over the photo |

Transcription is nearly mechanical, so it runs on the cheap model. Judging a portion is real
reasoning and gets the stronger one — a roughly 4x cost difference that maps onto a real
difference in difficulty.

The user's free-text note is **authoritative** and overrides what the photo appears to show.
This is verified behaviour, not an aspiration: sending a photo of a nutrition panel with the
note "ignore what the picture looks like: this was a bowl of lamb stew, quite fatty, about
two cups" returns a lamb stew estimate.

### Structured output is what makes this reliable

The reply is constrained by `CAPTURE_RESPONSE_SCHEMA`, sent as OpenRouter's
`response_format: { type: "json_schema", strict: true }`. That removes the entire class of
parse failures the old clipboard bridge suffered — code fences, prose wrappers, smart quotes.

Strict mode has three requirements that shape the schema: every object closes with
`additionalProperties: false`, every property appears in `required`, and optionality is a
`["number", "null"]` union rather than an omitted key. So "the panel does not state fiber"
arrives as an explicit `null`, which the merge already treats as "leave what the user typed
alone".

The reply is validated again on receipt anyway. A truncated or safety-filtered generation can
still come back off-contract, and a half-populated food form is worse than a refused one.

## Spend controls

Three independent ceilings, plus the credit balance itself, which cannot overdraft.

**1. Per-user caps, in the database.** `consume_ai_credit(capture_kind)` in
`supabase/migrations/20260821000000_create_ai_usage.sql` charges one capture and returns what
remains, or raises `PT429`. Defaults are **40/day and 500/month**, as `plpgsql` constants
inside the function so a caller cannot raise its own ceiling.

Raising the exception aborts the calling statement, which rolls back the increment — a
refused call is never charged. `PT429` is a PostgREST status-mapping code that reaches the
browser as HTTP 429; a bare Postgres errcode would surface as an opaque 500.

The parameter is `capture_kind`, not `kind`: an unqualified `kind` inside the `INSERT` is
ambiguous against `ai_usage.kind` and fails at runtime with SQLSTATE 42702.

**2. Request limits, in the function.** `MAX_IMAGE_BYTES` (1.5 MB decoded) and
`NOTE_MAX_CHARS` (500). Every cheap check runs *before* `consumeCredit`, so a malformed
request cannot burn a credit; `consumeCredit` runs *before* `generate`, so a caller at their
cap cannot spend money.

**3. Per-key limit, at OpenRouter.** The API key carries a credit limit with a daily reset.
Requests past it are rejected before reaching the provider, so they cost nothing.

Nothing here uses a service-role key. The browser's JWT is forwarded into a supabase-js
client so `consume_ai_credit` runs as that user under RLS.

## Costs

Measured, not estimated. A capture is roughly 2,500 input tokens (about 1,000–1,600 for a
768px image at 258 tokens per 768x768 tile, plus the prompt) and about 400 output tokens.

| | per capture | 10/day |
| --- | --- | --- |
| Barcode hit (Open Food Facts) | $0 | $0 |
| Label read (flash-lite) | ~$0.00041 | ~$0.12/mo |
| Plate estimate (flash) | ~$0.00175 | ~$0.53/mo |

A realistic mix lands near **$0.33/month**. A $5 credit balance covers well over a year.

OpenRouter resells these models at the provider's own rates, so routing through it costs
nothing extra per call. It is used because Google's direct API requires a $10 prepaid Cloud
billing balance, and because OpenRouter offers per-key spend limits.

Note OpenRouter's own economics when topping up: the minimum purchase is $5 and the fee has
an $0.80 floor, so a $5 top-up costs $5.80 (~16%). Larger top-ups approach the stated 5.5%.

## Operating it

The project is linked in this checkout. `supabase login` is interactive and must be run by a
human; everything below works once it is.

```sh
# what is applied where
npx supabase migration list --linked

# apply a new migration (always dry-run first)
npx supabase db push --dry-run
npx supabase db push

# deploy the function
npx supabase functions deploy ai-food

# confirm the secret exists (prints digests, never values)
npx supabase secrets list

# set or rotate the key — run this yourself; never paste a key into a transcript
npx supabase secrets set OPENROUTER_API_KEY=sk-or-v1-...
```

Deploy uploads only the modules the function imports. **Check that list.** A successful
deploy does not mean the function boots — verify with a real request.

### Smoke-testing the deployed endpoint

`verify_jwt` is on, so a request needs a real session token. The anon key is a valid JWT and
gets past the gateway, but it carries no `sub`, so `consume_ai_credit` raises "Authentication
required" — enough to prove the module loads, not enough to exercise the whole path.

For an end-to-end check, create a throwaway user with the service-role key via
`POST /auth/v1/admin/users`, sign in through `POST /auth/v1/token?grant_type=password` for an
access token, then `POST /functions/v1/ai-food` with `{ mode, imageBase64, mimeType, note }`.
Delete the user afterwards; its `ai_usage` rows cascade.

Expected replies:

- no key configured — `{"ok":false,"code":"not-configured"}`, HTTP 503
- unknown mode — `{"ok":false,"code":"bad-request"}`, HTTP 400, in about 0.3s, nothing spent
- success — `{"ok":true,"food":{…},"remaining":{"today":N,"month":N}}`, HTTP 200

Observed latency is 2.9–4.2s for a successful capture.

The function logs token counts and cost per call via `console.log`. This CLI version has no
`functions logs` subcommand — read them from the Supabase dashboard or OpenRouter's activity
page.

## Known constraints, learned the hard way

- **A green deploy is not a working function.** `BOOT_ERROR` looks identical to success at
  the CLI. Always follow a deploy with a real request.
- **Prompt instructions need an actionable fallback.** Telling the model to "use a short
  description if no product name is visible" still produced "Nutrition Facts", because a bare
  panel gives it nothing to describe. Naming an exact fallback string fixed it. See FIX-12.
- **Prefer grams to household measures.** A panel reading "2/3 cup (55g)" returned
  `amount: 2, unit: "cup"` — a threefold error sitting next to perfectly correct nutrition,
  with nothing on screen to reveal it. The prompt now takes the metric weight and keeps the
  printed text in `description`.
- **A photo cannot establish scale.** Without a reference object, portion estimates are
  roughly ±2x. A real 40 g steak came back as 3 oz — the model reached for the standard
  serving because the note said only "steak". The note is the fix; see DEC-03 and UX-09.
- **No iOS browser implements `BarcodeDetector`.** They are all WebKit underneath. iPhones
  use a lazily-loaded ZXing wasm reader (~1.1 MB, its own chunk, fetched only on first use);
  Android uses the native detector.

## Still unverified

- A real photographed package under kitchen lighting — curve, glare, small ingredient type.
  Everything tested so far was a cleanly rendered synthetic panel.
- The barcode path on Android (the native detector). The iPhone wasm path is confirmed
  working, including from a whole-package photo rather than a tight barcode crop.
- A product Open Food Facts does not carry, falling through to the AI label read. This is the
  only untested failure path in the chain.
- `browserImageCodec` in `src/image.ts` — covered by typecheck and the bundler, never by a
  real canvas.

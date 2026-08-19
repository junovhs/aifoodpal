# AIfoodpal

AIfoodpal is a local-first food diary with optional Supabase email/password accounts and revision-safe cross-device sync.

## Run locally

```sh
npm install
cp .env.example .env.local
npm run dev
```

Without the two Supabase environment variables the app intentionally stays in browser-only mode. For accounts and cloud sync, follow [the Supabase setup and verification guide](docs/supabase-setup.md).

## Quality gates

```sh
npm test
npm run check
npm run build
```

After configuring a disposable local or staging project and two verified test accounts, run the live isolation and continuity check described in the setup guide with `npm run verify:supabase`.


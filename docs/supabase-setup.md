# Supabase account setup

This guide enables email/password accounts, recovery, and cloud daybook sync. The app remains fully usable in local browser mode when Supabase is not configured.

## 1. Create and configure the project

Create a Supabase project, then copy its project URL and **publishable** key from the project Connect dialog or Settings > API Keys. A publishable key is safe for browser use because authorization is enforced by Row Level Security.

Never expose an `sb_secret_...` key or legacy `service_role` JWT. The app rejects either at startup.

In Authentication:

1. Under Sign In / Providers, enable Email and keep email confirmation enabled for production.
2. Under URL Configuration, set **Site URL** to the canonical production origin, including any deployed base path, for example `https://food.example.com/`.
3. Add every exact callback location used by the app to **Redirect URLs**. At minimum add the production location and the two local development locations:

   ```text
   https://food.example.com/
   http://localhost:5173/
   http://127.0.0.1:5173/
   ```

   The app derives callbacks from its current `origin + pathname`, so a subpath deployment such as `https://example.com/food/` must be allow-listed with that path. Add staging and preview URLs deliberately; avoid a broad production wildcard.

4. Review the Confirm signup, Change email address, and Reset password templates under Email Templates. Keep the action link based on `{{ .ConfirmationURL }}`. If you replace the default link, preserve the supplied `{{ .RedirectTo }}` rather than hard-coding a host. Disable link rewriting/tracking in an external email provider because rewritten verification links can fail.
5. Configure a production SMTP provider before inviting real users. Supabase's built-in sender is suitable only for initial testing and is rate-limited.

The checked-in [`supabase/config.toml`](../supabase/config.toml) already contains the local Site URL and redirect allow-list.

## 2. Apply the database migration

Install the Supabase CLI, authenticate it, and link this checkout to the intended project:

```sh
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push --dry-run
supabase db push
```

Review the project reference before the final command. Do not use `db reset --linked` on production; it deletes remote data.

The migration creates one `public.daybooks` JSON document per auth user. Authenticated users can select only their own row, cannot mutate the table directly, and must save through `save_daybook(expected_revision, next_state)`. A stale revision is rejected instead of overwriting a newer device.

## 3. Configure the web build

Copy `.env.example` to `.env.local` for local development, or set the same variables in the hosting provider:

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_KEY
```

Both values are required together. Production URLs must use HTTPS. Restart the dev server after changing them.

Verify the configuration before deploying:

```sh
npm test
npm run check
npm run build
```

Open the app and confirm the header says **Account**, not **Cloud off**. Create an account, click the confirmation email on the same browser that started signup (PKCE keeps a verifier on that browser), then sign in.

## 4. Verify a local or staging project

Use two dedicated, verified test accounts. The automated check writes complete test daybooks to both accounts, so never point it at real user accounts.

```sh
export SUPABASE_VERIFY_URL=https://YOUR_PROJECT_REF.supabase.co
export SUPABASE_VERIFY_PUBLISHABLE_KEY=sb_publishable_YOUR_KEY
export SUPABASE_VERIFY_USER_A_EMAIL=verify-a@example.com
export SUPABASE_VERIFY_USER_A_PASSWORD='unique-test-password-a'
export SUPABASE_VERIFY_USER_B_EMAIL=verify-b@example.com
export SUPABASE_VERIFY_USER_B_PASSWORD='unique-test-password-b'
npm run verify:supabase
```

The command signs in as both users using only the browser-safe key and verifies:

- each account sees only its own row;
- a second client signed in as account A loads A's saved daybook;
- account B's daybook remains different and private;
- a stale save is rejected with a revision conflict.

Complete the email portion manually because it depends on your mail provider:

1. In a private browser, choose **Forgot password?** for account A.
2. Follow the newest reset email. Confirm it returns to the configured app location and shows **Choose a new password**.
3. Set a new password, sign out, and sign back in with it.
4. Start an email change and confirm the required messages arrive and return to the app.

Finally test local migration and continuity:

1. While signed out, add a clearly named food entry.
2. Sign in to an empty verification account. The app must ask before uploading the existing device data.
3. Approve the migration and wait for **Synced**.
4. Sign into the same account in a second browser profile and verify the entry appears.
5. Edit from both profiles without refreshing one. The stale profile must show **Sync conflict** and require an explicit choice.

## Troubleshooting

- Redirected to localhost in production: correct Site URL and add the exact production app location to Redirect URLs.
- Confirmation or recovery returns without a session: request a fresh link in the same browser that initiated the PKCE flow and check that email-link tracking is disabled.
- App says Cloud off: both `VITE_...` variables must be present when Vite builds or starts.
- Startup rejects the key: use a publishable key, not a secret or service-role key.
- Migration command fails: confirm the linked project and run `supabase db push --dry-run`; do not repair migration history until the drift is understood.

References: [API keys](https://supabase.com/docs/guides/getting-started/api-keys), [redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls), [email templates](https://supabase.com/docs/guides/auth/auth-email-templates), and [database migrations](https://supabase.com/docs/guides/deployment/database-migrations).


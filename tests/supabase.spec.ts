import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import migration from "../supabase/migrations/20260819030000_create_daybooks.sql?raw";
import callerIdMigration from "../supabase/migrations/20260819040000_daybook_caller_id_without_auth_schema.sql?raw";
import conflictCodeMigration from "../supabase/migrations/20260819050000_daybook_conflict_status_code.sql?raw";
import { readSupabaseConfig } from "../src/supabase";

const userOne = "11111111-1111-4111-8111-111111111111";
const userTwo = "22222222-2222-4222-8222-222222222222";
const state = (label: string): string => JSON.stringify({ schemaVersion: 1, label });

const databases: PGlite[] = [];
const database = async (): Promise<PGlite> => {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`
    alter role postgres bypassrls;
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  `);
  await db.exec(migration);
  await db.exec(callerIdMigration);
  await db.exec(conflictCodeMigration);
  await db.exec(`
    insert into auth.users (id) values ('${userOne}'), ('${userTwo}');
    insert into public.daybooks (user_id, state, revision) values
      ('${userOne}', '${state("one")}'::jsonb, 1),
      ('${userTwo}', '${state("two")}'::jsonb, 1);
  `);
  return db;
};

const authenticate = async (db: PGlite, userId: string): Promise<void> => {
  await db.exec(`set role authenticated; set "request.jwt.claim.sub" = '${userId}';`);
};

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("Supabase browser configuration", () => {
  it("is optional until configured and rejects unsafe browser settings", () => {
    expect(readSupabaseConfig({})).toBeNull();
    expect(() => readSupabaseConfig({ VITE_SUPABASE_URL: "https://example.supabase.co" })).toThrow(/requires both/i);
    expect(() => readSupabaseConfig({ VITE_SUPABASE_URL: "http://example.com", VITE_SUPABASE_PUBLISHABLE_KEY: "public" })).toThrow(/HTTPS/i);
    expect(() => readSupabaseConfig({ VITE_SUPABASE_URL: "https://example.supabase.co", VITE_SUPABASE_PUBLISHABLE_KEY: "sb_secret_nope" })).toThrow(/never a secret/i);
    expect(() => readSupabaseConfig({ VITE_SUPABASE_URL: "https://example.supabase.co", VITE_SUPABASE_PUBLISHABLE_KEY: "eyJhbGciOiJub25lIn0.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature" })).toThrow(/never a secret/i);
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: "http://127.0.0.1:54321/", VITE_SUPABASE_PUBLISHABLE_KEY: "local-anon-key" })).toEqual({
      url: "http://127.0.0.1:54321",
      publishableKey: "local-anon-key",
    });
  });
});

describe("daybooks row-level authorization", () => {
  it("applies as a non-superuser migration administrator", async () => {
    const db = new PGlite();
    databases.push(db);
    await db.exec(`
      create role migrator login createrole;
      create role anon nologin;
      create role authenticated nologin;
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema public to migrator with grant option;
      grant create on schema public to migrator with grant option;
      grant usage on schema auth to migrator with grant option;
      grant references on auth.users to migrator;
      grant execute on function auth.uid() to migrator with grant option;
      set role migrator;
    `);
    await db.exec(migration);
    await db.exec(callerIdMigration);
    await db.exec(conflictCodeMigration);
    const ownership = await db.query<{ owner: string; migration_role_can_set_writer: boolean }>(`
      select pg_get_userbyid(proowner) as owner,
             pg_has_role('migrator', 'aifoodpal_daybook_writer', 'set') as migration_role_can_set_writer
      from pg_proc
      where proname = 'save_daybook'
    `);
    expect(ownership.rows).toEqual([{ owner: "aifoodpal_daybook_writer", migration_role_can_set_writer: false }]);
  });

  it("saves without any privilege on the auth schema", async () => {
    const db = await database();
    // Hosted Supabase owns the auth schema as supabase_admin, so the migration
    // administrator cannot actually grant the writer role access to it.
    await db.exec("revoke all on schema auth from aifoodpal_daybook_writer");
    await db.exec("revoke all on function auth.uid() from aifoodpal_daybook_writer");
    const usable = await db.query<{ auth_usage: boolean }>(
      "select has_schema_privilege('aifoodpal_daybook_writer', 'auth', 'USAGE') as auth_usage",
    );
    expect(usable.rows).toEqual([{ auth_usage: false }]);
    await authenticate(db, userOne);
    const saved = await db.query<{ user_id: string; revision: number }>(
      `select * from public.save_daybook(1, '${state("no-auth-schema")}'::jsonb)`,
    );
    expect(saved.rows[0]).toMatchObject({ user_id: userOne, revision: 2 });
  });

  it("shows authenticated users only their own aggregate", async () => {
    const db = await database();
    await authenticate(db, userOne);
    const result = await db.query<{ user_id: string }>("select user_id from public.daybooks");
    expect(result.rows).toEqual([{ user_id: userOne }]);
  });

  it("denies unauthenticated access and direct writes", async () => {
    const db = await database();
    await db.exec("set role anon");
    await expect(db.query("select * from public.daybooks")).rejects.toThrow(/permission denied/i);
    await db.exec("reset role");
    await authenticate(db, userOne);
    await expect(db.exec(`update public.daybooks set state = '${state("overwrite")}'::jsonb`)).rejects.toThrow(/permission denied/i);
    await expect(db.exec("delete from public.daybooks")).rejects.toThrow(/permission denied/i);
  });

  it("saves only the caller's row and rejects stale revisions", async () => {
    const db = await database();
    const owner = await db.query<{ rolname: string; rolbypassrls: boolean }>(`
      select role.rolname, role.rolbypassrls
      from pg_proc procedure
      join pg_roles role on role.oid = procedure.proowner
      where procedure.proname = 'save_daybook'
    `);
    expect(owner.rows).toEqual([{ rolname: "aifoodpal_daybook_writer", rolbypassrls: false }]);
    await db.exec(`set role aifoodpal_daybook_writer; set "request.jwt.claim.sub" = '${userOne}';`);
    const crossUserWrite = await db.query<{ user_id: string }>(`
      update public.daybooks set state = '${state("cross-user")}'::jsonb where user_id = '${userTwo}' returning user_id
    `);
    expect(crossUserWrite.rows).toEqual([]);
    await db.exec("reset role");
    await authenticate(db, userOne);
    const saved = await db.query<{ user_id: string; revision: number }>(
      `select * from public.save_daybook(1, '${state("updated")}'::jsonb)`,
    );
    expect(saved.rows[0]).toMatchObject({ user_id: userOne, revision: 2 });
    await expect(db.query(`select public.save_daybook(1, '${state("stale")}'::jsonb)`)).rejects.toThrow(/revision conflict/i);
    await db.exec("reset role");
    const other = await db.query<{ state: { label: string }; revision: number }>(`select state, revision from public.daybooks where user_id = '${userTwo}'`);
    expect(other.rows[0]).toMatchObject({ state: { label: "two" }, revision: 1 });
  });
});

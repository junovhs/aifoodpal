import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import daybookMigration from "../supabase/migrations/20260819030000_create_daybooks.sql?raw";
import callerIdMigration from "../supabase/migrations/20260819040000_daybook_caller_id_without_auth_schema.sql?raw";
import conflictCodeMigration from "../supabase/migrations/20260819050000_daybook_conflict_status_code.sql?raw";
import aiUsageMigration from "../supabase/migrations/20260821000000_create_ai_usage.sql?raw";

const userOne = "11111111-1111-4111-8111-111111111111";
const userTwo = "22222222-2222-4222-8222-222222222222";

const DAILY_CAP = 40;
const MONTHLY_CAP = 500;

interface Grant { remaining_today: number; remaining_month: number }

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
  await db.exec(daybookMigration);
  await db.exec(callerIdMigration);
  await db.exec(conflictCodeMigration);
  await db.exec(aiUsageMigration);
  await db.exec(`insert into auth.users (id) values ('${userOne}'), ('${userTwo}');`);
  return db;
};

const authenticate = async (db: PGlite, userId: string): Promise<void> => {
  await db.exec(`reset role; set role authenticated; set "request.jwt.claim.sub" = '${userId}';`);
};

const consume = async (db: PGlite, kind: "label" | "estimate"): Promise<Grant> => {
  const result = await db.query<Grant>(`select * from public.consume_ai_credit('${kind}')`);
  return result.rows[0]!;
};

/** Charge `count` calls directly, as prior usage, without going through the cap check. */
const seed = async (db: PGlite, userId: string, day: string, kind: string, calls: number): Promise<void> => {
  await db.exec(`
    reset role;
    insert into public.ai_usage (user_id, day, kind, calls)
    values ('${userId}', '${day}'::date, '${kind}', ${calls})
    on conflict (user_id, day, kind) do update set calls = excluded.calls;
  `);
};

const today = (): string => new Date().toISOString().slice(0, 10);

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("AI capture allowance", () => {
  it("charges a call and reports what is left", async () => {
    const db = await database();
    await authenticate(db, userOne);

    expect(await consume(db, "label")).toEqual({ remaining_today: DAILY_CAP - 1, remaining_month: MONTHLY_CAP - 1 });
    expect(await consume(db, "estimate")).toEqual({ remaining_today: DAILY_CAP - 2, remaining_month: MONTHLY_CAP - 2 });

    const rows = await db.query<{ kind: string; calls: number }>("select kind, calls from public.ai_usage order by kind");
    expect(rows.rows).toEqual([{ kind: "estimate", calls: 1 }, { kind: "label", calls: 1 }]);
  });

  it("refuses a call past the daily cap and does not charge for the refusal", async () => {
    const db = await database();
    await seed(db, userOne, today(), "label", DAILY_CAP);
    await authenticate(db, userOne);

    await expect(consume(db, "estimate")).rejects.toThrow(/Daily AI limit reached/i);

    await db.exec("reset role");
    const used = await db.query<{ total: number }>(`select coalesce(sum(calls), 0)::int as total from public.ai_usage where user_id = '${userOne}'`);
    expect(used.rows[0]).toEqual({ total: DAILY_CAP });
  });

  it("refuses a call past the monthly cap even when today is quiet", async () => {
    const db = await database();
    const monthStart = `${today().slice(0, 7)}-01`;
    await seed(db, userOne, monthStart, "label", MONTHLY_CAP);
    await authenticate(db, userOne);

    await expect(consume(db, "label")).rejects.toThrow(/Monthly AI limit reached/i);
  });

  it("returns the limit failure as a PostgREST 429 rather than an opaque server error", async () => {
    const db = await database();
    await seed(db, userOne, today(), "label", DAILY_CAP);
    await authenticate(db, userOne);

    await expect(consume(db, "label")).rejects.toMatchObject({ code: "PT429" });
  });

  it("counts an earlier day toward the month but not toward today", async () => {
    const db = await database();
    const earlier = `${today().slice(0, 7)}-01`;
    await seed(db, userOne, earlier, "label", 30);
    await authenticate(db, userOne);

    expect(await consume(db, "label")).toEqual({ remaining_today: DAILY_CAP - 1, remaining_month: MONTHLY_CAP - 31 });
  });

  it("keeps one user's allowance independent of another's", async () => {
    const db = await database();
    await seed(db, userTwo, today(), "label", DAILY_CAP);
    await authenticate(db, userOne);

    expect(await consume(db, "label")).toMatchObject({ remaining_today: DAILY_CAP - 1 });
  });

  it("rejects an unknown capture kind before charging anything", async () => {
    const db = await database();
    await authenticate(db, userOne);

    await expect(db.query("select * from public.consume_ai_credit('freeform')")).rejects.toThrow(/Unknown capture kind/i);

    await db.exec("reset role");
    const rows = await db.query("select * from public.ai_usage");
    expect(rows.rows).toEqual([]);
  });

  it("requires an authenticated caller", async () => {
    const db = await database();
    await db.exec("reset role; set role authenticated; set \"request.jwt.claim.sub\" = '';");

    await expect(consume(db, "label")).rejects.toThrow(/Authentication required/i);
  });
});

describe("ai_usage row-level authorization", () => {
  it("shows a signed-in user only their own usage", async () => {
    const db = await database();
    await seed(db, userOne, today(), "label", 3);
    await seed(db, userTwo, today(), "label", 7);
    await authenticate(db, userOne);

    const rows = await db.query<{ user_id: string; calls: number }>("select user_id, calls from public.ai_usage");
    expect(rows.rows).toEqual([{ user_id: userOne, calls: 3 }]);
  });

  it("denies anon any access and blocks direct writes by a signed-in user", async () => {
    const db = await database();
    await db.exec("reset role; set role anon");
    await expect(db.query("select * from public.ai_usage")).rejects.toThrow(/permission denied/i);

    await authenticate(db, userOne);
    await expect(db.exec(`insert into public.ai_usage (user_id, day, kind, calls) values ('${userOne}', current_date, 'label', 0)`)).rejects.toThrow(/permission denied/i);
    await expect(db.exec("update public.ai_usage set calls = 0")).rejects.toThrow(/permission denied/i);
    await expect(db.exec("delete from public.ai_usage")).rejects.toThrow(/permission denied/i);
  });

  it("applies as a non-superuser migration administrator", async () => {
    // Hosted Supabase runs migrations as a CREATEROLE administrator, not a superuser, and
    // owns the auth schema itself. Two earlier migrations exist because the daybook one
    // passed here as postgres and failed there; this asserts ai_usage does not repeat it.
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
    await db.exec(daybookMigration);
    await db.exec(callerIdMigration);
    await db.exec(conflictCodeMigration);
    await db.exec(aiUsageMigration);

    // The writer role must have no standing access to the auth schema, so a grant on it
    // being silently ineffective on hosted Supabase cannot break the RPC.
    await db.exec("reset role");
    await db.exec("revoke all on schema auth from aifoodpal_ai_usage_writer");
    await db.exec(`insert into auth.users (id) values ('${userOne}');`);
    const reach = await db.query<{ auth_usage: boolean }>("select has_schema_privilege('aifoodpal_ai_usage_writer', 'auth', 'USAGE') as auth_usage");
    expect(reach.rows).toEqual([{ auth_usage: false }]);

    await authenticate(db, userOne);
    expect(await consume(db, "label")).toMatchObject({ remaining_today: DAILY_CAP - 1 });
  });

  it("owns the RPC with a non-bypassing role that cannot reach another user's rows", async () => {
    const db = await database();
    await seed(db, userTwo, today(), "label", 5);
    const owner = await db.query<{ rolname: string; rolbypassrls: boolean }>(`
      select role.rolname, role.rolbypassrls
      from pg_proc procedure
      join pg_roles role on role.oid = procedure.proowner
      where procedure.proname = 'consume_ai_credit'
    `);
    expect(owner.rows).toEqual([{ rolname: "aifoodpal_ai_usage_writer", rolbypassrls: false }]);

    await db.exec(`reset role; set role aifoodpal_ai_usage_writer; set "request.jwt.claim.sub" = '${userOne}';`);
    const crossUser = await db.query(`update public.ai_usage set calls = 0 where user_id = '${userTwo}' returning user_id`);
    expect(crossUser.rows).toEqual([]);
  });
});

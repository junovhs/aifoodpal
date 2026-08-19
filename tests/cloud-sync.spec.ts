import type { AuthChangeEvent, SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { CloudStateRepository, createSupabaseDaybookCloud, type DaybookCloud, type SyncStatus } from "../src/cloud-sync";
import { createState, type AppState } from "../src/model";
import { migrateState, type StateRepository } from "../src/storage";
import type { DaybookRow, Json } from "../src/supabase-database";

class MemoryRepository implements StateRepository {
  constructor(private state: AppState) {}
  load(): AppState { return migrateState(structuredClone(this.state)); }
  save(state: AppState): void { this.state = migrateState(structuredClone(state)); }
}

class MemoryStore {
  values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

class FakeServer {
  online = true;
  rows = new Map<string, DaybookRow>();

  read(userId: string): DaybookRow | null {
    if (!this.online) throw Object.assign(new Error("offline"), { code: "NETWORK" });
    return structuredClone(this.rows.get(userId) ?? null);
  }

  save(userId: string, expectedRevision: number, state: AppState): DaybookRow {
    if (!this.online) throw Object.assign(new Error("offline"), { code: "NETWORK" });
    const current = this.rows.get(userId);
    if ((!current && expectedRevision !== 0) || (current && current.revision !== expectedRevision)) {
      throw Object.assign(new Error("revision conflict"), { code: "PT409" });
    }
    const now = "2026-08-19T00:00:00Z";
    const row: DaybookRow = { user_id: userId, state: structuredClone(state) as unknown as Json, revision: (current?.revision ?? 0) + 1, created_at: current?.created_at ?? now, updated_at: now };
    this.rows.set(userId, row);
    return structuredClone(row);
  }
}

class FakeCloud implements DaybookCloud {
  private listener?: (event: AuthChangeEvent, session: { user: { id: string } } | null) => void;
  constructor(private readonly server: FakeServer, private userId: string | null) {}
  async getSession() { return this.userId ? { user: { id: this.userId } } : null; }
  onAuthStateChange(listener: (event: AuthChangeEvent, session: { user: { id: string } } | null) => void): void { this.listener = listener; }
  async readDaybook(): Promise<DaybookRow | null> { return this.server.read(this.userId!); }
  async saveDaybook(expectedRevision: number, state: AppState): Promise<DaybookRow> { return this.server.save(this.userId!, expectedRevision, state); }
  emit(event: AuthChangeEvent, userId: string | null): void {
    this.userId = userId;
    this.listener?.(event, userId ? { user: { id: userId } } : null);
  }
}

const connect = (repository: CloudStateRepository) => {
  const states: AppState[] = [];
  const statuses: SyncStatus[] = [];
  repository.connect((state) => states.push(state), (status) => statuses.push(status));
  return { states, statuses };
};

const waitForPhase = async (repository: CloudStateRepository, phase: SyncStatus["phase"]): Promise<SyncStatus> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = repository.getStatus();
    if (status.phase === phase) return status;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${phase}; current phase is ${repository.getStatus().phase}`);
};

describe("Supabase daybook adapter", () => {
  it("calls rpc with the Supabase client as its receiver", async () => {
    const state = createState("2026-08-19");
    const row: DaybookRow = {
      user_id: "user-1",
      state: state as unknown as Json,
      revision: 3,
      created_at: "2026-08-19T00:00:00Z",
      updated_at: "2026-08-19T00:00:00Z",
    };
    const client = {
      marker: "bound",
      rpc(this: { marker: string }, name: string, args: unknown) {
        expect(this.marker).toBe("bound");
        expect(name).toBe("save_daybook");
        expect(args).toMatchObject({ expected_revision: 2 });
        return Promise.resolve({ data: row, error: null });
      },
    } as unknown as SupabaseClient;

    await expect(createSupabaseDaybookCloud(client).saveDaybook(2, state)).resolves.toEqual(row);
  });
});

describe("CloudStateRepository", () => {
  it("migrates once, loads on another device, advances revisions, and rejects stale writers", async () => {
    const server = new FakeServer();
    const local = createState("2026-08-18");
    local.profile.onboardingComplete = true;
    local.profile.manualDailyGuide = 1800;
    const first = new CloudStateRepository(new FakeCloud(server, "user-1"), new MemoryRepository(local), new MemoryStore(), new EventTarget());
    connect(first);
    expect((await waitForPhase(first, "migration")).revision).toBe(0);
    await first.confirmMigration();
    expect((await waitForPhase(first, "synced")).revision).toBe(1);
    expect(first.load().profile.manualDailyGuide).toBe(1800);

    const second = new CloudStateRepository(new FakeCloud(server, "user-1"), new MemoryRepository(createState("2026-08-18")), new MemoryStore(), new EventTarget());
    connect(second);
    expect((await waitForPhase(second, "synced")).revision).toBe(1);
    expect(second.load().profile.manualDailyGuide).toBe(1800);

    const newer = first.load();
    newer.profile.manualDailyGuide = 2000;
    first.save(newer);
    expect((await waitForPhase(first, "synced")).revision).toBe(2);

    const stale = second.load();
    stale.profile.manualDailyGuide = 1500;
    second.save(stale);
    await waitForPhase(second, "conflict");
    expect(server.rows.get("user-1")?.state).toMatchObject({ profile: { manualDailyGuide: 2000 } });
    await second.resolveConflict("cloud");
    expect(second.load().profile.manualDailyGuide).toBe(2000);
    expect((await waitForPhase(second, "synced")).revision).toBe(2);
  });

  it("still offers migration to the device holding data after an empty device claimed the account", async () => {
    const server = new FakeServer();
    const phone = new CloudStateRepository(new FakeCloud(server, "user-1"), new MemoryRepository(createState("2026-08-18")), new MemoryStore(), new EventTarget());
    connect(phone);
    expect((await waitForPhase(phone, "synced")).revision).toBe(1);
    expect(server.rows.get("user-1")?.state).toMatchObject({ profile: { onboardingComplete: false } });

    const local = createState("2026-08-18");
    local.profile.onboardingComplete = true;
    local.profile.manualDailyGuide = 1800;
    const desktop = new CloudStateRepository(new FakeCloud(server, "user-1"), new MemoryRepository(local), new MemoryStore(), new EventTarget());
    connect(desktop);

    const offered = await waitForPhase(desktop, "migration");
    expect(offered.revision).toBe(1);
    expect(desktop.load().profile.manualDailyGuide).toBe(1800);

    await desktop.confirmMigration();
    expect((await waitForPhase(desktop, "synced")).revision).toBe(2);
    expect(server.rows.get("user-1")?.state).toMatchObject({ profile: { manualDailyGuide: 1800 } });
  });

  it("clears the signed-out browser copy only after a confirmed migration succeeds", async () => {
    const server = new FakeServer();
    const local = createState("2026-08-18");
    local.profile.onboardingComplete = true;
    local.profile.manualDailyGuide = 1800;
    const anonymous = new MemoryRepository(local);
    const cloud = new FakeCloud(server, "user-1");
    const repository = new CloudStateRepository(cloud, anonymous, new MemoryStore(), new EventTarget());
    connect(repository);

    await waitForPhase(repository, "migration");
    expect(anonymous.load().profile.manualDailyGuide).toBe(1800);
    await repository.confirmMigration();
    await waitForPhase(repository, "synced");

    cloud.emit("SIGNED_OUT", null);
    await waitForPhase(repository, "local");
    expect(repository.load().profile.manualDailyGuide).toBeNull();
    expect(server.rows.get("user-1")?.state).toMatchObject({ profile: { manualDailyGuide: 1800 } });
  });

  it("does not upload after the user declines first-device migration", async () => {
    const server = new FakeServer();
    const local = createState("2026-08-18");
    local.profile.onboardingComplete = true;
    const repository = new CloudStateRepository(new FakeCloud(server, "user-1"), new MemoryRepository(local), new MemoryStore(), new EventTarget());
    connect(repository);

    await waitForPhase(repository, "migration");
    repository.declineMigration();
    const edited = repository.load();
    edited.profile.manualDailyGuide = 2200;
    repository.save(edited);
    await repository.retry();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(repository.getStatus().phase).toBe("local");
    expect(server.rows.has("user-1")).toBe(false);
    expect(repository.load().profile.manualDailyGuide).toBe(2200);
  });

  it("preserves edits made while the initial cloud read is offline and asks before first upload", async () => {
    const server = new FakeServer();
    server.online = false;
    const repository = new CloudStateRepository(
      new FakeCloud(server, "user-1"),
      new MemoryRepository(createState("2026-08-18")),
      new MemoryStore(),
      new EventTarget(),
    );
    connect(repository);
    await waitForPhase(repository, "offline");

    const edited = repository.load();
    edited.profile.onboardingComplete = true;
    edited.profile.manualDailyGuide = 2050;
    repository.save(edited);
    expect(repository.getStatus().phase).toBe("offline");

    server.online = true;
    await repository.retry();
    expect((await waitForPhase(repository, "migration")).revision).toBe(0);
    expect(repository.load().profile.manualDailyGuide).toBe(2050);
    expect(server.rows.has("user-1")).toBe(false);
  });

  it("keeps offline edits usable, retries safely, and restores anonymous data on sign-out", async () => {
    const server = new FakeServer();
    const anonymous = createState("2026-08-18");
    anonymous.profile.manualDailyGuide = 1700;
    const cloudState = createState("2026-08-18");
    cloudState.profile.onboardingComplete = true;
    cloudState.profile.manualDailyGuide = 1900;
    server.save("user-1", 0, cloudState);
    const cloud = new FakeCloud(server, "user-1");
    const repository = new CloudStateRepository(cloud, new MemoryRepository(anonymous), new MemoryStore(), new EventTarget());
    connect(repository);
    await waitForPhase(repository, "synced");

    server.online = false;
    const offline = repository.load();
    offline.profile.manualDailyGuide = 2100;
    repository.save(offline);
    await waitForPhase(repository, "offline");
    expect(repository.load().profile.manualDailyGuide).toBe(2100);

    server.online = true;
    await repository.retry();
    expect((await waitForPhase(repository, "synced")).revision).toBe(2);
    expect(server.rows.get("user-1")?.state).toMatchObject({ profile: { manualDailyGuide: 2100 } });

    cloud.emit("SIGNED_OUT", null);
    await waitForPhase(repository, "local");
    expect(repository.load().profile.manualDailyGuide).toBe(1700);
  });
});

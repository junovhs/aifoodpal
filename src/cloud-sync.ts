import type { AuthChangeEvent, SupabaseClient } from "@supabase/supabase-js";
import { createState, type AppState } from "./model";
import { migrateState, type StateRepository } from "./storage";
import type { Database, DaybookRow, Json } from "./supabase-database";

export type SyncPhase = "local" | "connecting" | "migration" | "synced" | "offline" | "conflict";
export interface SyncStatus {
  phase: SyncPhase;
  message: string;
  revision: number;
}

interface CloudSession { user: { id: string } }
export interface DaybookCloud {
  getSession(): Promise<CloudSession | null>;
  onAuthStateChange(listener: (event: AuthChangeEvent, session: CloudSession | null) => void): void;
  readDaybook(): Promise<DaybookRow | null>;
  saveDaybook(expectedRevision: number, state: AppState): Promise<DaybookRow>;
}

interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type StateListener = (state: AppState) => void;
type StatusListener = (status: SyncStatus) => void;

const cacheKey = (userId: string): string => `aifoodpal.cloud.${userId}.v1`;
const clone = (state: AppState): AppState => migrateState(JSON.parse(JSON.stringify(state)) as unknown);
const hasMeaningfulData = (state: AppState): boolean => state.profile.onboardingComplete || state.foods.length > 0 || state.entries.length > 0 || state.weights.length > 0;
const errorCode = (error: unknown): string => typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";

/** Adapts the configured Supabase client to the narrow daybook sync protocol. */
export const createSupabaseDaybookCloud = (client: SupabaseClient<Database>): DaybookCloud => ({
  async getSession() {
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    return data.session;
  },
  onAuthStateChange(listener) {
    client.auth.onAuthStateChange((event, session) => listener(event, session));
  },
  async readDaybook() {
    const { data, error } = await client.from("daybooks").select("*").maybeSingle();
    if (error) throw error;
    return data;
  },
  async saveDaybook(expectedRevision, state) {
    const rpc = client.rpc as unknown as (
      name: "save_daybook",
      args: { expected_revision: number; next_state: Json },
    ) => Promise<{ data: DaybookRow | null; error: { code?: string; message: string } | null }>;
    const { data, error } = await rpc("save_daybook", { expected_revision: expectedRevision, next_state: state as unknown as Json });
    if (error) throw error;
    if (!data) throw new Error("Supabase returned no saved daybook.");
    return data;
  },
});

/** Local-first repository that synchronizes one revisioned aggregate for the active auth user. */
export class CloudStateRepository implements StateRepository {
  private state: AppState;
  private status: SyncStatus = { phase: "local", message: "Saved on this device", revision: 0 };
  private session: CloudSession | null = null;
  private revision = 0;
  private generation = 0;
  private pending: AppState | null = null;
  private conflictState: AppState | null = null;
  private flushing = false;
  private syncEnabled = true;
  private localVersion = 0;
  private readyForWrites = false;
  private migrationInFlight = false;
  private onState: StateListener = () => undefined;
  private onStatus: StatusListener = () => undefined;

  constructor(
    private readonly cloud: DaybookCloud,
    private readonly anonymous: StateRepository,
    private readonly cache: KeyValueStore = localStorage,
    private readonly onlineTarget: Pick<Window, "addEventListener"> = window,
  ) {
    this.state = anonymous.load();
  }

  load(): AppState { return clone(this.state); }

  save(state: AppState): void {
    this.state = clone(state);
    this.localVersion += 1;
    if (!this.session) {
      this.anonymous.save(this.state);
      this.setStatus("local", "Saved on this device");
      return;
    }
    this.writeUserCache(this.state);
    if (!this.syncEnabled) return;
    if (this.status.phase === "migration" || this.status.phase === "conflict") {
      if (this.status.phase === "conflict") this.conflictState = clone(this.state);
      return;
    }
    this.pending = clone(this.state);
    if (!this.readyForWrites) return;
    this.setStatus("connecting", "Syncing changes…");
    void this.flush();
  }

  connect(onState: StateListener, onStatus: StatusListener): void {
    this.onState = onState;
    this.onStatus = onStatus;
    this.cloud.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") void this.activate(null);
      if ((event === "SIGNED_IN" || event === "INITIAL_SESSION") && session?.user.id !== this.session?.user.id) void this.activate(session);
    });
    this.onlineTarget.addEventListener("online", () => { void this.retry(); });
    void this.cloud.getSession().then((session) => this.activate(session)).catch(() => this.goOffline("Could not check cloud session"));
  }

  getStatus(): SyncStatus { return { ...this.status }; }

  async confirmMigration(): Promise<void> {
    if (!this.session || this.status.phase !== "migration") return;
    this.pending = clone(this.state);
    this.syncEnabled = true;
    this.readyForWrites = true;
    this.migrationInFlight = true;
    this.revision = 0;
    this.setStatus("connecting", "Uploading this device’s daybook…");
    await this.flush();
  }

  declineMigration(): void {
    if (this.status.phase !== "migration") return;
    this.syncEnabled = false;
    this.readyForWrites = false;
    this.setStatus("local", "Cloud sync not started");
  }

  async resolveConflict(choice: "cloud" | "local"): Promise<void> {
    if (!this.session || this.status.phase !== "conflict") return;
    const generation = this.generation;
    this.setStatus("connecting", choice === "cloud" ? "Loading the newer cloud copy…" : "Confirming this device’s copy…");
    try {
      const row = await this.cloud.readDaybook();
      if (generation !== this.generation) return;
      if (!row) throw new Error("The cloud daybook is missing.");
      if (choice === "cloud") {
        this.acceptCloud(row);
        return;
      }
      const local = clone(this.conflictState ?? this.state);
      const saved = await this.cloud.saveDaybook(row.revision, local);
      if (generation !== this.generation) return;
      this.revision = saved.revision;
      this.state = local;
      this.conflictState = null;
      this.writeUserCache(local);
      this.setStatus("synced", "This device’s copy is synced", saved.revision);
    } catch (error) {
      if (errorCode(error) === "PT409") this.enterConflict(this.conflictState ?? this.state);
      else this.goOffline("Conflict resolution is waiting for a connection");
    }
  }

  async retry(): Promise<void> {
    if (!this.session || !this.syncEnabled) return;
    if (this.status.phase === "conflict" || this.status.phase === "migration") return;
    if (this.revision === 0) {
      await this.activate(this.session, true);
      return;
    }
    if (!this.pending) this.pending = clone(this.state);
    await this.flush();
  }

  private async activate(session: CloudSession | null, force = false): Promise<void> {
    if (!force && session?.user.id === this.session?.user.id && session !== null) return;
    const generation = ++this.generation;
    this.session = session;
    this.syncEnabled = true;
    this.readyForWrites = false;
    this.migrationInFlight = false;
    this.revision = 0;
    const carriedPending = force ? this.pending : null;
    this.pending = carriedPending;
    this.conflictState = null;
    if (!session) {
      this.state = this.anonymous.load();
      this.emitState();
      this.setStatus("local", "Saved on this device", 0);
      return;
    }
    const cached = this.readUserCache(session.user.id);
    const versionAtRead = this.localVersion;
    if (cached) {
      this.state = cached;
      this.emitState();
    }
    this.setStatus("connecting", "Checking your cloud daybook…", 0);
    try {
      const row = await this.cloud.readDaybook();
      if (generation !== this.generation) return;
      if (row) {
        if (this.pending || this.localVersion !== versionAtRead) {
          this.revision = row.revision;
          this.enterConflict(this.pending ?? this.state);
          return;
        }
        this.acceptCloud(row);
        return;
      }
      const candidate = this.pending ?? (this.localVersion !== versionAtRead ? this.state : (cached ?? this.anonymous.load()));
      this.state = clone(candidate);
      this.writeUserCache(this.state);
      this.emitState();
      if (hasMeaningfulData(candidate)) {
        this.setStatus("migration", "Choose whether to sync this device’s existing daybook", 0);
      } else {
        this.readyForWrites = true;
        this.pending = clone(candidate);
        await this.flush();
      }
    } catch {
      if (generation === this.generation) this.goOffline(cached ? "Using the last cloud copy saved on this device" : "Cloud unavailable; changes stay on this device");
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing || !this.session || !this.pending) return;
    this.flushing = true;
    try {
      while (this.pending && this.session) {
        const generation = this.generation;
        const userId: string = this.session.user.id;
        const next = this.pending;
        this.pending = null;
        try {
          const saved = await this.cloud.saveDaybook(this.revision, next);
          if (generation !== this.generation || this.session?.user.id !== userId) return;
          this.revision = saved.revision;
          this.state = clone(next);
          this.writeUserCache(next);
          if (this.migrationInFlight) {
            this.anonymous.save(createState(next.prefs.date));
            this.migrationInFlight = false;
          }
          this.setStatus("synced", "All changes synced", saved.revision);
        } catch (error) {
          if (generation !== this.generation || this.session?.user.id !== userId) return;
          if (errorCode(error) === "PT409") this.enterConflict(next);
          else {
            this.pending = this.pending ?? next;
            this.goOffline("Offline changes are safe on this device");
          }
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private acceptCloud(row: DaybookRow): void {
    this.readyForWrites = true;
    this.revision = row.revision;
    this.state = migrateState(row.state);
    this.pending = null;
    this.conflictState = null;
    this.writeUserCache(this.state);
    this.emitState();
    this.setStatus("synced", "Cloud daybook is up to date", row.revision);
  }

  private enterConflict(state: AppState): void {
    this.readyForWrites = true;
    this.conflictState = clone(state);
    this.pending = null;
    this.setStatus("conflict", "Another device saved newer changes", this.revision);
  }

  private goOffline(message: string): void { this.setStatus("offline", message, this.revision); }
  private emitState(): void { this.onState(clone(this.state)); }
  private setStatus(phase: SyncPhase, message: string, revision = this.revision): void {
    this.status = { phase, message, revision };
    this.onStatus(this.getStatus());
  }
  private writeUserCache(state: AppState): void {
    if (this.session) this.cache.setItem(cacheKey(this.session.user.id), JSON.stringify(state));
  }
  private readUserCache(userId: string): AppState | null {
    try {
      const value = this.cache.getItem(cacheKey(userId));
      return value ? migrateState(JSON.parse(value) as unknown) : null;
    } catch { return null; }
  }
}

/**
 * src/state.ts — persistent state for the @superinstance/quilt-core daemon.
 *
 * Backed by SQLite (via the built-in `node:sqlite` module on Node
 * 22+; older Node uses the `better-sqlite3` shim, but we ship with
 * Node 22 in core24 so the built-in is available). The DB lives at
 * $QUILT_STATE, which is on a persistent A/B partition and
 * survives snap refreshes.
 *
 * Schema is intentionally minimal. We do not use an ORM; the
 * queries are short, audited by hand, and parameterised.
 *
 * Tables:
 *   - meta             key/value (node-id, schema version, etc.)
 *   - cells            active and historical Quilt cells
 *   - telemetry        periodic CPU/mem/uptime samples
 *   - ota_history      past OTA refresh attempts
 *   - schema_migrations  which migrations have been applied
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------
export interface CellRecord {
  id:         string;
  command:    string;
  args:       string[];
  env:        Record<string, string>;
  pid:        number;
  status:     'starting' | 'running' | 'stopped' | 'failed';
  startedAt:  string;
  stoppedAt?: string;
  exitCode?:  number;
}

export interface TelemetryRecord {
  ts:         string;
  cpuPercent: number;
  memUsedMB:  number;
  memTotalMB: number;
  uptimeSec:  number;
  cellsLive:  number;
}

export interface OtaRecord {
  ts:           string;
  fromRevision: string;
  toRevision:   string;
  channel:      string;
  outcome:      'success' | 'failure' | 'skipped';
  detail?:      string;
}

// ---------------------------------------------------------------------------
// State.
//
// We open the DB lazily so that `init` (which creates the schema
// and seeds the node-id) does not race with `start` (which opens
// the DB for normal traffic).
// ---------------------------------------------------------------------------
type DatabaseHandle = any; // node:sqlite's DatabaseSync or better-sqlite3's Database

export class State {
  private readonly dbPath: string;
  private db: DatabaseHandle | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  // -------------------------------------------------------------------------
  // Lifecycle.
  // -------------------------------------------------------------------------
  init(): void {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true, mode: 0o750 });
    const db = this.open();
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous  = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cells (
        id         TEXT PRIMARY KEY,
        command    TEXT NOT NULL,
        args_json  TEXT NOT NULL,
        env_json   TEXT NOT NULL,
        pid        INTEGER NOT NULL,
        status     TEXT NOT NULL,
        started_at TEXT NOT NULL,
        stopped_at TEXT,
        exit_code  INTEGER
      );

      CREATE TABLE IF NOT EXISTS telemetry (
        ts         TEXT PRIMARY KEY,
        cpu_pct    REAL NOT NULL,
        mem_used   INTEGER NOT NULL,
        mem_total  INTEGER NOT NULL,
        uptime_sec INTEGER NOT NULL,
        cells_live INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS telemetry_ts ON telemetry(ts);

      CREATE TABLE IF NOT EXISTS ota_history (
        ts            TEXT PRIMARY KEY,
        from_rev      TEXT NOT NULL,
        to_rev        TEXT NOT NULL,
        channel       TEXT NOT NULL,
        outcome       TEXT NOT NULL,
        detail        TEXT
      );

      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    this.ensureNodeId();
  }

  healthy(): boolean {
    try {
      const db = this.open();
      const row = db.prepare('SELECT 1 AS ok').get() as { ok: number };
      return row.ok === 1;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Node identity.
  // -------------------------------------------------------------------------
  nodeId(): string {
    const db = this.open();
    const row = db.prepare("SELECT value FROM meta WHERE key = 'node-id'").get() as { value: string } | undefined;
    if (row) return row.value;
    return this.ensureNodeId();
  }

  private ensureNodeId(): string {
    const db = this.open();
    const existing = db.prepare("SELECT value FROM meta WHERE key = 'node-id'").get() as { value: string } | undefined;
    if (existing) return existing.value;
    const id = randomUUID().toLowerCase();
    db.prepare("INSERT INTO meta (key, value) VALUES ('node-id', ?)").run(id);
    return id;
  }

  // -------------------------------------------------------------------------
  // Cells.
  // -------------------------------------------------------------------------
  listCells(): CellRecord[] {
    const db = this.open();
    const rows = db.prepare("SELECT * FROM cells ORDER BY started_at DESC").all() as Array<{
      id: string; command: string; args_json: string; env_json: string;
      pid: number; status: string; started_at: string; stopped_at: string | null; exit_code: number | null;
    }>;
    return rows.map((r) => ({
      id:        r.id,
      command:   r.command,
      args:      JSON.parse(r.args_json) as string[],
      env:       JSON.parse(r.env_json)  as Record<string, string>,
      pid:       r.pid,
      status:    r.status as CellRecord['status'],
      startedAt: r.started_at,
      stoppedAt: r.stopped_at ?? undefined,
      exitCode:  r.exit_code ?? undefined,
    }));
  }

  getCell(id: string): CellRecord | null {
    const db = this.open();
    const r = db.prepare("SELECT * FROM cells WHERE id = ?").get(id) as {
      id: string; command: string; args_json: string; env_json: string;
      pid: number; status: string; started_at: string; stopped_at: string | null; exit_code: number | null;
    } | undefined;
    if (!r) return null;
    return {
      id:        r.id,
      command:   r.command,
      args:      JSON.parse(r.args_json) as string[],
      env:       JSON.parse(r.env_json)  as Record<string, string>,
      pid:       r.pid,
      status:    r.status as CellRecord['status'],
      startedAt: r.started_at,
      stoppedAt: r.stopped_at ?? undefined,
      exitCode:  r.exit_code ?? undefined,
    };
  }

  upsertCell(rec: CellRecord): void {
    const db = this.open();
    db.prepare(`
      INSERT INTO cells (id, command, args_json, env_json, pid, status, started_at)
      VALUES (@id, @command, @args_json, @env_json, @pid, @status, @started_at)
      ON CONFLICT(id) DO UPDATE SET
        command    = excluded.command,
        args_json  = excluded.args_json,
        env_json   = excluded.env_json,
        pid        = excluded.pid,
        status     = excluded.status,
        started_at = excluded.started_at
    `).run({
      id:         rec.id,
      command:    rec.command,
      args_json:  JSON.stringify(rec.args),
      env_json:   JSON.stringify(rec.env),
      pid:        rec.pid,
      status:     rec.status,
      started_at: rec.startedAt,
    });
  }

  updateCell(id: string, patch: Partial<Pick<CellRecord, 'status' | 'pid' | 'stoppedAt' | 'exitCode'>>): void {
    const db = this.open();
    const cur = this.getCell(id);
    if (!cur) return;
    const next: CellRecord = { ...cur, ...patch };
    db.prepare(`
      UPDATE cells SET
        status     = @status,
        pid        = @pid,
        stopped_at = @stopped_at,
        exit_code  = @exit_code
      WHERE id = @id
    `).run({
      id:         next.id,
      status:     next.status,
      pid:        next.pid,
      stopped_at: next.stoppedAt ?? null,
      exit_code:  next.exitCode ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // Telemetry.
  // -------------------------------------------------------------------------
  insertTelemetry(rec: TelemetryRecord): void {
    const db = this.open();
    db.prepare(`
      INSERT OR REPLACE INTO telemetry (ts, cpu_pct, mem_used, mem_total, uptime_sec, cells_live)
      VALUES (@ts, @cpu_pct, @mem_used, @mem_total, @uptime_sec, @cells_live)
    `).run({
      ts:         rec.ts,
      cpu_pct:    rec.cpuPercent,
      mem_used:   rec.memUsedMB,
      mem_total:  rec.memTotalMB,
      uptime_sec: rec.uptimeSec,
      cells_live: rec.cellsLive,
    });
    // Prune to the last 7 days.
    db.prepare("DELETE FROM telemetry WHERE ts < datetime('now', '-7 days')").run();
  }

  recentTelemetry(limit: number): TelemetryRecord[] {
    const db = this.open();
    const rows = db.prepare("SELECT * FROM telemetry ORDER BY ts DESC LIMIT ?").all(limit) as Array<{
      ts: string; cpu_pct: number; mem_used: number; mem_total: number; uptime_sec: number; cells_live: number;
    }>;
    return rows.map((r) => ({
      ts:         r.ts,
      cpuPercent: r.cpu_pct,
      memUsedMB:  r.mem_used,
      memTotalMB: r.mem_total,
      uptimeSec:  r.uptime_sec,
      cellsLive:  r.cells_live,
    }));
  }

  // -------------------------------------------------------------------------
  // OTA history.
  // -------------------------------------------------------------------------
  appendOta(rec: OtaRecord): void {
    const db = this.open();
    db.prepare(`
      INSERT INTO ota_history (ts, from_rev, to_rev, channel, outcome, detail)
      VALUES (@ts, @from_rev, @to_rev, @channel, @outcome, @detail)
    `).run({
      ts:       rec.ts,
      from_rev: rec.fromRevision,
      to_rev:   rec.toRevision,
      channel:  rec.channel,
      outcome:  rec.outcome,
      detail:   rec.detail ?? null,
    });
    // Keep the last 200 entries.
    db.prepare(`
      DELETE FROM ota_history
      WHERE ts NOT IN (SELECT ts FROM ota_history ORDER BY ts DESC LIMIT 200)
    `).run();
  }

  otaHistory(limit: number): OtaRecord[] {
    const db = this.open();
    const rows = db.prepare("SELECT * FROM ota_history ORDER BY ts DESC LIMIT ?").all(limit) as Array<{
      ts: string; from_rev: string; to_rev: string; channel: string; outcome: string; detail: string | null;
    }>;
    return rows.map((r) => ({
      ts:           r.ts,
      fromRevision: r.from_rev,
      toRevision:   r.to_rev,
      channel:      r.channel,
      outcome:      r.outcome as OtaRecord['outcome'],
      detail:       r.detail ?? undefined,
    }));
  }

  // -------------------------------------------------------------------------
  // Internal: open the DB.
  //
  // We support two backends:
  //   1. node:sqlite (Node ≥ 22.5) — preferred, no native build.
  //   2. better-sqlite3            — fallback for older Node.
  //
  // The interface we use (prepare / exec / run / get / all) is the
  // same in both. We import dynamically so the absence of one does
  // not crash the daemon.
  // -------------------------------------------------------------------------
  private open(): DatabaseHandle {
    if (this.db) return this.db;
    // Try node:sqlite first.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('node:sqlite') as { DatabaseSync: new (p: string) => DatabaseHandle };
      this.db = new mod.DatabaseSync(this.dbPath);
      return this.db;
    } catch {
      // fall through
    }
    // Fall back to better-sqlite3.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('better-sqlite3') as new (p: string) => DatabaseHandle;
      this.db = mod(this.dbPath);
      return this.db;
    } catch (e) {
      throw new Error(
        'no SQLite backend available; install better-sqlite3 ' +
        'or run on Node ≥ 22.5 which has node:sqlite built in'
      );
    }
  }
}

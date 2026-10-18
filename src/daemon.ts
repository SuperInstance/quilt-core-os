/**
 * src/daemon.ts — the long-running @superinstance/quilt-core service.
 *
 * This module is the heart of the snap. It is a single TypeScript
 * entry point that is invoked three different ways:
 *
 *   1. `node daemon.js daemon`     — the long-running service.
 *   2. `node daemon.js init`       — first-time DB seed (from snap install hook).
 *   3. `node daemon.js configcheck`— one-shot health probe (from a snapd timer).
 *
 * The daemon exposes a single unix-domain socket (QUILT_SOCK) on
 * which it accepts line-delimited JSON RPCs from:
 *   - the `@superinstance/quilt-core` CLI shim (snap/local-bin/@superinstance/quilt-core)
 *   - the quilt-fleet controller (over a separate fleet-side
 *     socket; not this one).
 *   - other local cells via the cell-ipc port.
 *
 * On Ubuntu Core, the daemon runs as a `simple` snapd service
 * (restart=on-failure, stop-timeout=30s). If the daemon dies, snapd
 * restarts it; if it keeps dying, snapd reverts the snap to the
 * previous revision. **This is the un-brickable property.**
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';

import { State, CellRecord, TelemetryRecord } from './state';
import { OtaChecker } from './ota-checker';

// ---------------------------------------------------------------------------
// Environment.
//
// snapd exports SNAP, SNAP_NAME, SNAP_DATA, SNAP_COMMON, SNAP_REVISION
// SNAP_VERSION. The qilt-core bash shim also re-exports QUILT_SOCK
// and friends for the rare case the daemon is run outside a snap.
// ---------------------------------------------------------------------------
const SNAP          = process.env.SNAP          ?? path.resolve(__dirname, '..');
const SNAP_NAME     = process.env.SNAP_NAME     ?? '@superinstance/quilt-core';
const SNAP_DATA     = process.env.SNAP_DATA     ?? path.join(os.homedir(), '.quilt');
const SNAP_COMMON   = process.env.SNAP_COMMON   ?? path.join(os.homedir(), '.quilt-common');
const QUILT_SOCK    = process.env.QUILT_SOCK    ?? path.join(SNAP_COMMON, 'run', 'quilt-core.sock');
const QUILT_STATE   = process.env.QUILT_STATE   ?? path.join(SNAP_COMMON, 'state', 'state.db');
const QUILT_LOG     = process.env.QUILT_LOG     ?? path.join(SNAP_COMMON, 'log',   'quilt-core.log');
const QUILT_VERSION = process.env.QUILT_VERSION ?? process.env.SNAP_VERSION ?? 'dev';
const QUILT_REV     = process.env.QUILT_REVISION ?? process.env.SNAP_REVISION ?? '0';

const PIDFILE = path.join(SNAP_COMMON, 'run', 'quilt-core.pid');

// ---------------------------------------------------------------------------
// Logging.
//
// We do not use any third-party logger; printf to stdout/stderr is
// snapd-journal-friendly, and snapd adds the snap name as a tag.
// ---------------------------------------------------------------------------
function ts(): string { return new Date().toISOString(); }
function log(level: 'debug'|'info'|'warn'|'error', msg: string, extra?: unknown): void {
  if (extra !== undefined) {
    process.stderr.write(`[${ts()}] [${level}] ${msg} ${JSON.stringify(extra)}\n`);
  } else {
    process.stderr.write(`[${ts()}] [${level}] ${msg}\n`);
  }
}
const info  = (m: string, e?: unknown) => log('info',  m, e);
const warn  = (m: string, e?: unknown) => log('warn',  m, e);
const error = (m: string, e?: unknown) => log('error', m, e);
const debug = (m: string, e?: unknown) => {
  if (process.env.QUILT_DEBUG === '1') log('debug', m, e);
};

// ---------------------------------------------------------------------------
// RPC protocol.
//
// Each request is a single JSON object on a single line. The response
// is a single JSON object on a single line. Errors are signalled by
// the `error` field being a non-null object.
//
// Request:
//   { "id": "<client-uuid>", "method": "...", "params": { ... } }
//
// Response (success):
//   { "id": "<client-uuid>", "ok": true, "result": ... }
//
// Response (error):
//   { "id": "<client-uuid>", "ok": false, "error": { "code": ..., "message": ... } }
// ---------------------------------------------------------------------------
interface RpcRequest {
  id:      string;
  method:  string;
  params?: Record<string, unknown>;
}
interface RpcResponseOk  { id: string; ok: true;  result: unknown }
interface RpcResponseErr { id: string; ok: false; error: { code: number; message: string; details?: unknown } }
type RpcResponse = RpcResponseOk | RpcResponseErr;

const ERR_INTERNAL     = -1;
const ERR_BAD_REQUEST  = -2;
const ERR_NOT_FOUND    = -3;
const ERR_UNAUTHORIZED = -4;
const ERR_CONFLICT     = -5;

function errResponse(id: string, code: number, message: string, details?: unknown): RpcResponseErr {
  return { id, ok: false, error: { code, message, details } };
}
function okResponse(id: string, result: unknown): RpcResponseOk {
  return { id, ok: true, result };
}

// ---------------------------------------------------------------------------
// The Daemon.
//
// The Daemon owns:
//   - the unix socket
//   - the State (SQLite)
//   - the OtaChecker
//   - a process registry (cells)
//
// It is the only object that mutates persistent state.
// ---------------------------------------------------------------------------
export class Daemon extends EventEmitter {
  private readonly state:    State;
  private readonly ota:      OtaChecker;
  private readonly server:   net.Server;
  private readonly cells:    Map<string, CellProcess> = new Map();
  private          running   = false;
  private          startedAt = 0;
  private          reqSeq    = 0;
  // Configurable knobs. These are read at boot from the file written
  // by snap/hooks/configure, and reloaded on each configure hook.
  private config: DaemonConfig = {
    cellPort:      9090,
    telemetryPort: 9100,
    otaChannel:    'edge',
    otaIntervalMs: 60 * 60 * 1000,   // 1h
    logLevel:      'info',
    fleetUrl:      '',
  };

  constructor() {
    super();
    this.state = new State(QUILT_STATE);
    this.ota   = new OtaChecker(this.state, this.config);
    this.server = net.createServer((sock) => this.onConnection(sock));
  }

  // -------------------------------------------------------------------------
  // Boot.
  // -------------------------------------------------------------------------
  async start(): Promise<void> {
    if (this.running) return;
    this.running   = true;
    this.startedAt = Date.now();

    // Make sure the parent directory for the socket exists.
    fs.mkdirSync(path.dirname(QUILT_SOCK), { recursive: true, mode: 0o750 });
    // Remove any stale socket from a previous, crashed instance.
    try { fs.unlinkSync(QUILT_SOCK); } catch { /* ignore */ }

    // Write our pidfile so the upgrade hook can find us.
    fs.writeFileSync(PIDFILE, String(process.pid), { mode: 0o640 });
    process.on('exit', () => {
      try { fs.unlinkSync(QUILT_SOCK); } catch { /* ignore */ }
      try { fs.unlinkSync(PIDFILE);     } catch { /* ignore */ }
    });

    // Load config from the persisted JSON file, if any.
    this.reloadConfig();

    // Open the socket.
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(QUILT_SOCK, () => {
        // snapd-managed daemon runs as root; the socket needs to be
        // accessible to the _daemon group. We chmod 0660 to match.
        try { fs.chmodSync(QUILT_SOCK, 0o660); } catch { /* ignore */ }
        resolve();
      });
    });
    info(`@superinstance/quilt-core daemon listening on ${QUILT_SOCK}`);
    info(`  version: ${QUILT_VERSION} (rev ${QUILT_REV})`);
    info(`  pid:     ${process.pid}`);
    info(`  state:   ${QUILT_STATE}`);

    // Tell snapd the daemon is ready. This affects the snapd
    // readiness probe (which is part of the health-check protocol
    // for auto-rollback).
    if (typeof (process as any).snapdReady === 'function') {
      try { (process as any).snapdReady(); } catch { /* not running under snapd */ }
    }

    // Start the OTA checker.
    this.ota.start();

    // Periodic telemetry flush.
    setInterval(() => this.recordTelemetry().catch((e) => warn('telemetry failed', e)), 30_000).unref();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    info('daemon stopping');
    this.ota.stop();
    for (const cell of this.cells.values()) {
      try { cell.kill('SIGTERM'); } catch { /* ignore */ }
    }
    for (const cell of this.cells.values()) {
      try { await cell.wait(5_000); } catch { /* ignore */ }
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    try { fs.unlinkSync(QUILT_SOCK); } catch { /* ignore */ }
    try { fs.unlinkSync(PIDFILE); } catch { /* ignore */ }
  }

  // -------------------------------------------------------------------------
  // Config.
  // -------------------------------------------------------------------------
  private reloadConfig(): void {
    const f = path.join(SNAP_COMMON, 'state', 'config.json');
    if (!fs.existsSync(f)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      // snapctl's -d format wraps keys; flatten one level.
      const flat: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          for (const [k2, v2] of Object.entries(v as object)) flat[k2] = v2;
        } else {
          flat[k] = v;
        }
      }
      if (typeof flat['cell-port']      === 'number') this.config.cellPort      = flat['cell-port'];
      if (typeof flat['telemetry-port'] === 'number') this.config.telemetryPort = flat['telemetry-port'];
      if (typeof flat['ota-channel']    === 'string') this.config.otaChannel    = flat['ota-channel'] as string;
      if (typeof flat['ota-interval']   === 'string') {
        const m = /^(\d+)([mh])$/.exec(flat['ota-interval'] as string);
        if (m) {
          const n = parseInt(m[1]!, 10);
          this.config.otaIntervalMs = (m[2] === 'h' ? n * 60 : n) * 60_000;
        }
      }
      if (typeof flat['log-level'] === 'string') this.config.logLevel = flat['log-level'] as string;
      if (typeof flat['fleet-url'] === 'string') this.config.fleetUrl  = flat['fleet-url'] as string;
      info('config reloaded', this.config);
    } catch (e) {
      warn('failed to parse config.json; using defaults', e);
    }
  }

  // -------------------------------------------------------------------------
  // Connection handler.
  // -------------------------------------------------------------------------
  private onConnection(sock: net.Socket): void {
    sock.setNoDelay(true);
    const peer = `${sock.remoteAddress}:${sock.remotePort}`;
    debug(`connection from ${peer}`);

    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.length === 0) continue;
        this.handleLine(sock, line).catch((e) => error('handleLine threw', e));
      }
    };
    sock.on('data', onData);
    sock.on('error', (e) => debug(`socket error from ${peer}: ${e.message}`));
    sock.on('close', () => debug(`socket closed: ${peer}`));
  }

  private async handleLine(sock: net.Socket, line: string): Promise<void> {
    let req: RpcRequest;
    try {
      req = JSON.parse(line);
    } catch (e) {
      sock.write(JSON.stringify(errResponse('?', ERR_BAD_REQUEST, 'invalid JSON', String(e))) + '\n');
      return;
    }
    if (typeof req.id !== 'string' || typeof req.method !== 'string') {
      sock.write(JSON.stringify(errResponse(req.id ?? '?', ERR_BAD_REQUEST, 'missing id/method')) + '\n');
      return;
    }
    try {
      const result = await this.dispatch(req);
      sock.write(JSON.stringify(okResponse(req.id, result)) + '\n');
    } catch (e) {
      const err = e as Error;
      error(`rpc ${req.method} failed`, err.message);
      sock.write(JSON.stringify(errResponse(req.id, ERR_INTERNAL, err.message)) + '\n');
    }
  }

  // -------------------------------------------------------------------------
  // RPC dispatch.
  // -------------------------------------------------------------------------
  private async dispatch(req: RpcRequest): Promise<unknown> {
    const p = (req.params ?? {}) as Record<string, unknown>;
    switch (req.method) {
      // ---- meta ----
      case 'ping':         return { pong: true, ts: Date.now() };
      case 'version':      return { version: QUILT_VERSION, revision: QUILT_REV, uptime: this.uptime() };
      case 'status':       return this.statusSnapshot();
      case 'reload-config':this.reloadConfig(); return { ok: true };

      // ---- cells ----
      case 'cell.list':    return this.state.listCells();
      case 'cell.get':     return this.cellGet(String(p['id'] ?? ''));
      case 'cell.start':   return this.cellStart(p);
      case 'cell.stop':    return this.cellStop(String(p['id'] ?? ''));
      case 'cell.restart': return this.cellRestart(String(p['id'] ?? ''));
      case 'cell.logs':    return this.cellLogs(String(p['id'] ?? ''), Number(p['tail'] ?? 100));

      // ---- telemetry ----
      case 'telemetry.recent': return this.state.recentTelemetry(Number(p['limit'] ?? 100));

      // ---- fleet ----
      case 'fleet.ping':   return this.fleetPing();
      case 'fleet.register':return this.fleetRegister();

      // ---- ota ----
      case 'ota.check':    return this.ota.check();
      case 'ota.refresh':  return this.ota.refresh();
      case 'ota.history':  return this.state.otaHistory(Number(p['limit'] ?? 50));

      // ---- maintenance ----
      case 'doctor':       return this.doctor();
      default:
        throw Object.assign(new Error(`unknown method: ${req.method}`), { code: ERR_NOT_FOUND });
    }
  }

  // -------------------------------------------------------------------------
  // Cell management.
  // -------------------------------------------------------------------------
  private cellGet(id: string): CellRecord {
    const cell = this.state.getCell(id);
    if (!cell) throw Object.assign(new Error(`cell not found: ${id}`), { code: ERR_NOT_FOUND });
    return cell;
  }

  private async cellStart(params: Record<string, unknown>): Promise<CellRecord> {
    const id = String(params['id'] ?? `cell-${++this.reqSeq}`);
    const existing = this.cells.get(id);
    if (existing && existing.alive()) {
      throw Object.assign(new Error(`cell already running: ${id}`), { code: ERR_CONFLICT });
    }
    const cmd  = String(params['command'] ?? 'quilt-base');
    const args = Array.isArray(params['args']) ? (params['args'] as string[]) : [];
    const env  = (params['env'] && typeof params['env'] === 'object')
      ? (params['env'] as Record<string, string>) : {};
    const cell = new CellProcess(id, cmd, args, env);
    this.cells.set(id, cell);
    cell.start();
    const rec: CellRecord = {
      id, command: cmd, args, env,
      pid: cell.pid, status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.state.upsertCell(rec);
    return rec;
  }

  private async cellStop(id: string): Promise<{ ok: true }> {
    const cell = this.cells.get(id);
    if (!cell) throw Object.assign(new Error(`no live cell: ${id}`), { code: ERR_NOT_FOUND });
    cell.kill('SIGTERM');
    await cell.wait(5_000);
    this.cells.delete(id);
    this.state.updateCell(id, { status: 'stopped', stoppedAt: new Date().toISOString() });
    return { ok: true };
  }

  private async cellRestart(id: string): Promise<{ ok: true }> {
    await this.cellStop(id);
    const rec = this.state.getCell(id);
    if (!rec) throw Object.assign(new Error(`cell not found: ${id}`), { code: ERR_NOT_FOUND });
    return this.cellStart({ id, command: rec.command, args: rec.args, env: rec.env });
  }

  private async cellLogs(id: string, tail: number): Promise<string[]> {
    const cell = this.cells.get(id);
    if (!cell) throw Object.assign(new Error(`no live cell: ${id}`), { code: ERR_NOT_FOUND });
    return cell.tailLogs(tail);
  }

  // -------------------------------------------------------------------------
  // Fleet.
  // -------------------------------------------------------------------------
  private async fleetPing(): Promise<{ ok: boolean; latencyMs: number; url: string }> {
    if (!this.config.fleetUrl) return { ok: false, latencyMs: 0, url: '' };
    const t0 = Date.now();
    try {
      const ctrl = new AbortController();
      const tm = setTimeout(() => ctrl.abort(), 5_000);
      const res = await fetch(new URL('/api/v1/ping', this.config.fleetUrl), { signal: ctrl.signal });
      clearTimeout(tm);
      return { ok: res.ok, latencyMs: Date.now() - t0, url: this.config.fleetUrl };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, url: this.config.fleetUrl };
    }
  }

  private async fleetRegister(): Promise<{ nodeId: string; registered: boolean }> {
    const nodeId = this.state.nodeId();
    if (!this.config.fleetUrl) return { nodeId, registered: false };
    try {
      const res = await fetch(new URL('/api/v1/nodes', this.config.fleetUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nodeId,
          version: QUILT_VERSION,
          revision: QUILT_REV,
          arch: process.arch,
          hostname: os.hostname(),
        }),
      });
      return { nodeId, registered: res.ok };
    } catch {
      return { nodeId, registered: false };
    }
  }

  // -------------------------------------------------------------------------
  // Telemetry.
  // -------------------------------------------------------------------------
  private async recordTelemetry(): Promise<void> {
    const cpus = os.cpus();
    const load = os.loadavg()[0] ?? 0;
    const rec: TelemetryRecord = {
      ts:         new Date().toISOString(),
      cpuPercent: Math.min(100, (load / cpus.length) * 100),
      memUsedMB:  Math.round((os.totalmem() - os.freemem()) / 1024 / 1024),
      memTotalMB: Math.round(os.totalmem() / 1024 / 1024),
      uptimeSec:  Math.round(os.uptime()),
      cellsLive:  [...this.cells.values()].filter((c) => c.alive()).length,
    };
    this.state.insertTelemetry(rec);
  }

  // -------------------------------------------------------------------------
  // Doctor.
  //
  // The doctor check is what snapd's health probe runs to decide
  // whether the new boot is good. We do a *shallow* check here: the
  // state DB is reachable, the socket is up, the OTA checker is
  // running. A deep check (a real cell RPC) is too expensive to
  // block on for every health probe.
  // -------------------------------------------------------------------------
  private doctor(): { ok: boolean; checks: Array<{ name: string; ok: boolean; detail?: string }> } {
    const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
    checks.push({ name: 'socket',    ok: this.running,                  detail: QUILT_SOCK });
    checks.push({ name: 'state-db',  ok: this.state.healthy(),          detail: QUILT_STATE });
    checks.push({ name: 'ota',       ok: this.ota.running(),            detail: this.config.otaChannel });
    checks.push({ name: 'cells',     ok: true,                          detail: `${this.cells.size} live` });
    const ok = checks.every((c) => c.ok);
    return { ok, checks };
  }

  // -------------------------------------------------------------------------
  // Status snapshot.
  // -------------------------------------------------------------------------
  private statusSnapshot(): unknown {
    return {
      version:   QUILT_VERSION,
      revision:  QUILT_REV,
      pid:       process.pid,
      uptime:    this.uptime(),
      startedAt: new Date(this.startedAt).toISOString(),
      nodeId:    this.state.nodeId(),
      arch:      process.arch,
      hostname:  os.hostname(),
      config:    this.config,
      cells:     [...this.cells.values()].map((c) => c.snapshot()),
      ota:       this.ota.snapshot(),
    };
  }

  private uptime(): number { return this.running ? Math.round((Date.now() - this.startedAt) / 1000) : 0; }
}

// ---------------------------------------------------------------------------
// Cell process wrapper.
//
// Each Quilt cell is an external command. We wrap it so we can:
//   - capture stdout/stderr to a ring buffer (for `cell.logs`).
//   - track pid + exit status.
//   - send SIGTERM, wait, escalate to SIGKILL.
//   - write a TelemetryRecord when the cell exits.
// ---------------------------------------------------------------------------
type CellStatus = 'starting' | 'running' | 'stopped' | 'failed';

class CellProcess {
  readonly id:      string;
  readonly command: string;
  readonly args:    string[];
  readonly env:     Record<string, string>;
  pid               = 0;
  status:   CellStatus = 'starting';
  startedAt: string   = new Date().toISOString();
  stoppedAt: string | null = null;
  exitCode:  number | null = null;

  private proc:   import('node:child_process').ChildProcess | null = null;
  private buf:    string[]   = [];
  private static readonly RING = 2000;

  constructor(id: string, command: string, args: string[], env: Record<string, string>) {
    this.id      = id;
    this.command = command;
    this.args    = args;
    this.env     = env;
  }

  start(): void {
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const fullEnv: NodeJS.ProcessEnv = { ...process.env, ...this.env, QUILT_CELL_ID: this.id };
    this.proc = spawn(this.command, this.args, {
      env: fullEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    this.pid     = this.proc.pid ?? 0;
    this.status  = 'running';
    this.proc.stdout?.on('data', (c: Buffer) => this.push(c.toString('utf8')));
    this.proc.stderr?.on('data', (c: Buffer) => this.push(c.toString('utf8')));
    this.proc.on('exit', (code, signal) => {
      this.status   = code === 0 || signal === 'SIGTERM' ? 'stopped' : 'failed';
      this.exitCode = code;
      this.stoppedAt = new Date().toISOString();
    });
  }

  alive(): boolean { return this.status === 'running' && this.pid > 0; }

  kill(sig: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
    if (this.proc && this.alive()) {
      try { this.proc.kill(sig); } catch { /* ignore */ }
    }
  }

  wait(timeoutMs: number): Promise<void> {
    if (!this.alive()) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => { try { this.kill('SIGKILL'); } catch {} resolve(); }, timeoutMs);
      this.proc?.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }

  tailLogs(n: number): string[] {
    return this.buf.slice(-Math.max(0, n));
  }

  snapshot(): { id: string; pid: number; status: CellStatus; command: string; args: string[]; startedAt: string; stoppedAt: string | null } {
    return { id: this.id, pid: this.pid, status: this.status, command: this.command, args: this.args, startedAt: this.startedAt, stoppedAt: this.stoppedAt };
  }

  private push(s: string): void {
    for (const line of s.split(/\r?\n/)) {
      if (line.length === 0) continue;
      this.buf.push(line);
      if (this.buf.length > CellProcess.RING) this.buf.shift();
    }
  }
}

// ---------------------------------------------------------------------------
// Daemon config.
interface DaemonConfig {
  cellPort:      number;
  telemetryPort: number;
  otaChannel:    'edge' | 'beta' | 'stable' | string;
  otaIntervalMs: number;
  logLevel:      string;
  fleetUrl:      string;
}

// ---------------------------------------------------------------------------
// Subcommand dispatch.
//
// `node daemon.js daemon`     — run the service (foreground).
// `node daemon.js init`       — first-time DB seed (called by the install hook).
// `node daemon.js configcheck`— one-shot doctor probe (called by snapd timer).
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const sub = process.argv[2] ?? 'daemon';

  if (sub === 'init') {
    // Idempotent. Used by snap/hooks/install on first install.
    const state = new State(QUILT_STATE);
    state.init();
    info('state DB initialised at ' + QUILT_STATE);
    info('node-id: ' + state.nodeId());
    return;
  }

  if (sub === 'configcheck') {
    const d = new Daemon();
    await d.start();
    const r = d['doctor']() as { ok: boolean; checks: unknown[] };
    info('configcheck: ' + JSON.stringify(r));
    await d.stop();
    process.exit(r.ok ? 0 : 1);
  }

  if (sub === 'daemon') {
    const d = new Daemon();
    await d.start();
    // Graceful shutdown.
    const shutdown = async (sig: string) => {
      info('received ' + sig + ', shutting down');
      await d.stop();
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT',  () => void shutdown('SIGINT'));
    // Park the event loop; the rest is event-driven.
    return;
  }

  // Unknown subcommand.
  process.stderr.write(`@superinstance/quilt-core daemon: unknown subcommand: ${sub}\n`);
  process.stderr.write('usage: daemon {daemon|init|configcheck}\n');
  process.exit(2);
}

// Only run main() if this file is the entry point (not when imported
// by tests).
if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`@superinstance/quilt-core daemon: fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}

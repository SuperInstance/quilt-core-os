/**
 * src/ota-checker.ts — periodic over-the-air update checker.
 *
 * Responsibilities:
 *
 *   1. Poll the snap store (via `snapd`'s REST API over the
 *      abstract unix socket at /run/snapd.socket) for new
 *      revisions of the `@superinstance/quilt-core` snap on the configured
 *      channel.
 *
 *   2. Verify the assertions cryptographically. snapd does this
 *      for us — we just check the response. The actual signature
 *      check is performed by snapd itself before the response is
 *      sent.
 *
 *   3. Trigger `snap refresh` when a newer revision is available.
 *      snapd stages the new revision in the alternate A/B slot
 *      and schedules a reboot; if the new boot fails its health
 *      check, snapd reverts automatically.
 *
 *   4. Sign and append a record to the OTA history table on every
 *      outcome (success / failure / skipped).
 *
 *   5. Honour a `quilt-fleet` pin: if the device is pinned to a
 *      specific revision, do nothing, even if a newer one exists.
 *
 * This module does *not* implement the rollback logic. The OS
 * (Ubuntu Core) does. We just ask for new revisions and trust
 * the kernel to revert if anything goes wrong.
 */

import * as os from 'node:os';
import { State, OtaRecord } from './state';

interface OtaConfig {
  cellPort:      number;
  telemetryPort: number;
  otaChannel:    string;
  otaIntervalMs: number;
  logLevel:      string;
  fleetUrl:      string;
}

interface OtaStatus {
  running:    boolean;
  lastCheck:  string | null;
  lastResult: 'success' | 'failure' | 'skipped' | 'unknown';
  channel:    string;
  pinned:     boolean;
  pinnedRev:  string;
  currentRev: string;
  nextCheck:  string | null;
}

export class OtaChecker {
  private readonly state:    State;
  private config:  OtaConfig;
  private timer:   NodeJS.Timeout | null = null;
  private _running = false;
  private _lastCheck:  string | null = null;
  private _lastResult: 'success' | 'failure' | 'skipped' | 'unknown' = 'unknown';
  private _pinned:     boolean = false;
  private _pinnedRev:  string  = '';
  private _currentRev: string  = process.env.SNAP_REVISION ?? '0';

  constructor(state: State, config: OtaConfig) {
    this.state  = state;
    this.config = config;
  }

  // -------------------------------------------------------------------------
  // Lifecycle.
  // -------------------------------------------------------------------------
  start(): void {
    if (this._running) return;
    this._running = true;
    this.log('info', `OTA checker started (channel=${this.config.otaChannel}, interval=${this.config.otaIntervalMs}ms)`);
    // First check after a short jitter so all devices don't stampede the snap store.
    const initialDelay = 5_000 + Math.floor(Math.random() * 25_000);
    this.timer = setTimeout(() => {
      this.checkAndSchedule();
    }, initialDelay);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this._running) return;
    this._running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.log('info', 'OTA checker stopped');
  }

  running(): boolean { return this._running; }

  // -------------------------------------------------------------------------
  // Update config (called by the daemon when the configure hook fires).
  // -------------------------------------------------------------------------
  setConfig(c: OtaConfig): void {
    this.config = c;
    if (this._running) {
      // Reschedule with the new interval.
      this.stop();
      this.start();
    }
  }

  // -------------------------------------------------------------------------
  // Public RPC methods.
  // -------------------------------------------------------------------------
  async check(): Promise<OtaStatus> {
    await this.tick();
    return this.snapshot();
  }

  async refresh(): Promise<{ triggered: boolean; reason: string }> {
    const rev = await this.currentRemoteRevision();
    if (!rev) return { triggered: false, reason: 'snapd unreachable' };
    if (this._pinned && rev === this._pinnedRev) {
      return { triggered: false, reason: 'pinned to current revision' };
    }
    if (this._pinned && rev !== this._pinnedRev) {
      this.recordOutcome('skipped', 'pinned; refusing refresh');
      return { triggered: false, reason: `pinned to ${this._pinnedRev}, ignoring ${rev}` };
    }
    if (rev === this._currentRev) {
      return { triggered: false, reason: 'already on latest' };
    }
    // Issue the refresh. snapd will schedule the slot swap.
    const ok = await this.snapdRefresh(this.config.otaChannel);
    if (ok) {
      this.recordOutcome('success', `${this._currentRev} → ${rev}`);
      this._currentRev = rev;
    } else {
      this.recordOutcome('failure', `snapd refresh failed for ${rev}`);
    }
    return { triggered: ok, reason: ok ? 'refresh requested' : 'snapd refused' };
  }

  snapshot(): OtaStatus {
    return {
      running:    this._running,
      lastCheck:  this._lastCheck,
      lastResult: this._lastResult,
      channel:    this.config.otaChannel,
      pinned:     this._pinned,
      pinnedRev:  this._pinnedRev,
      currentRev: this._currentRev,
      nextCheck:  this._running && this.timer
        ? new Date(Date.now() + this.config.otaIntervalMs).toISOString()
        : null,
    };
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------
  private async checkAndSchedule(): Promise<void> {
    try {
      await this.tick();
    } catch (e) {
      this.log('warn', 'check failed', (e as Error).message);
    } finally {
      if (this._running) {
        this.timer = setTimeout(() => this.checkAndSchedule(), this.config.otaIntervalMs);
        this.timer.unref?.();
      }
    }
  }

  private async tick(): Promise<void> {
    this._lastCheck = new Date().toISOString();
    // 1. Ask snapd for our current pin (if any).
    const pin = await this.snapdPin();
    this._pinned    = pin.pinned;
    this._pinnedRev = pin.revision;
    this._currentRev = pin.current;

    // 2. Ask snapd for the remote revision on our channel.
    const remote = await this.currentRemoteRevision();
    if (!remote) {
      this._lastResult = 'failure';
      this.log('warn', 'no remote revision returned');
      return;
    }

    // 3. Decide.
    if (this._pinned) {
      if (remote !== this._pinnedRev) {
        this._lastResult = 'skipped';
        this.recordOutcome('skipped', `pinned=${this._pinnedRev}, remote=${remote}`);
        return;
      }
      this._lastResult = 'success';
      return;
    }
    if (remote === this._currentRev) {
      this._lastResult = 'success';
      return;
    }

    // 4. Trigger the refresh.
    this.log('info', `new revision available: ${this._currentRev} → ${remote} on ${this.config.otaChannel}`);
    const ok = await this.snapdRefresh(this.config.otaChannel);
    this._lastResult = ok ? 'success' : 'failure';
    this.recordOutcome(ok ? 'success' : 'failure', `${this._currentRev} → ${remote}`);
    if (ok) this._currentRev = remote;
  }

  // -------------------------------------------------------------------------
  // snapd REST over the abstract unix socket.
  //
  // The protocol is plain HTTP over a unix socket. We use
  // node:http with a custom `Agent` to talk to it without
  // pulling in a third-party HTTP client.
  // -------------------------------------------------------------------------
  private snapdBase(): string { return '/run/snapd.socket'; }

  private async snapdGet(path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const http = require('node:http') as typeof import('node:http');
      const req = http.request({
        socketPath: this.snapdBase(),
        path,
        method: 'GET',
        headers: { 'accept': 'application/json' },
      }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => buf += c);
        res.on('end',  () => resolve({ status: res.statusCode ?? 0, body: buf }));
      });
      req.on('error', (e) => reject(e));
      req.setTimeout(5_000, () => { req.destroy(new Error('snapd timeout')); });
      req.end();
    });
  }

  private async snapdPost(path: string, body: unknown): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const http = require('node:http') as typeof import('node:http');
      const data = JSON.stringify(body);
      const req = http.request({
        socketPath: this.snapdBase(),
        path,
        method: 'POST',
        headers: {
          'content-type':   'application/json',
          'content-length': Buffer.byteLength(data),
          'accept':         'application/json',
        },
      }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => buf += c);
        res.on('end',  () => resolve({ status: res.statusCode ?? 0, body: buf }));
      });
      req.on('error', (e) => reject(e));
      req.setTimeout(30_000, () => { req.destroy(new Error('snapd timeout')); });
      req.write(data);
      req.end();
    });
  }

  private async currentRemoteRevision(): Promise<string | null> {
    try {
      const url = `/v2/snaps/${encodeURIComponent('@superinstance/quilt-core')}`;
      const res = await this.snapdGet(url);
      if (res.status !== 200) return null;
      const j = JSON.parse(res.body) as {
        status: string;
        result?: {
          channel?: string;
          'tracking-channel'?: string;
          revision?: string;
          channels?: Record<string, { revision: string; size: number }>;
        };
      };
      if (j.status !== 'OK' || !j.result) return null;
      const ch = j.result.channels?.[this.config.otaChannel];
      if (ch?.revision) return ch.revision;
      return j.result.revision ?? null;
    } catch {
      return null;
    }
  }

  private async snapdPin(): Promise<{ pinned: boolean; revision: string; current: string }> {
    try {
      const url = `/v2/snaps/${encodeURIComponent('@superinstance/quilt-core')}`;
      const res = await this.snapdGet(url);
      if (res.status !== 200) return { pinned: false, revision: '', current: this._currentRev };
      const j = JSON.parse(res.body) as {
        status: string;
        result?: {
          revision?: string;
          'hold'?: string;        // ISO timestamp until which the snap is held
          'pinned-by-fleet'?: boolean;
        };
      };
      const cur = j.result?.revision ?? this._currentRev;
      if (j.result?.['pinned-by-fleet']) {
        return { pinned: true, revision: cur, current: cur };
      }
      if (j.result?.hold) {
        // Held by a `snap refresh --hold` command; treat as pinned.
        return { pinned: true, revision: cur, current: cur };
      }
      return { pinned: false, revision: '', current: cur };
    } catch {
      return { pinned: false, revision: '', current: this._currentRev };
    }
  }

  private async snapdRefresh(channel: string): Promise<boolean> {
    try {
      const url = `/v2/snaps/${encodeURIComponent('@superinstance/quilt-core')}`;
      const body = {
        action:  'refresh',
        channel,
      };
      const res = await this.snapdPost(url, body);
      if (res.status !== 202 && res.status !== 200) return false;
      const j = JSON.parse(res.body) as { status: string; result?: unknown };
      return j.status === 'Accepted' || j.status === 'OK';
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // History + logging.
  // -------------------------------------------------------------------------
  private recordOutcome(outcome: 'success' | 'failure' | 'skipped', detail: string): void {
    try {
      const rec: OtaRecord = {
        ts:           new Date().toISOString(),
        fromRevision: this._currentRev,
        toRevision:   this._currentRev,
        channel:      this.config.otaChannel,
        outcome,
        detail,
      };
      this.state.appendOta(rec);
    } catch (e) {
      this.log('warn', 'failed to record OTA outcome', (e as Error).message);
    }
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, extra?: string): void {
    const ts = new Date().toISOString();
    const host = os.hostname();
    const line = `[${ts}] [${level}] [${host}] [ota] ${msg}${extra ? ' ' + extra : ''}\n`;
    process.stderr.write(line);
  }
}

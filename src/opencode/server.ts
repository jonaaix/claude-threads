/**
 * Shared opencode server hub.
 *
 * Unlike the Claude Code CLI — one child process per session — opencode uses a
 * client/server model where a single `opencode serve` process can host many
 * sessions concurrently. So the whole bot shares ONE server and ONE SSE event
 * subscription; events carry a `sessionID` which we use to fan out to the
 * per-session `OpencodeAgent` that registered for it.
 *
 * This hub owns:
 *  - the lazily-started server process (via the SDK's `createOpencodeServer`,
 *    which spawns the `opencode` binary — it must be on PATH),
 *  - the single `OpencodeClient` every agent talks to,
 *  - the single global event stream and its sessionID → listener dispatch.
 *
 * Start is idempotent and concurrency-safe (a single in-flight init promise).
 */

import { createOpencodeServer, createOpencodeClient } from '@opencode-ai/sdk';
import type { OpencodeClient, Event } from '@opencode-ai/sdk';
import { execSync } from 'child_process';
import { dirname, delimiter } from 'path';
import { createLogger } from '../utils/logger.js';
import { getOpencodePath } from './version-check.js';

const log = createLogger('opencode');

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Free a port held by a LEFTOVER opencode server so we can start a fresh one
 * (picking up any config/model changes). We only SIGKILL a process whose
 * command line is opencode — never an unrelated service on the port. Unix-only
 * (uses `lsof`/`ps`); returns false on Windows or when nothing was killed, in
 * which case the caller falls back to reusing whatever is there.
 */
function reclaimOpencodePort(port: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    const pids = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8', timeout: 4000 })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    let killed = false;
    for (const pid of pids) {
      try {
        const cmd = execSync(`ps -o command= -p ${pid}`, { encoding: 'utf8', timeout: 4000 });
        if (!/opencode/i.test(cmd)) continue; // don't kill unrelated services
        process.kill(Number(pid), 'SIGKILL');
        log.debug(`Killed leftover opencode server pid=${pid} on port ${port}`);
        killed = true;
      } catch {
        // process gone or ps/kill failed — ignore, best-effort
      }
    }
    return killed;
  } catch {
    // lsof missing or nothing listening — nothing to reclaim
    return false;
  }
}

/**
 * Ensure the SDK's `createOpencodeServer` (which spawns a bare `opencode`,
 * resolved via PATH) picks the SAME binary our version check validated /
 * `OPENCODE_PATH` points to. Without this, a host with multiple `opencode`
 * installs could serve from a different (older) binary than we vetted. We
 * prepend the resolved binary's directory to PATH; no-op when it's already
 * first or the path is a bare name.
 */
function alignOpencodeOnPath(): void {
  const bin = getOpencodePath();
  if (!bin.includes('/') && !bin.includes('\\')) return; // bare name → leave PATH as-is
  const dir = dirname(bin);
  const parts = (process.env.PATH ?? '').split(delimiter);
  if (parts[0] === dir) return;
  process.env.PATH = [dir, ...parts.filter((p) => p !== dir)].join(delimiter);
  log.debug(`Prepended ${dir} to PATH so the opencode server spawns from ${bin}`);
}

/** Extract the owning session id from any opencode event, or undefined. */
export function sessionIdOf(event: Event): string | undefined {
  const props = (event as { properties?: Record<string, unknown> }).properties;
  if (!props) return undefined;
  const p = props as {
    sessionID?: string;
    part?: { sessionID?: string };
    info?: { sessionID?: string; id?: string };
  };
  // message.part.updated → part.sessionID; message.updated → info.sessionID;
  // everything else we translate (todo.updated, session.idle/error) → sessionID.
  return p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID;
}

type Listener = (event: Event) => void;

export class OpencodeServerHub {
  private server: { url: string; close(): void } | null = null;
  private clientInstance: OpencodeClient | null = null;
  private initPromise: Promise<OpencodeClient> | null = null;
  private readonly listeners = new Map<string, Listener>();
  private stopped = false;

  /** The shared client, or null before the first successful `ensureStarted()`. */
  get client(): OpencodeClient | null {
    return this.clientInstance;
  }

  /**
   * Start the server + client and the global event loop once. Concurrent
   * callers share the same in-flight init. Throws if the `opencode` binary
   * can't be started (missing / incompatible).
   */
  ensureStarted(): Promise<OpencodeClient> {
    if (this.clientInstance) return Promise.resolve(this.clientInstance);
    if (this.initPromise) return this.initPromise;
    // Do NOT cache a rejected init: clear it so a later message retries. Caching
    // a rejection would kill opencode for the whole process lifetime after one
    // transient failure (e.g. the port was briefly occupied during a restart).
    this.initPromise = this.init().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async init(): Promise<OpencodeClient> {
    this.stopped = false;
    alignOpencodeOnPath();
    // opencode listens on 4096 by default. If that collides with a developer's
    // own `opencode serve`, set OPENCODE_PORT to a free port.
    const port = Number(process.env.OPENCODE_PORT ?? '4096');
    const hostname = '127.0.0.1';
    let url: string;
    try {
      log.debug(`Starting opencode server (port=${port})`);
      this.server = await createOpencodeServer({ hostname, port });
      url = this.server.url;
      log.info(`opencode server listening at ${url}`);
    } catch {
      // Port occupied — almost always our OWN opencode server left over from a
      // previous run (a `bun --watch` reload or a fast restart skips/outruns our
      // graceful shutdown, which only SIGTERMs without waiting). Reclaim it and
      // start fresh, so config/model changes actually take effect — reusing the
      // stale server would silently keep running the OLD model.
      const reclaimed = reclaimOpencodePort(port);
      if (reclaimed) {
        await delay(400); // let the OS release the port after SIGKILL
      }
      try {
        log.warn(
          reclaimed
            ? `Reclaimed port ${port} from a leftover opencode server; starting fresh`
            : `Port ${port} busy and no reclaimable opencode process found; retrying spawn`,
        );
        this.server = await createOpencodeServer({ hostname, port });
        url = this.server.url;
        log.info(`opencode server listening at ${url}`);
      } catch (retryErr) {
        // Last resort: connect to whatever is on the port (may be the user's own
        // `opencode serve`, or a server we couldn't kill). It might run a stale
        // config, but a working bot beats a dead one. subscribe() below validates it.
        this.server = null; // not ours → shutdown() must not close it
        url = `http://${hostname}:${port}`;
        log.warn(
          `Could not start a fresh opencode server (${String(retryErr).split('\n')[0]}); ` +
          `reusing the existing server at ${url} (it may run an outdated config)`,
        );
      }
    }
    const client = createOpencodeClient({ baseUrl: url });

    // Establish the global subscription BEFORE returning, so no early events
    // are missed once agents start creating sessions. Also doubles as the
    // reachability check for a reused server: if it throws, init rejects and
    // `clientInstance` stays null (so the getter never hands out a dead client).
    const events = await client.event.subscribe();
    this.clientInstance = client;
    void this.runEventLoop(events.stream);

    return client;
  }

  /**
   * Consume the event stream, self-healing forever. The initial subscription can
   * silently stall or end (observed: a subscription established the instant the
   * embedded server comes up can hand back a dead stream) — without recovery the
   * hub would deliver nothing until a full bot restart. So on any end, error, or
   * STALL (no events at all for STALL_MS — opencode heartbeats regularly, so
   * silence means the stream is dead) we re-subscribe and keep going.
   */
  private async runEventLoop(initialStream: AsyncIterable<Event>): Promise<void> {
    let stream: AsyncIterable<Event> | null = initialStream;
    while (!this.stopped && stream) {
      try {
        await this.consumeWithWatchdog(stream);
        if (this.stopped) return;
        log.warn('opencode event stream ended; reconnecting');
      } catch (err) {
        if (this.stopped) return;
        log.warn(`opencode event stream lost (${err instanceof Error ? err.message : String(err)}); reconnecting`);
      }
      stream = await this.resubscribe();
    }
  }

  /**
   * Iterate the stream, dispatching events, with a stall watchdog: if no event
   * arrives within STALL_MS, throw so the caller reconnects. Always closes the
   * iterator on exit so the dead SSE connection is released.
   */
  private async consumeWithWatchdog(stream: AsyncIterable<Event>): Promise<void> {
    const STALL_MS = 30_000;
    const iterator = stream[Symbol.asyncIterator]();
    try {
      while (!this.stopped) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stalled = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no events for ${STALL_MS}ms`)), STALL_MS);
        });
        let result: IteratorResult<Event>;
        try {
          result = await Promise.race([iterator.next(), stalled]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (result.done) return; // stream ended cleanly
        this.dispatch(result.value);
      }
    } finally {
      try {
        await iterator.return?.();
      } catch {
        // ignore — best-effort close of a possibly-dead stream
      }
    }
  }

  /** Route one event to its session's listener (no-op for sessionless events). */
  private dispatch(event: Event): void {
    const sessionId = sessionIdOf(event);
    if (!sessionId) return;
    const listener = this.listeners.get(sessionId);
    if (!listener) return;
    try {
      listener(event);
    } catch (err) {
      log.error(`Listener for session ${sessionId} threw: ${err}`);
    }
  }

  /** Re-establish the event subscription, retrying with backoff until it succeeds. */
  private async resubscribe(): Promise<AsyncIterable<Event> | null> {
    const RECONNECT_DELAY_MS = 1000;
    while (!this.stopped) {
      const client = this.clientInstance;
      if (!client) return null;
      try {
        const events = await client.event.subscribe();
        log.info('opencode event stream reconnected');
        return events.stream;
      } catch (err) {
        log.warn(`opencode re-subscribe failed, retrying: ${err instanceof Error ? err.message : String(err)}`);
        await delay(RECONNECT_DELAY_MS);
      }
    }
    return null;
  }

  /** Route this opencode session's events to `listener`. */
  register(sessionId: string, listener: Listener): void {
    this.listeners.set(sessionId, listener);
  }

  /** Stop routing events for a session (on kill/teardown). */
  unregister(sessionId: string): void {
    this.listeners.delete(sessionId);
  }

  /** Shut the server down (bot exit). Safe to call when never started. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    this.listeners.clear();
    try {
      this.server?.close();
    } catch (err) {
      log.debug(`Error closing opencode server: ${err}`);
    }
    this.server = null;
    this.clientInstance = null;
    this.initPromise = null;
  }
}

/** Process-wide singleton — every session shares this one server + subscription. */
export const opencodeHub = new OpencodeServerHub();

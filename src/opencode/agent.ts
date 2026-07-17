/**
 * opencode agent backend.
 *
 * Implements the same `AgentBackend` surface as `ClaudeCli`, so the session
 * layer drives it identically (`start` → `sendMessage` → events → `kill`). The
 * differences from Claude are hidden here:
 *
 *  - There is no per-session child process. `start()` ensures the shared
 *    shared `opencodeServer` is up and creates (or resumes) an opencode
 *    session, then opens its OWN SSE subscription filtered to that session.
 *  - Incoming opencode events are translated into Claude-shaped events by a
 *    per-session `OpencodeEventTranslator` and re-emitted as `'event'`, so the
 *    downstream pipeline is unchanged.
 *  - Prompts go out via `session.promptAsync` (fire-and-forget); the assistant's
 *    output — and any error — comes back over SSE, not as the call's result.
 *  - `interrupt()`/`kill()` use opencode's `session.abort` endpoint instead of
 *    POSIX signals.
 *
 * First-cut simplifications (tracked for follow-up): no rate-limit routing, no
 * statusline/context snapshot, no permanent-failure classification, and the
 * permission flow is whatever the opencode server is configured to do.
 */

import { EventEmitter } from 'events';
import type { Event } from '@opencode-ai/sdk';
import type { AgentBackend } from '../agent/backend.js';
import { OpencodeEventTranslator } from './event-translator.js';
import { opencodeServer } from './server.js';
import type { OpencodeSessionStream } from './event-stream.js';
import { createLogger } from '../utils/logger.js';

/** A concrete opencode model selection, as the SDK's prompt body expects it. */
export interface OpencodeModel {
  providerID: string;
  modelID: string;
}

/**
 * Parse an opencode model spec in opencode's own `provider/model` notation
 * (the same value used in `opencode.json`, e.g. `anthropic/claude-sonnet-4-5`
 * or `openrouter/anthropic/claude-3.5-sonnet`) into `{ providerID, modelID }`.
 *
 * Split on the FIRST `/` so the provider is the leading segment and the model
 * id keeps any remaining slashes (openrouter-style nested ids). Returns
 * undefined for an empty/omitted spec or one without a usable `provider/model`
 * shape — the caller then leaves `model` unset and opencode falls back to its
 * own default (`opencode.json`).
 */
export function parseOpencodeModel(spec: string | undefined): OpencodeModel | undefined {
  if (!spec) return undefined;
  const trimmed = spec.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) };
}

export interface OpencodeAgentOptions {
  /** Working directory the opencode session operates in. */
  workingDir: string;
  /** Session id for log routing (platformId:threadId). */
  logSessionId?: string;
  /** Extra system prompt appended to each turn (thread context, etc.). */
  appendSystemPrompt?: string;
  /**
   * Existing opencode session id to resume instead of creating a new one.
   * Set on resume-after-restart; the id is persisted by the session store.
   */
  opencodeSessionId?: string;
  /** Human-readable session title shown in opencode. */
  title?: string;
  /**
   * Model to use for this session, overriding opencode's own default. Passed on
   * every turn's prompt body. Undefined → opencode picks the model from its own
   * config (`opencode.json`).
   */
  model?: OpencodeModel;
}

export class OpencodeAgent extends EventEmitter implements AgentBackend {
  private readonly translator = new OpencodeEventTranslator();
  private readonly log: ReturnType<typeof createLogger>;
  /** opencode session id (created or resumed); set once `init()` resolves. */
  private sessionId: string | undefined;
  /** This session's own SSE subscription (isolated, self-healing). */
  private stream: OpencodeSessionStream | null = null;
  /** Resolves when the session exists and we're subscribed; rejects on failure. */
  private ready: Promise<void> | null = null;
  private alive = false;
  private exited = false;
  private failureReason: string | null = null;

  constructor(private readonly options: OpencodeAgentOptions) {
    super();
    this.log = createLogger('opencode').forSession(options.logSessionId ?? 'opencode');
  }

  /** The opencode session id, for persistence. Undefined until started. */
  getOpencodeSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Resolve once the session exists (created or resumed) so callers can read
   * `getOpencodeSessionId()` for persistence. Never rejects — an init failure
   * is surfaced separately via the `'error'`/`'exit'` events.
   */
  async whenReady(): Promise<void> {
    try {
      await this.ready;
    } catch {
      /* init failure already surfaced via events */
    }
  }

  start(): void {
    if (this.alive) throw new Error('Already running');
    this.alive = true;
    this.exited = false;
    this.ready = this.init().catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      this.failureReason = `opencode session could not be started: ${error.message}`;
      this.log.error(this.failureReason);
      this.emit('error', error);
      this.emitExit(1);
      throw error;
    });
  }

  private async init(): Promise<void> {
    const client = await opencodeServer.ensureStarted();

    if (this.options.opencodeSessionId) {
      this.sessionId = this.options.opencodeSessionId;
      this.log.debug(`Resuming opencode session ${this.sessionId}`);
    } else {
      const { data, error } = await client.session.create({
        query: { directory: this.options.workingDir },
        body: { title: this.options.title ?? 'claude-threads session' },
      });
      if (error || !data) {
        throw new Error(`session.create failed: ${JSON.stringify(error ?? 'no data')}`);
      }
      this.sessionId = data.id;
      this.log.debug(`Created opencode session ${this.sessionId}`);
    }

    // Open THIS session's own event subscription and wait for it to be live
    // before init resolves — so the first prompt never races a dead stream.
    this.stream = opencodeServer.openStream(this.sessionId, (event) => this.onOpencodeEvent(event), this.log);
    await this.stream.start();
  }

  private onOpencodeEvent(event: Event): void {
    // First cut: auto-approve every permission request. opencode surfaces
    // permissions as `permission.updated` events; without a reply the tool
    // hangs. Wiring these to the thread's reaction-based approval UI (like the
    // Claude MCP permission flow) is deferred — for now this mirrors Claude's
    // "bypass" mode. Operators who want prompting configure it in opencode.
    if (event.type === 'permission.updated') {
      void this.autoApprovePermission(event.properties.id);
      return;
    }
    for (const translated of this.translator.translate(event)) {
      this.emit('event', translated);
    }
  }

  private async autoApprovePermission(permissionID: string): Promise<void> {
    const client = opencodeServer.client;
    if (!client || !this.sessionId) return;
    try {
      await client.postSessionIdPermissionsPermissionId({
        path: { id: this.sessionId, permissionID },
        query: { directory: this.options.workingDir },
        body: { response: 'always' },
      });
    } catch (err) {
      this.log.debug(`auto-approve permission ${permissionID} failed: ${err}`);
    }
  }

  sendMessage(content: string): void {
    if (!this.ready) throw new Error('Not running');
    void this.ready
      .then(async () => {
        const client = opencodeServer.client;
        if (!client || !this.sessionId || !this.alive) return;
        const { error } = await client.session.promptAsync({
          path: { id: this.sessionId },
          query: { directory: this.options.workingDir },
          body: {
            parts: [{ type: 'text', text: content }],
            ...(this.options.appendSystemPrompt ? { system: this.options.appendSystemPrompt } : {}),
            ...(this.options.model ? { model: this.options.model } : {}),
          },
        });
        if (error) {
          // Kicking off the turn failed outright (e.g. no model configured).
          // Turn-time failures instead arrive as a session.error SSE event.
          this.log.error(`promptAsync failed: ${JSON.stringify(error)}`);
          this.emit('event', {
            type: 'assistant',
            message: { content: [{ type: 'text', text: `⚠️ opencode could not start the turn: ${JSON.stringify(error)}` }] },
          });
          this.emit('event', { type: 'result', subtype: 'error_during_execution', is_error: true, result: {} });
        }
      })
      .catch(() => {
        // init() already surfaced the failure via 'error' + 'exit'.
      });
  }

  interrupt(): boolean {
    if (!this.alive || !this.sessionId) return false;
    const client = opencodeServer.client;
    if (!client) return false;
    this.log.debug(`Aborting opencode session ${this.sessionId} (interrupt)`);
    void client.session.abort({ path: { id: this.sessionId }, query: { directory: this.options.workingDir } }).catch(() => {});
    return true;
  }

  async kill(): Promise<void> {
    if (!this.alive) return;
    this.alive = false;
    this.stream?.stop();
    this.stream = null;
    if (this.sessionId) {
      const client = opencodeServer.client;
      try {
        await client?.session.abort({ path: { id: this.sessionId }, query: { directory: this.options.workingDir } });
      } catch (err) {
        this.log.debug(`abort during kill failed (ignored): ${err}`);
      }
    }
    this.emitExit(0);
  }

  isRunning(): boolean {
    return this.alive;
  }

  isPermanentFailure(): boolean {
    return this.failureReason !== null;
  }

  getPermanentFailureReason(): string | null {
    return this.failureReason;
  }

  getStatusData(): null {
    // opencode has no statusline equivalent yet; context/usage is surfaced via
    // the result event's usage instead.
    return null;
  }

  /** Emit `exit` at most once (kill and init-failure can both reach here). */
  private emitExit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.alive = false;
    this.emit('exit', code);
  }
}

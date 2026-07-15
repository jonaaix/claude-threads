/**
 * Tests for OpencodeAgent wiring.
 *
 * The agent is glue over the opencode SDK + the shared hub; the interesting
 * translation logic lives in (and is tested by) event-translator.test.ts. Here
 * we verify the glue: session create/resume, event fan-out, promptAsync, abort,
 * and the exit/failure contract — with the hub's methods stubbed so no real
 * `opencode serve` process is needed.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Event } from '@opencode-ai/sdk';
import { OpencodeAgent } from './agent.js';
import { opencodeHub } from './server.js';

// A completed opencode text part → should translate to one assistant event.
const completedText = (text: string): Event =>
  ({
    type: 'message.part.updated',
    properties: {
      part: { id: 'p1', sessionID: 'oc-1', messageID: 'm', type: 'text', text, time: { start: 0, end: 1 } },
    },
  }) as unknown as Event;

interface Stub {
  createResult: { data?: { id: string }; error?: unknown };
  registered?: (e: Event) => void;
  registeredId?: string;
  unregistered: string[];
  promptCalls: unknown[];
  abortCalls: unknown[];
  client: unknown;
}

let stub: Stub;

beforeEach(() => {
  stub = {
    createResult: { data: { id: 'oc-1' } },
    unregistered: [],
    promptCalls: [],
    abortCalls: [],
    client: null,
  };
  stub.client = {
    session: {
      create: mock(async () => stub.createResult),
      promptAsync: mock(async (opts: unknown) => {
        stub.promptCalls.push(opts);
        return { error: undefined };
      }),
      abort: mock(async (opts: unknown) => {
        stub.abortCalls.push(opts);
        return { data: true };
      }),
    },
  };

  // Shadow the singleton's methods/getter (own props over prototype).
  (opencodeHub as unknown as { ensureStarted: () => Promise<unknown> }).ensureStarted = async () => stub.client;
  (opencodeHub as unknown as { register: (id: string, fn: (e: Event) => void) => void }).register = (id, fn) => {
    stub.registeredId = id;
    stub.registered = fn;
  };
  (opencodeHub as unknown as { unregister: (id: string) => void }).unregister = (id) => {
    stub.unregistered.push(id);
  };
  Object.defineProperty(opencodeHub, 'client', { configurable: true, get: () => stub.client });
});

afterEach(() => {
  // Remove own-prop shadows so the real prototype methods/getter come back.
  delete (opencodeHub as unknown as Record<string, unknown>).ensureStarted;
  delete (opencodeHub as unknown as Record<string, unknown>).register;
  delete (opencodeHub as unknown as Record<string, unknown>).unregister;
  delete (opencodeHub as unknown as Record<string, unknown>).client;
});

/** Access the private readiness promise so tests can await init. */
const ready = (a: OpencodeAgent): Promise<void> => (a as unknown as { ready: Promise<void> }).ready;

describe('OpencodeAgent', () => {
  it('creates an opencode session on start and registers for its events', async () => {
    const agent = new OpencodeAgent({ workingDir: '/repo' });
    agent.start();
    await ready(agent);

    expect(stub.registeredId).toBe('oc-1');
    expect(agent.getOpencodeSessionId()).toBe('oc-1');
    expect(agent.isRunning()).toBe(true);
  });

  it('resumes an existing session id without creating a new one', async () => {
    const created = (stub.client as { session: { create: ReturnType<typeof mock> } }).session.create;
    const agent = new OpencodeAgent({ workingDir: '/repo', opencodeSessionId: 'resumed-42' });
    agent.start();
    await ready(agent);

    expect(created).not.toHaveBeenCalled();
    expect(stub.registeredId).toBe('resumed-42');
    expect(agent.getOpencodeSessionId()).toBe('resumed-42');
  });

  it('translates incoming opencode events and re-emits them as Claude events', async () => {
    const agent = new OpencodeAgent({ workingDir: '/repo' });
    const seen: Array<{ type: string }> = [];
    agent.on('event', (e: { type: string }) => seen.push(e));
    agent.start();
    await ready(agent);

    // Mark message 'm' as an assistant message first — the translator only
    // surfaces text from assistant messages (see the user-echo regression).
    stub.registered?.({ type: 'message.updated', properties: { info: { role: 'assistant', id: 'm' } } } as unknown as Event);
    stub.registered?.(completedText('Hello from opencode'));

    const assistant = seen.find((e) => e.type === 'assistant') as
      | { message?: { content?: Array<{ text?: string }> } }
      | undefined;
    expect(assistant?.message?.content?.[0]?.text).toBe('Hello from opencode');
  });

  it('sends a prompt via promptAsync with the text part and directory', async () => {
    const agent = new OpencodeAgent({ workingDir: '/repo' });
    agent.start();
    await ready(agent);

    agent.sendMessage('do the thing');
    await new Promise((r) => setTimeout(r, 0)); // let the async send settle

    expect(stub.promptCalls).toHaveLength(1);
    expect(stub.promptCalls[0]).toMatchObject({
      path: { id: 'oc-1' },
      query: { directory: '/repo' },
      body: { parts: [{ type: 'text', text: 'do the thing' }] },
    });
  });

  it('aborts the session and emits exit once on kill', async () => {
    const agent = new OpencodeAgent({ workingDir: '/repo' });
    let exits = 0;
    agent.on('exit', () => exits++);
    agent.start();
    await ready(agent);

    await agent.kill();
    await agent.kill(); // idempotent

    expect(stub.unregistered).toEqual(['oc-1']);
    expect(stub.abortCalls).toHaveLength(1);
    expect(exits).toBe(1);
    expect(agent.isRunning()).toBe(false);
  });

  it('surfaces a session-create failure as error + exit + permanent failure', async () => {
    stub.createResult = { error: { message: 'no provider configured' } };
    const agent = new OpencodeAgent({ workingDir: '/repo' });
    const errors: Error[] = [];
    let exits = 0;
    agent.on('error', (e: Error) => errors.push(e));
    agent.on('exit', () => exits++);
    agent.start();
    await ready(agent).catch(() => {}); // ready rejects on failure

    expect(errors).toHaveLength(1);
    expect(exits).toBe(1);
    expect(agent.isPermanentFailure()).toBe(true);
    expect(agent.getPermanentFailureReason()).toContain('could not be started');
  });
});

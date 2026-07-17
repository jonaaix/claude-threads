import { describe, it, expect } from 'bun:test';
import type { Event } from '@opencode-ai/sdk';
import { OpencodeSessionStream, sessionIdOf, type EventSubscribeClient } from './event-stream.js';

// A finite async stream that yields the given events then ends.
function streamOf(...events: Event[]): AsyncIterable<Event> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
  };
}

// An event owned by `session`, tagged with `n` for ordering assertions.
const evFor = (session: string, n: number): Event =>
  ({ type: 'x', properties: { sessionID: session, n } } as unknown as Event);
const ev = (n: number): Event => evFor('ses_1', n);

// No-op logger — the stream only calls warn/info/error for diagnostics.
const log = { warn() {}, info() {}, error() {}, debug() {} } as unknown as ConstructorParameters<
  typeof OpencodeSessionStream
>[3];

// Build a fake client whose successive subscribes hand back queued streams.
function fakeClientFrom(queued: AsyncIterable<Event>[]): { client: EventSubscribeClient; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      event: {
        subscribe: async () => {
          calls++;
          return { stream: queued.shift() ?? streamOf() };
        },
      },
    },
  };
}

// Reach the private loop/subscribe for unit-driving without a real server.
type Internals = {
  runLoop(s: AsyncIterable<Event>): Promise<void>;
  subscribeLive(attempts: number): Promise<AsyncIterable<Event>>;
  stopped: boolean;
};
const internals = (s: OpencodeSessionStream): Internals => s as unknown as Internals;
const nOf = (e: Event): number => (e as unknown as { properties: { n: number } }).properties.n;

describe('sessionIdOf', () => {
  it('reads properties.sessionID / part.sessionID / info.sessionID', () => {
    expect(sessionIdOf({ properties: { sessionID: 'a' } } as unknown as Event)).toBe('a');
    expect(sessionIdOf({ properties: { part: { sessionID: 'b' } } } as unknown as Event)).toBe('b');
    expect(sessionIdOf({ properties: { info: { sessionID: 'c' } } } as unknown as Event)).toBe('c');
    expect(sessionIdOf({ properties: {} } as unknown as Event)).toBeUndefined();
  });
});

describe('OpencodeSessionStream', () => {
  it('re-subscribes after the stream ends and keeps dispatching', async () => {
    // Second subscribe hands back the next stream → proves the reconnect works.
    const { client, calls } = fakeClientFrom([streamOf(ev(2))]);
    const got: number[] = [];
    const stream = new OpencodeSessionStream(client, 'ses_1', (e) => {
      got.push(nOf(e));
      if (got.length >= 2) internals(stream).stopped = true; // exit after the reconnected event
    }, log);

    // First stream ends after ev(1) → must re-subscribe to get ev(2).
    await internals(stream).runLoop(streamOf(ev(1)));

    expect(got).toEqual([1, 2]);
    expect(calls()).toBe(1); // reconnected (verified-live) exactly once
  });

  it('discards a dead subscription (no initial event) and re-subscribes until live', async () => {
    // First subscription is dead (ends immediately, no event); second is live.
    const { client, calls } = fakeClientFrom([streamOf(), streamOf(ev(7))]);
    const got: number[] = [];
    const stream = new OpencodeSessionStream(client, 'ses_1', (e) => got.push(nOf(e)), log);

    await internals(stream).subscribeLive(0);

    expect(got).toEqual([7]); // the verified-live first event was dispatched
    expect(calls()).toBe(2); // skipped the dead subscription, re-subscribed once
  });

  it('ignores events belonging to other sessions', async () => {
    const { client } = fakeClientFrom([]);
    const got: string[] = [];
    const stream = new OpencodeSessionStream(client, 'ses_1', (e) => {
      got.push(sessionIdOf(e)!);
      internals(stream).stopped = true; // exit once our event arrives
    }, log);

    // A peer session's event precedes ours on the shared global stream.
    await internals(stream).runLoop(streamOf(evFor('ses_2', 1), evFor('ses_1', 2)));

    expect(got).toEqual(['ses_1']); // ses_2's event was filtered out
  });
});

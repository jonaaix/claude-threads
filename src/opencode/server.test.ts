import { describe, it, expect } from 'bun:test';
import { OpencodeServerHub, sessionIdOf } from './server.js';
import type { Event } from '@opencode-ai/sdk';

// A finite async stream that yields the given events then ends.
function streamOf(...events: Event[]): AsyncIterable<Event> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
  };
}

const ev = (n: number): Event =>
  ({ type: 'x', properties: { sessionID: 'ses_1', n } } as unknown as Event);

describe('sessionIdOf', () => {
  it('reads properties.sessionID / part.sessionID / info.sessionID', () => {
    expect(sessionIdOf({ properties: { sessionID: 'a' } } as unknown as Event)).toBe('a');
    expect(sessionIdOf({ properties: { part: { sessionID: 'b' } } } as unknown as Event)).toBe('b');
    expect(sessionIdOf({ properties: { info: { sessionID: 'c' } } } as unknown as Event)).toBe('c');
    expect(sessionIdOf({ properties: {} } as unknown as Event)).toBeUndefined();
  });
});

describe('OpencodeServerHub event loop self-healing', () => {
  it('re-subscribes after the stream ends and keeps dispatching', async () => {
    const hub = new OpencodeServerHub();

    // Fake client: each re-subscribe hands back the next queued stream.
    let subscribeCalls = 0;
    const queued: AsyncIterable<Event>[] = [streamOf(ev(2))];
    const fakeClient = {
      event: {
        subscribe: async () => {
          subscribeCalls++;
          return { stream: queued.shift() ?? streamOf() };
        },
      },
    };

    const got: number[] = [];
    hub.register('ses_1', (e) => {
      got.push((e as unknown as { properties: { n: number } }).properties.n);
      // Stop after the second event so the loop exits (2nd comes from a
      // re-subscribed stream, proving the reconnect works).
      if (got.length >= 2) (hub as unknown as { stopped: boolean }).stopped = true;
    });

    // First stream ends after ev(1) → hub must re-subscribe to get ev(2).
    await (
      hub as unknown as {
        runEventLoop(c: unknown, s: AsyncIterable<Event>): Promise<void>;
      }
    ).runEventLoop(fakeClient, streamOf(ev(1)));

    expect(got).toEqual([1, 2]);
    expect(subscribeCalls).toBe(1); // reconnected (verified-live) exactly once
  });

  it('discards a dead subscription (no initial event) and re-subscribes until live', async () => {
    const hub = new OpencodeServerHub();
    let calls = 0;
    // First subscription is dead (ends immediately, no event); second is live.
    const queued: AsyncIterable<Event>[] = [streamOf(), streamOf(ev(7))];
    const fakeClient = {
      event: {
        subscribe: async () => {
          calls++;
          return { stream: queued.shift() ?? streamOf() };
        },
      },
    };
    const got: number[] = [];
    hub.register('ses_1', (e) => got.push((e as unknown as { properties: { n: number } }).properties.n));

    await (
      hub as unknown as {
        subscribeLive(c: unknown, attempts: number): Promise<AsyncIterable<Event>>;
      }
    ).subscribeLive(fakeClient, 0);

    expect(got).toEqual([7]); // the verified-live first event was dispatched
    expect(calls).toBe(2); // skipped the dead subscription, re-subscribed once
  });
});

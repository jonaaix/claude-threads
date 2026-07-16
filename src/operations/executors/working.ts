/**
 * Working Executor - owns the per-turn "working" post.
 *
 * Working content (tool calls, thinking, tool-result status) is routed here
 * instead of into the real-answer post, so the answer stays clean and the
 * working noise lives in its own post tagged `kind: 'working'`. That tag lets
 * history/delta read-back filter it out (peers see only real messages), and
 * later lets a bot hide/collapse the block entirely.
 *
 * One working post per turn: created on the first working entry, edited live as
 * more accumulate, and finalized (stop editing, keep in thread) at turn end
 * (`result`), so the next turn opens a fresh one.
 */

import type { AppendContentOp, FlushOp } from '../types.js';
import type { ExecutorContext } from './types.js';
import { BaseExecutor, type ExecutorOptions } from './base.js';

interface WorkingState {
  /** The current turn's working post being edited (null → none yet this turn). */
  postId: string | null;
  /** Accumulated working entries for this turn (newline-joined). */
  content: string;
  /** Last body written to the post — skip redundant edits. */
  lastRendered: string;
}

export class WorkingExecutor extends BaseExecutor<WorkingState> {
  constructor(options: ExecutorOptions) {
    super(options, WorkingExecutor.createInitialState());
  }

  private static createInitialState(): WorkingState {
    return { postId: null, content: '', lastRendered: '' };
  }

  protected getInitialState(): WorkingState {
    return WorkingExecutor.createInitialState();
  }

  /** Accumulate one working entry (a tool line, thinking preview, or status). */
  async executeAppend(op: AppendContentOp, _ctx: ExecutorContext): Promise<void> {
    const entry = op.content.trim();
    if (!entry) return;
    this.state.content = this.state.content ? `${this.state.content}\n${entry}` : entry;
  }

  async executeFlush(_op: FlushOp, ctx: ExecutorContext): Promise<void> {
    await this.flush(ctx);
  }

  /** Create or update the working post with the accumulated entries. */
  async flush(ctx: ExecutorContext): Promise<void> {
    if (!this.state.content.trim()) return;
    const body = this.render(ctx);
    if (body === this.state.lastRendered) return;
    try {
      if (this.state.postId) {
        await ctx.platform.updatePost(this.state.postId, body, { kind: 'working' });
      } else {
        const post = await ctx.createPost(body, { type: 'working' });
        this.state.postId = post.id;
      }
      this.state.lastRendered = body;
    } catch (err) {
      ctx.logger.warn(`working post flush failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * End the current turn's working post: stop editing it (it stays in the
   * thread) so the next turn opens a fresh one. Called at the `result` flush.
   */
  finalizeTurn(): void {
    this.state.postId = null;
    this.state.content = '';
    this.state.lastRendered = '';
  }

  /**
   * Render the working block: a header + the accumulated entries, rendered as a
   * blockquote so the whole thing visually sets itself apart from real messages
   * while markdown inside (bold/code/emoji) still renders — unlike a code fence.
   * Tail-capped (recent steps matter more than the first).
   */
  private render(ctx: ExecutorContext): string {
    const header = ctx.formatter.formatBold('🛠️ Working');
    const { maxLength } = ctx.platform.getMessageLimits();
    const marker = ctx.formatter.formatItalic('… (earlier steps omitted)');
    // Budget for the raw body; leave a margin for the header + per-line "> "
    // blockquote prefixes.
    const budget = maxLength - header.length - marker.length - 200;
    const prefix: string[] = [header];
    let body = this.state.content;
    if (budget > 0 && body.length > budget) {
      body = body.slice(body.length - budget);
      prefix.push(marker);
    }
    return [...prefix, ...body.split('\n')]
      .map(line => ctx.formatter.formatBlockquote(line))
      .join('\n');
  }
}

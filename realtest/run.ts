/**
 * realtest runner — spins up an ISOLATED claude-threads bot instance against an
 * in-process fake Mattermost and drives real-LLM scenarios. Fully self-contained:
 * no real server, no token, and it never touches your running `bun dev`.
 *
 *   bun realtest/run.ts [connect|01|02|03|all]
 *   REALTEST_MODEL=haiku bun realtest/run.ts 01     # cheaper run
 *
 *   connect   just start the harness + confirm both bots connect (no LLM cost)
 *   01 short  short-sentence conversation → history + token check
 *   02 cmds   stop / !escape / !pause, then resume → continuity + ordering
 *   03 race   rapid messages while the model generates → ordering under load
 *
 * Manual + cost-incurring (spends real LLM tokens on `REALTEST_MODEL`, default
 * sonnet). Not part of `bun test`; never runs in CI.
 */
import { startBotHarness } from './lib/bot-harness.js';
import { contextFromHarness } from './lib/context.js';
import { heading, info, warn, pass, fail } from './lib/report.js';
import { runShortConversation } from './scenarios/01-short-conversation.js';
import { runCommandsResume } from './scenarios/02-commands-resume.js';
import { runTypingRace } from './scenarios/03-typing-race.js';

const which = (process.argv[2] || 'all').toLowerCase();
const model = process.env.REALTEST_MODEL || 'sonnet';

heading('realtest — isolated fake-Mattermost harness');
info(`Starting an isolated bot instance (model=${model}) against an in-process fake Mattermost…`);

let harness;
try {
  harness = await startBotHarness({ model });
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
pass(`Two bots connected: @${harness.bots.map((b) => b.username).join(', @')}`);
info(`working dir: ${harness.workingDir}`);
info(`bot log: ${harness.logPath}`);

if (which === 'connect') {
  pass('Connect check OK — harness works end-to-end at the transport level (no LLM spent).');
  await harness.stop();
  process.exit(0);
}

const ctx = contextFromHarness(harness);
let failed = false;
try {
  if (which === '01' || which === 'short' || which === 'all') await runShortConversation(ctx);
  if (which === '02' || which === 'commands' || which === 'all') await runCommandsResume(ctx);
  if (which === '03' || which === 'race' || which === 'all') await runTypingRace(ctx);
  if (!['01', 'short', '02', 'commands', '03', 'race', 'all'].includes(which)) {
    heading('Usage');
    info('bun realtest/run.ts [connect|01|02|03|all]');
  }
} catch (err) {
  failed = true;
  warn(`Scenario aborted: ${err instanceof Error ? err.stack || err.message : String(err)}`);
} finally {
  await harness.stop();
}

heading('Done');
info('Review the timeline + per-bot history/token report above.');
process.exit(failed ? 1 : 0);

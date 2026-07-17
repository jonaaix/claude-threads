/**
 * Write-scope policy for opencode permission requests.
 *
 * With `writeScope: 'workingDir'` an opencode-backed bot may only WRITE inside
 * its own working directory (plus the OS temp dir). The bridge — which is the
 * component answering opencode's permission requests — evaluates each request
 * against that scope instead of blanket-approving it:
 *
 *  - edit/write-style requests: every absolute path mentioned in the request
 *    must be inside the scope; a write request with no recognizable path is
 *    REJECTED (fail closed — we can't tell what it would touch).
 *  - bash requests: checked heuristically — any absolute path token or `..`
 *    path segment in the command must stay inside the scope. Commands without
 *    such tokens are allowed (relative paths resolve against the session's
 *    working directory). URLs (`http://…/path`) don't count as paths.
 *  - anything else (webfetch etc.): allowed — reads are not gated.
 *
 * This is a GUARDRAIL against an overeager model drifting into a peer bot's
 * project, not a security boundary — a genuinely adversarial model can smuggle
 * paths past a string heuristic. Hard isolation needs OS/container boundaries.
 *
 * Prerequisite: opencode only emits permission requests for tools its own
 * config marks `"ask"`. Operators put `{ "permission": { "edit": "ask",
 * "bash": "ask" } }` in an `opencode.json` inside the bot's working directory.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, resolve, sep } from 'path';

/** The permission-request fields the policy inspects (subset of SDK Permission). */
export interface PermissionLike {
  type: string;
  title?: string;
  pattern?: string | Array<string>;
  metadata?: Record<string, unknown>;
}

/** Permission types treated as writes (path containment required). */
const WRITE_TYPES = new Set(['edit', 'write', 'patch', 'multiedit']);

/** True if `candidate` is `dir` itself or inside it. Paths are resolved first. */
export function isInsideDir(candidate: string, dir: string): boolean {
  const c = resolve(candidate);
  const d = resolve(dir);
  return c === d || c.startsWith(d + sep);
}

/**
 * Absolute-path tokens in a free-form string (command line, title). A token
 * counts only when its `/` starts the string or follows a clear delimiter
 * (whitespace, quotes, `=`, `(`) — so URL slashes (`http://…`) don't match.
 */
export function extractAbsolutePaths(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s"'`=(])(\/[^\s"'`)]*)/g;
  for (const m of text.matchAll(re)) {
    if (m[1].length > 1) out.push(m[1]);
  }
  return out;
}

/** Every string value reachable in the metadata object (one level of nesting). */
function metadataStrings(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) return [];
  const out: string[] = [];
  for (const value of Object.values(metadata)) {
    if (typeof value === 'string') out.push(value);
    else if (value && typeof value === 'object') {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        if (typeof nested === 'string') out.push(nested);
      }
    }
  }
  return out;
}

/**
 * Decide a permission request against the scope. `scopeDirs` is the list of
 * directories the bot may write in (its workingDir + tmp); an empty list means
 * nothing is writable.
 */
export function evaluateWriteScope(
  permission: PermissionLike,
  scopeDirs: string[],
): 'allow' | 'reject' {
  const type = permission.type.toLowerCase();
  const isWrite = WRITE_TYPES.has(type);
  const isBash = type === 'bash' || type === 'shell';
  if (!isWrite && !isBash) return 'allow'; // reads/fetches are not gated

  // Candidate strings that may carry the target path(s). opencode puts the
  // file path in the metadata (shape varies by tool/version); title and
  // pattern carry it for bash-style requests.
  const texts = [
    ...(typeof permission.title === 'string' ? [permission.title] : []),
    ...(Array.isArray(permission.pattern) ? permission.pattern : permission.pattern ? [permission.pattern] : []),
    ...metadataStrings(permission.metadata),
  ];

  // Direct absolute-path candidates: metadata strings that ARE a path, plus
  // path tokens embedded in the free-form texts.
  const paths: string[] = [];
  for (const text of texts) {
    if (text.startsWith('/')) paths.push(text);
    paths.push(...extractAbsolutePaths(text));
  }

  const inScope = (p: string): boolean => scopeDirs.some((dir) => isInsideDir(p, dir));

  if (isBash) {
    // `..` segments can walk out of the (in-scope) cwd — reject conservatively.
    if (texts.some((text) => /(^|[\s"'`=(/])\.\.(\/|["'\s`)]|$)/.test(text))) return 'reject';
    return paths.every(inScope) ? 'allow' : 'reject';
  }

  // Write request: must name at least one path, and every path must be in scope.
  if (paths.length === 0) return 'reject';
  return paths.every(inScope) ? 'allow' : 'reject';
}

/**
 * Ensure the working directory's `opencode.json` marks edit/bash permissions
 * `"ask"`, so opencode actually emits permission requests for the bridge to
 * evaluate — without it a write scope silently has no effect. Non-destructive:
 * only missing keys are added; existing values (and all other config) are left
 * alone. A running opencode server picks the project config up on the next
 * session (verified live). Best-effort: returns what happened for logging.
 */
export function ensureAskPermissionConfig(
  workingDir: string,
): 'created' | 'updated' | 'ok' | 'failed' {
  const file = join(workingDir, 'opencode.json');
  try {
    let config: Record<string, unknown>;
    let exists = true;
    try {
      config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'failed'; // unreadable/invalid → don't clobber
      exists = false;
      config = {};
    }
    const permission = (config.permission ?? {}) as Record<string, unknown>;
    let changed = false;
    for (const key of ['edit', 'bash'] as const) {
      if (permission[key] === undefined) {
        permission[key] = 'ask';
        changed = true;
      }
    }
    if (!changed) return 'ok';
    config.permission = permission;
    writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8');
    return exists ? 'updated' : 'created';
  } catch {
    return 'failed';
  }
}

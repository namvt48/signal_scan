// Zero-dep structured logger (user 2026-09-24): one line per event, level-gated
// so the default stays quiet, plus de-duplication so a systemic failure (one bad
// API key → 86 identical per-CA errors per sweep) is ONE line, not 86.
//
// API deliberately mirrors `console` (variadic args) so migrating a call site is
// `console.x` → `log.x` with no message rewrite. Extra args are rendered: a plain
// object becomes `k=v` pairs, an Error becomes `Name:message`, anything else is
// stringified. Output is `text key=value` on stdout/stderr (docker json-file),
// greppable with `docker logs | grep` — see LOG_LEVEL / LOG_CALL_MS in config.ts.

import { config } from './config.js';

export type Level = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVELS: readonly Level[] = ['debug', 'info', 'warn', 'error'];

export function parseLevel(raw: string): Level {
  return (LEVELS as readonly string[]).includes(raw) ? (raw as Level) : 'info';
}

/** One value → a log token. Errors keep name+message only (never their stack, and
 *  never a URL — a thrown fetch echoes the token-bearing endpoint in its message,
 *  which is why solana.ts wraps those in SafeRpcError). */
function render(v: unknown): string {
  if (v instanceof Error) return `${v.name}:${v.message}`.replace(/\s+/g, ' ').slice(0, 200);
  if (v === null) return 'null';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v).slice(0, 300);
    } catch {
      return '[obj]';
    }
  }
  return String(v);
}

/** A plain object (not Error/null/array) spreads into `k=v` pairs. */
function isFields(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Error);
}

function format(level: Level, args: unknown[]): string {
  const head = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)}`;
  if (args.length === 0) return head;
  const [first, ...rest] = args;
  const parts: string[] = [typeof first === 'string' ? first : render(first)];
  for (const a of rest) {
    if (isFields(a)) {
      for (const [k, val] of Object.entries(a)) parts.push(`${k}=${render(val)}`);
    } else {
      parts.push(render(a));
    }
  }
  return `${head} ${parts.join(' ')}`;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface LoggerOptions {
  level: Level;
  /** Repeat-window (ms) for identical warn/error lines; info/debug always pass. 0 = log every occurrence. */
  dedupeMs?: number;
  /** Test seam: receive the formatted line. Default writes stdout (debug/info) / stderr (warn/error). */
  sink?: (line: string, level: Level) => void;
  /** Test seam for the dedupe window. Default Date.now. */
  now?: () => number;
}

/**
 * Dedupe key = level + first string arg + the FIRST Error's `name:message`. The
 * per-call args (a CA address, a status) are deliberately NOT in the key: that is
 * what collapses a per-CA error storm into one line while still letting genuinely
 * different failures (different message/error) through. Because the key ignores
 * structured fields, dedupe applies to warn/error ONLY — an info line is a real
 * event (a request, a sweep) and its fields are the payload, so collapsing it
 * would hide the very thing it reports.
 */
function dedupeKey(level: Level, args: unknown[]): string {
  const first = typeof args[0] === 'string' ? args[0] : render(args[0]);
  const err = args.find((a): a is Error => a instanceof Error);
  return `${level}|${first}|${err ? `${err.name}:${err.message}` : ''}`.slice(0, 240);
}

export function createLogger(opts: LoggerOptions): Logger {
  const sink =
    opts.sink ??
    ((line: string, level: Level): void => {
      (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
    });
  const dedupeMs = opts.dedupeMs ?? 0;
  const now = opts.now ?? Date.now;
  const seen = new Map<string, { at: number; n: number }>();

  const emit = (level: Level, args: unknown[]): void => {
    if (RANK[level] < RANK[opts.level]) return;
    if (dedupeMs <= 0 || (level !== 'warn' && level !== 'error')) {
      sink(format(level, args), level);
      return;
    }
    const key = dedupeKey(level, args);
    const ts = now();
    const prev = seen.get(key);
    if (prev && ts - prev.at < dedupeMs) {
      prev.n += 1;
      return;
    }
    const suppressed = prev?.n ?? 0;
    seen.set(key, { at: ts, n: 0 });
    const suffix = suppressed > 0 ? ` (x${suppressed + 1} in ${Math.round(dedupeMs / 1000)}s)` : '';
    sink(format(level, args) + suffix, level);
  };

  return {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
  };
}

/** Process-wide logger bound to config. Tests build their own via createLogger. */
export const log: Logger = createLogger({
  level: parseLevel(config.logLevel),
  dedupeMs: config.logDedupeMs,
});

/**
 * Time one outbound call. Logged at `debug` normally, or at `info` when the call
 * is slower than LOG_CALL_MS (>0) — that knob surfaces ONLY the slow queries, so
 * "which call do I optimize" needs no per-call spam. On throw it logs a warn with
 * the duration (the caller's own catch decides the user-visible message) and
 * rethrows unchanged.
 */
export async function timed<T>(
  label: string,
  fields: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  try {
    const out = await fn();
    const dur = Date.now() - t0;
    const level: Level = config.logCallMs > 0 && dur >= config.logCallMs ? 'info' : 'debug';
    log[level](label, { ...fields, dur });
    return out;
  } catch (e) {
    const dur = Date.now() - t0;
    log.warn(label, { ...fields, dur, err: e });
    throw e;
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, parseLevel, type Level } from '../src/log.js';

function capture(opts: { level: Level; dedupeMs?: number; now?: () => number }) {
  const lines: Array<{ line: string; level: Level }> = [];
  const log = createLogger({ ...opts, sink: (line, level) => lines.push({ line, level }) });
  return { log, lines };
}

test('parseLevel: known level passes, unknown falls back to info', () => {
  assert.equal(parseLevel('debug'), 'debug');
  assert.equal(parseLevel('warn'), 'warn');
  assert.equal(parseLevel('nonsense'), 'info');
});

test('level gate: debug hidden at info, kept at debug', () => {
  const atInfo = capture({ level: 'info' });
  atInfo.log.debug('hidden');
  atInfo.log.info('shown');
  assert.equal(atInfo.lines.length, 1);
  assert.match(atInfo.lines[0].line, / INFO  shown$/);

  const atDebug = capture({ level: 'debug' });
  atDebug.log.debug('shown');
  assert.equal(atDebug.lines.length, 1);
});

test('fields render as k=v; Error renders as Name:message', () => {
  const { log, lines } = capture({ level: 'info' });
  log.info('[api]', { method: 'GET', path: '/api/signals', status: 200, dur: 12 });
  log.error('[poller]', new Error('boom'));
  assert.match(lines[0].line, /\[api\] method=GET path=\/api\/signals status=200 dur=12$/);
  assert.match(lines[1].line, /\[poller\] Error:boom$/);
});

test('dedupe: repeated identical error collapses to one line, then tallies', () => {
  let t = 1_000;
  const { log, lines } = capture({ level: 'warn', dedupeMs: 60_000, now: () => t });
  for (let i = 0; i < 5; i += 1) log.warn('[poller] gini', new Error('429'));
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0].line, /\(x\d/);
  t += 61_000;
  log.warn('[poller] gini', new Error('429'));
  assert.equal(lines.length, 2);
  assert.match(lines[1].line, /\(x5 in 60s\)$/);
});

test('dedupe never collapses distinct errors', () => {
  const { log, lines } = capture({ level: 'error', dedupeMs: 60_000 });
  log.error('[poller] a', new Error('429'));
  log.error('[poller] b', new Error('500'));
  assert.equal(lines.length, 2);
});

test('info lines are never deduped (their fields are the payload)', () => {
  const { log, lines } = capture({ level: 'info', dedupeMs: 60_000 });
  log.info('[api]', { path: '/api/signals', dur: 3 });
  log.info('[api]', { path: '/api/signals', dur: 4 });
  log.info('[api]', { path: '/api/settings', dur: 2 });
  assert.equal(lines.length, 3);
});

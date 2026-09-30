// Smoke test for the gateway entrypoint (plan request-plane-gateway, todo 1).
// Placeholder on purpose: todo 2+ add the real HTTP/auth/contract specs. Its job
// now is to prove `npm test` actually GLOBS test/gateway/*.test.ts (before todo 1
// the script only globbed test/*.test.ts + test/ratelimit/*.test.ts, so a spec
// here would have been silently skipped — a false green).
//
// It exercises the one piece of real logic todo 1 ships: fail-loud GATEWAY_PORT
// parsing. Importing main.ts must NOT bind a port (the direct-execution guard).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GATEWAY_PORT, parsePort } from '../../src/gateway/main.js';

test('gateway smoke: GATEWAY_PORT parses, defaults and fails loud', () => {
  assert.equal(parsePort('8130'), 8130);
  assert.equal(parsePort(undefined), DEFAULT_GATEWAY_PORT);
  assert.equal(parsePort(''), DEFAULT_GATEWAY_PORT);
  // Fail loud: a bad env is an error, never a silent fallback to the default.
  assert.throws(() => parsePort('not-a-port'), /GATEWAY_PORT/);
  assert.throws(() => parsePort('0'), /GATEWAY_PORT/);
  assert.throws(() => parsePort('70000'), /GATEWAY_PORT/);
  assert.throws(() => parsePort('8080.5'), /GATEWAY_PORT/);
});

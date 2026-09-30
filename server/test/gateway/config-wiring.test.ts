// Todo 14 — GATEWAY_URL / GATEWAY_CALLER_TOKEN config + provider wiring.
//
// Pins the selection predicate: the gateway-backed client is built IFF
// `GATEWAY_URL` is non-empty, REGARDLESS of NANSEN_API_KEY / GMGN_API_KEY (the
// gateway injects the real key). With `GATEWAY_URL` unset the gateway client is
// null and the legacy key-gated path applies. There is NO loopback default on
// the TS side.
//
// Two layers: (1) the real providers driven against the config-built gateway
// client with a stubbed fetch prove base URL + caller token reach the wire;
// (2) the REAL api entrypoint spawned as a child proves the construction gate
// (the `gateway=`/`nansenApi=` fields of the `[index] listening` line).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { GatewayClient } from '../../src/gateway-client.js';
import { NansenApiClient } from '../../src/providers/nansen.js';
import { GmgnMarketProvider } from '../../src/providers/gmgn.js';

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TSX = resolve(SERVER_DIR, 'node_modules/.bin/tsx');

interface ConfigModule {
  config: { gatewayUrl: string; gatewayCallerToken: string };
  gatewayClientFromConfig: () => GatewayClient | null;
}

/** Every env var these tests touch; cleared before each fresh config import. */
const TOUCHED = ['GATEWAY_URL', 'GATEWAY_CALLER_TOKEN', 'NANSEN_API_KEY', 'GMGN_API_KEY'] as const;

async function withFreshConfig<T>(
  tag: string,
  vars: Partial<Record<(typeof TOUCHED)[number], string>>,
  fn: (mod: ConfigModule) => T | Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of TOUCHED) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    const mod = (await import(`../../src/config.js?case=${tag}`)) as ConfigModule;
    return await fn(mod);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('todo14: providers route to the configured gateway base URL + caller token', async () => {
  await withFreshConfig(
    'wiring-route',
    { GATEWAY_URL: 'http://gateway:8130', GATEWAY_CALLER_TOKEN: 'api-caller-token' },
    async (mod) => {
      assert.equal(mod.config.gatewayUrl, 'http://gateway:8130');
      assert.equal(mod.config.gatewayCallerToken, 'api-caller-token');
      const client = mod.gatewayClientFromConfig();
      if (client === null) assert.fail('gateway client must be built when GATEWAY_URL is set');

      const seen: { url: string; auth: string | null }[] = [];
      const prevFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
        return new Response(JSON.stringify({ status: 200, body: JSON.stringify({ data: {} }), headers: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;
      try {
        const nansen = new NansenApiClient('', client);
        await nansen.tokenInformation('sol', 'CA1111111111111111111111111111111111111111111');
        const gmgn = new GmgnMarketProvider('', client);
        await gmgn.metric('CA1111111111111111111111111111111111111111111', 'sol', 'essential');
      } finally {
        globalThis.fetch = prevFetch;
      }

      assert.deepEqual(
        seen.map((s) => s.url),
        ['http://gateway:8130/v1/nansen/credit', 'http://gateway:8130/v1/gmgn/token-info'],
      );
      assert.ok(
        seen.every((s) => s.auth === 'Bearer api-caller-token'),
        `caller token missing: ${JSON.stringify(seen)}`,
      );
    },
  );
});

test('todo14: GATEWAY_URL unset builds NO gateway client (empty, no loopback default)', async () => {
  await withFreshConfig('wiring-unset', {}, (mod) => {
    assert.equal(mod.config.gatewayUrl, '');
    assert.equal(mod.config.gatewayCallerToken, '');
    assert.equal(mod.gatewayClientFromConfig(), null);
  });
});

/** Spawn a long-running entrypoint and resolve once `needle` shows in stdout. */
function waitForLine(
  args: string[],
  env: NodeJS.ProcessEnv,
  needle: RegExp,
  timeoutMs: number,
): Promise<{ matched: boolean; out: string; err: string }> {
  return new Promise((finish) => {
    const child = spawn(TSX, args, { cwd: SERVER_DIR, env, detached: true });
    let out = '';
    let err = '';
    let settled = false;
    const done = (matched: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // tsx runs the entrypoint in a CHILD process; kill the whole group or the
      // orphaned server keeps its pipe open and the test runner never exits.
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ matched, out, err });
    };
    const timer = setTimeout(() => done(needle.test(out)), timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (needle.test(out)) done(true);
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('close', () => done(needle.test(out)));
    child.on('error', () => done(false));
  });
}

/** Boot the real api entrypoint on `port` with a clean gateway/key env. */
async function bootApi(
  port: string,
  vars: Record<string, string>,
): Promise<{ matched: boolean; out: string; err: string }> {
  const stamp = `${process.pid}-${Date.now()}-${port}`;
  const dbPath = resolve(tmpdir(), `ss-wire-${stamp}.db`);
  const cachePath = resolve(tmpdir(), `ss-wire-${stamp}.cache.json`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MODE: 'mock',
    NANSEN_CRAWL: 'off',
    DB_PATH: dbPath,
    SETUP_CACHE_FILE: cachePath,
    PORT: port,
  };
  for (const key of [...TOUCHED, 'GATEWAY_TOKEN_A', 'GATEWAY_TOKEN_B', 'GATEWAY_TOKEN_WATCHER']) delete env[key];
  for (const [key, value] of Object.entries(vars)) env[key] = value;
  try {
    return await waitForLine(['src/index.ts'], env, new RegExp(`\\[index\\] listening on :${port}`), 30_000);
  } finally {
    rmSync(dbPath, { force: true });
    rmSync(cachePath, { force: true });
  }
}

test('todo14: GATEWAY_URL set + NO keys still constructs nansen + gmgn (routes to gateway)', async () => {
  const r = await bootApi('39321', { GATEWAY_URL: 'http://gateway:8130', GATEWAY_CALLER_TOKEN: 'api-caller-token' });
  assert.equal(r.matched, true, `api did not boot; stderr=${r.err}`);
  assert.match(r.out, /nansenApi=on/);
  assert.match(r.out, /gmgnApi=on/);
  assert.match(r.out, /gateway=on/);
});

test('todo14: GATEWAY_URL unset + NO key leaves the credit client null (legacy path)', async () => {
  const r = await bootApi('39322', {});
  assert.equal(r.matched, true, `api did not boot; stderr=${r.err}`);
  assert.match(r.out, /nansenApi=off/);
  assert.match(r.out, /gateway=off/);
});

test('todo14: GATEWAY_URL unset + key builds the legacy key-gated client (gateway off)', async () => {
  const r = await bootApi('39323', { NANSEN_API_KEY: 'legacy-key' });
  assert.equal(r.matched, true, `api did not boot; stderr=${r.err}`);
  assert.match(r.out, /nansenApi=on/);
  assert.match(r.out, /gateway=off/);
});

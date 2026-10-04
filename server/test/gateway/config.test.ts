// Gateway config surface + fail-loud boot (plan request-plane-gateway, todo 6).
//
// config.ts is a module-scope singleton, so the override cases import it through
// a cache-busting query (each unique URL re-evaluates with the env set at that
// moment). The two boot cases run the REAL entrypoints as child processes: the
// gateway must abort non-zero without caller tokens, while the api process must
// still boot with only its own caller token (proving no module-scope throw in the
// shared config.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildSpecs } from '../../src/ratelimit/spec.js';
import { missingGatewayEnv } from '../../src/gateway/main.js';

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TSX = resolve(SERVER_DIR, 'node_modules/.bin/tsx');

/** Every env var these tests touch; reset before each fresh config import. */
const TOUCHED = [
  'GATEWAY_PORT',
  'GATEWAY_TOKEN_A',
  'GATEWAY_TOKEN_B',
  'GATEWAY_TOKEN_WATCHER',
  'NANSEN_API_KEY',
  'GMGN_API_KEY',
  'GMGN_API_KEYS',
  'GMGN_PLAN_WEIGHT',
  'GMGN_PLAN_WEIGHTS',
  'NANSEN_DAILY_CREDIT_BUDGET',
  'CACHE_TTL_NANSEN_MS',
  'CACHE_TTL_DEXSCREENER_MS',
  'CRAWL_WS_ENDPOINT',
  'CRAWL_PROXY_FILE',
  'RL_DEXSCREENER_MAX',
] as const;

async function withFreshConfig<T>(
  tag: string,
  vars: Partial<Record<(typeof TOUCHED)[number], string>>,
  fn: (config: Record<string, unknown>) => T,
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
    const mod = await import(`../../src/config.js?case=${tag}`);
    return fn(mod.config as Record<string, unknown>);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

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

test('gateway config: defaults when env is unset', async () => {
  await withFreshConfig('defaults', {}, (c) => {
    assert.equal(c.gatewayPort, 8130);
    assert.equal(c.gatewayTokenA, '');
    assert.equal(c.gatewayTokenB, '');
    assert.equal(c.gatewayTokenWatcher, '');
    assert.equal(c.nansenApiKey, '');
    assert.equal(c.gmgnApiKey, '');
    assert.deepEqual(c.gmgnApiKeys, []);
    assert.equal(c.gmgnPlanWeight, 5);
    assert.deepEqual(c.gmgnPlanWeights, []);
    assert.equal(c.nansenDailyCreditBudget, 10);
    assert.equal(c.cacheTtlNansenMs, 30_000);
    assert.equal(c.cacheTtlDexscreenerMs, 30_000);
    assert.equal(c.crawlWsEndpoint, 'ws://chrome:3000');
    assert.equal(c.crawlProxyFile, '');
  });
});

test('gateway config: env overrides win', async () => {
  await withFreshConfig(
    'overrides',
    {
      GATEWAY_PORT: '9999',
      GATEWAY_TOKEN_A: 'token-a',
      GATEWAY_TOKEN_B: 'token-b',
      GATEWAY_TOKEN_WATCHER: 'token-w',
      NANSEN_API_KEY: 'nansen-key',
      GMGN_API_KEY: 'gmgn-key',
      GMGN_API_KEYS: 'k1,k2',
      GMGN_PLAN_WEIGHT: '20',
      GMGN_PLAN_WEIGHTS: '5,20',
      NANSEN_DAILY_CREDIT_BUDGET: '1234',
      CACHE_TTL_NANSEN_MS: '1500',
      CACHE_TTL_DEXSCREENER_MS: '2500',
      CRAWL_WS_ENDPOINT: 'ws://gateway-chrome:3000',
      CRAWL_PROXY_FILE: '/data/proxies.txt',
    },
    (c) => {
      assert.equal(c.gatewayPort, 9999);
      assert.equal(c.gatewayTokenA, 'token-a');
      assert.equal(c.gatewayTokenB, 'token-b');
      assert.equal(c.gatewayTokenWatcher, 'token-w');
      assert.equal(c.nansenApiKey, 'nansen-key');
      assert.equal(c.gmgnApiKey, 'gmgn-key');
      assert.deepEqual(c.gmgnApiKeys, ['k1', 'k2']);
      assert.equal(c.gmgnPlanWeight, 20);
      assert.deepEqual(c.gmgnPlanWeights, [5, 20]);
      assert.equal(c.nansenDailyCreditBudget, 1234);
      assert.equal(c.cacheTtlNansenMs, 1500);
      assert.equal(c.cacheTtlDexscreenerMs, 2500);
      assert.equal(c.crawlWsEndpoint, 'ws://gateway-chrome:3000');
      assert.equal(c.crawlProxyFile, '/data/proxies.txt');
    },
  );
});

test('GMGN_PLAN_WEIGHT and RL_* reach buildSpecs', async () => {
  await withFreshConfig('specs', { GMGN_PLAN_WEIGHT: '20', RL_DEXSCREENER_MAX: '321' }, (c) => {
    const s = buildSpecs(Number(c.gmgnPlanWeight));
    assert.equal(s.gmgn.weightBucket?.capacity, 20);
    assert.equal(s.dexscreener.window?.max, 321);
  });
});

test('missingGatewayEnv lists blank required keys, never values', () => {
  assert.deepEqual(
    missingGatewayEnv({
      nansenApiKey: '',
      gmgnApiKey: '',
      gmgnApiKeys: [],
      gatewayTokenA: '',
      gatewayTokenB: '',
      gatewayTokenWatcher: '',
    }),
    ['nansenApiKey', 'gmgnApiKey', 'gatewayTokenA', 'gatewayTokenB', 'gatewayTokenWatcher'],
  );
  assert.deepEqual(
    missingGatewayEnv({
      nansenApiKey: 'n',
      gmgnApiKey: 'g',
      gmgnApiKeys: ['g'],
      gatewayTokenA: 'a',
      gatewayTokenB: 'b',
      gatewayTokenWatcher: 'w',
    }),
    [],
  );
  assert.deepEqual(
    missingGatewayEnv({
      nansenApiKey: 'n',
      gmgnApiKey: '',
      gmgnApiKeys: ['g'],
      gatewayTokenA: '',
      gatewayTokenB: 'b',
      gatewayTokenWatcher: 'w',
    }),
    ['gatewayTokenA'],
  );
  assert.deepEqual(
    missingGatewayEnv({
      nansenApiKey: 'n',
      gmgnApiKey: '',
      gmgnApiKeys: [],
      gatewayTokenA: '',
      gatewayTokenB: 'b',
      gatewayTokenWatcher: 'w',
    }),
    ['gmgnApiKey', 'gatewayTokenA'],
  );
});

test('gateway entrypoint exits 1 without caller tokens (fail loud, no secrets in log)', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, NANSEN_API_KEY: 'secret-nansen', GMGN_API_KEY: 'secret-gmgn' };
  delete env.GATEWAY_TOKEN_A;
  delete env.GATEWAY_TOKEN_B;
  delete env.GATEWAY_TOKEN_WATCHER;

  const r = spawnSync(TSX, ['src/gateway/main.ts'], {
    cwd: SERVER_DIR,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });

  assert.equal(r.status, 1, `expected exit 1, got status=${r.status} stderr=${r.stderr}`);
  assert.match(r.stderr, /missing required env/);
  assert.match(r.stderr, /gatewayTokenA/);
  assert.match(r.stderr, /gatewayTokenWatcher/);
  assert.doesNotMatch(r.stderr, /secret-nansen|secret-gmgn/);
});

test('api process boots with only its own caller token (no module-scope throw)', async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const dbPath = resolve(tmpdir(), `ss-cfg-test-${stamp}.db`);
  const cachePath = resolve(tmpdir(), `ss-cfg-test-${stamp}.cache.json`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MODE: 'mock',
    NANSEN_CRAWL: 'off',
    DB_PATH: dbPath,
    SETUP_CACHE_FILE: cachePath,
    PORT: '39311',
    GATEWAY_CALLER_TOKEN: 'api-caller-token',
  };
  delete env.GATEWAY_TOKEN_A;
  delete env.GATEWAY_TOKEN_B;
  delete env.GATEWAY_TOKEN_WATCHER;
  delete env.NANSEN_API_KEY;
  delete env.GMGN_API_KEY;

  try {
    const r = await waitForLine(['src/index.ts'], env, /\[index\] listening on :39311/, 30_000);
    assert.equal(r.matched, true, `api did not boot; stderr=${r.err} stdout=${r.out}`);
    assert.doesNotMatch(r.err, /missing required env/);
  } finally {
    rmSync(dbPath, { force: true });
    rmSync(cachePath, { force: true });
  }
});

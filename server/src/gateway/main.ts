// Gateway process entrypoint (plan request-plane-gateway, todos 1 + 2).
//
// An HTTP listener bound to GATEWAY_PORT running the gateway app (per-caller
// bearer auth, public /health, token-gated /metrics). Fail-loud on missing
// required env BEFORE any listener binds. No business logic, no DB, no upstream
// calls here.

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { config, DEFAULT_GATEWAY_PORT } from '../config.js';
import { log } from '../log.js';
import { createGatewayApp } from './app.js';

export { DEFAULT_GATEWAY_PORT };

/**
 * The gateway's required config surface. `config.ts` parses these with safe
 * defaults and never throws; THIS entrypoint decides what is mandatory. Fields
 * are the parsed config keys so the check cannot drift from config.ts.
 */
export interface GatewayEnv {
  nansenApiKey: string;
  gmgnApiKey: string;
  gmgnApiKeys: readonly string[];
  gatewayTokenA: string;
  gatewayTokenB: string;
  gatewayTokenWatcher: string;
}

const REQUIRED_GATEWAY_ENV: readonly (keyof GatewayEnv)[] = [
  'nansenApiKey',
  'gmgnApiKey',
  'gatewayTokenA',
  'gatewayTokenB',
  'gatewayTokenWatcher',
];

/** Names (never values) of the required keys that are blank. `gmgnApiKey` is a
 *  GROUP: satisfied by either `gmgnApiKeys` (preferred, multi-account) or the single
 *  `gmgnApiKey`. Empty = ready. */
export function missingGatewayEnv(env: GatewayEnv): string[] {
  return REQUIRED_GATEWAY_ENV.filter((key) =>
    key === 'gmgnApiKey'
      ? env.gmgnApiKeys.length === 0 && env.gmgnApiKey === ''
      : env[key] === '',
  );
}

/**
 * `GATEWAY_PORT` env → port number. Missing/blank → default. A non-integer or
 * out-of-range value THROWS instead of silently binding another port: a bad env
 * must fail the boot loudly (todo 1 acceptance: exit != 0 + error log).
 */
export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_GATEWAY_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`GATEWAY_PORT="${raw}" is not a valid port (integer 1-65535)`);
  }
  return n;
}

function main(): void {
  const missing = missingGatewayEnv(config);
  if (missing.length > 0) {
    log.error(`[gateway] missing required env: ${missing.join(', ')}`);
    process.exit(1);
  }

  let port: number;
  try {
    port = parsePort(process.env.GATEWAY_PORT);
  } catch (e) {
    log.error('[gateway] bad config', e);
    process.exit(1);
  }

  const server = createServer(createGatewayApp());

  server.listen(port, () => {
    log.info(`[gateway] listening on :${port}`);
  });

  const shutdown = (signal: string): void => {
    log.info(`[gateway] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Only boot when executed directly (node dist/gateway/main.js /
// tsx src/gateway/main.ts) — importing parsePort in a test must NOT bind a port.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

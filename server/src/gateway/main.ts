// Gateway process entrypoint (plan request-plane-gateway, todo 1).
//
// Bootable skeleton ONLY: an HTTP listener bound to GATEWAY_PORT plus a
// fail-loud port parse. The real routes, per-caller bearer auth, /health and the
// limiters land in todo 2+. No business logic, no DB, no upstream calls here.

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { log } from '../log.js';

/** Gateway default port (plan pins 8130; env-configurable in todo 6). */
export const DEFAULT_GATEWAY_PORT = 8130;

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
  let port: number;
  try {
    port = parsePort(process.env.GATEWAY_PORT);
  } catch (e) {
    log.error('[gateway] bad config', e);
    process.exit(1);
  }

  const server = createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not_found"}');
  });

  server.listen(port, () => {
    log.info(`[gateway] listening on :${port} (request-plane skeleton)`);
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

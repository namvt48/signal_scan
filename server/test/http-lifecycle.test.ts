import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { installGracefulShutdown } from '../src/http-lifecycle.js';

test('graceful shutdown stops accepting sockets and drains an active request', async () => {
  let finishRequest!: () => void;
  const requestGate = new Promise<void>((resolve) => { finishRequest = resolve; });
  let draining = false;
  const server = createServer(async (_request, response) => {
    await requestGate;
    response.end('finished');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const lifecycle = installGracefulShutdown(server, {
    drainTimeoutMs: 1_000,
    onDrain: () => { draining = true; },
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const response = fetch(url);
  await once(server, 'connection');

  const shutdown = lifecycle.shutdown();
  assert.equal(lifecycle.isDraining(), true);
  assert.equal(draining, true);
  let shutdownComplete = false;
  void shutdown.then(() => { shutdownComplete = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(shutdownComplete, false, 'shutdown waits for the active request');

  finishRequest();
  assert.equal(await (await response).text(), 'finished');
  await shutdown;
});

test('graceful shutdown terminates a stuck request at its deadline', async () => {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const lifecycle = installGracefulShutdown(server, { drainTimeoutMs: 25 });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const response = fetch(url);
  await once(server, 'connection');

  await lifecycle.shutdown();
  await assert.rejects(response);
  assert.equal(lifecycle.isDraining(), true);
});

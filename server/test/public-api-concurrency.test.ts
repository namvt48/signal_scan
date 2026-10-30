import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once, setMaxListeners } from 'node:events';
import { createServer, get, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicApiApp } from '../src/public-api.js';

interface Result { status?: number; body?: string; error?: NodeJS.ErrnoException }

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function fixture(t: TestContext) {
  const arrivals = new EventEmitter();
  const closures = new EventEmitter();
  setMaxListeners(0, arrivals, closures);
  const upstream = createServer((req, res) => {
    const offset = new URL(req.url!, 'http://localhost').searchParams.get('afterId');
    arrivals.emit(offset!, res);
  });
  const upstreamUrl = await listen(upstream);
  const service = createServer(createPublicApiApp({ internalUrl: upstreamUrl, internalToken: randomUUID() }));
  service.on('request', (req, res) => {
    const offset = new URL(req.url!, 'http://localhost').searchParams.get('offset');
    res.once('close', () => closures.emit(offset!));
  });
  const url = await listen(service);
  t.after(async () => {
    service.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([service, upstream].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });
  function request(offset: number) {
    const accepted = once(arrivals, String(offset)) as Promise<[ServerResponse]>;
    const closed = once(closures, String(offset));
    const client = get(`${url}/api/v1/tokens?limit=1&offset=${offset}`, { agent: false });
    const completed = new Promise<Result>((resolve) => {
      client.once('error', (error: NodeJS.ErrnoException) => resolve({ error }));
      client.once('response', (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.once('end', () => resolve({ status: response.statusCode, body }));
        response.once('error', (error: NodeJS.ErrnoException) => resolve({ error }));
      });
    });
    return { client, accepted, closed, completed };
  }
  return { url, request };
}

function respond(response: ServerResponse): void {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ generatedAt: 123, data: [], nextOffset: null }));
}

test('client disconnects release REST slots even before upstream responses finish', { timeout: 10_000 }, async (t) => {
  const service = await fixture(t);
  for (let offset = 0; offset < 24; offset++) {
    const call = service.request(offset);
    const [response] = await call.accepted;
    call.client.destroy();
    await call.closed;
    assert.equal((await call.completed).error?.code, 'ECONNRESET');
    respond(response);
  }
  const status = await fetch(`${service.url}/api/v1/status`);
  assert.equal(status.status, 200, 'disconnected clients must not permanently exhaust REST slots');
  assert.deepEqual(await status.json(), { status: 'ok', version: 'v1' });
});

test('finished responses release once and live requests still enforce the concurrency cap', { timeout: 10_000 }, async (t) => {
  const service = await fixture(t);
  for (let offset = 0; offset < 24; offset++) {
    const call = service.request(offset);
    const [response] = await call.accepted;
    respond(response);
    assert.equal((await call.completed).status, 200);
    await call.closed;
  }
  const pending = [];
  for (let offset = 24; offset < 48; offset++) {
    const call = service.request(offset);
    const [response] = await call.accepted;
    pending.push({ call, response });
  }
  const busy = await fetch(`${service.url}/api/v1/status`);
  assert.equal(busy.status, 503, 'finish plus close must not release a slot twice');
  assert.deepEqual(await busy.json(), { error: 'service busy' });
  for (const { call, response } of pending) {
    respond(response);
    assert.equal((await call.completed).status, 200);
    await call.closed;
  }
  assert.equal((await fetch(`${service.url}/api/v1/status`)).status, 200);
});

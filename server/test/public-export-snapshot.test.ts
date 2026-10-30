import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PublicExportSnapshotManager } from '../src/public-export-snapshot.js';

async function fixture(t: TestContext, timeoutMs = 5_000) {
  const dir = await mkdtemp(join(tmpdir(), 'public-export-snapshot-'));
  const statePath = join(dir, 'state.json');
  const attemptsPath = join(dir, 'attempts');
  const workerPath = join(dir, 'worker.mjs');
  await writeFile(workerPath, `
    import {parentPort} from 'node:worker_threads';
    import {readFileSync,appendFileSync} from 'node:fs';
    const state=JSON.parse(readFileSync(new URL('./state.json',import.meta.url),'utf8'));
    appendFileSync(new URL('./attempts',import.meta.url),'1');
    if(state.mode==='exit') process.exit(0);
    if(state.mode==='hang') setInterval(()=>{},1000);
    else if(state.mode==='fail') parentPort.postMessage({error:'refresh failed'});
    else {
      const token={id:'sol:one',chain:'sol',ca:'one',symbol:state.symbol};
      parentPort.postMessage({generatedAt:state.generatedAt,tokens:[token],fomoTokens:[{...token,fomoUsers:[]}]});
    }
  `);
  let now = 10_000;
  const manager = new PublicExportSnapshotManager(pathToFileURL(workerPath), 60_000, 1_000, timeoutMs, () => now);
  const update = (state: Record<string, unknown>) => writeFile(statePath, JSON.stringify(state));
  t.after(async () => { await manager.stop(); await rm(dir, { recursive: true, force: true }); });
  return { manager, update, setNow: (value: number) => { now = value; }, attempts: () => readFile(attemptsPath, 'utf8') };
}

test('coalesces cold reads, preserves a good snapshot on refresh failure, and rejects it at its capture-age bound', async (t) => {
  const f = await fixture(t);
  await f.update({mode:'success',generatedAt:10_000,symbol:'ORIGINAL'});
  const [first, same] = await Promise.all([f.manager.get(), f.manager.get()]);
  assert.equal(first.findToken('sol','one')?.symbol, 'ORIGINAL');
  assert.equal(same.generatedAt, first.generatedAt);
  assert.equal(await f.attempts(), '1', 'concurrent cold reads must share one database snapshot build');
  await f.update({mode:'fail'});
  await assert.rejects(f.manager.refresh());
  assert.equal((await f.manager.get()).findToken('sol','one')?.symbol, 'ORIGINAL');
  f.setNow(11_000);
  assert.equal(f.manager.isReady(), false);
  await assert.rejects(f.manager.get(), 'failed refresh cannot turn an expired snapshot into a fresh response');
});

test('rejects already-expired builds rather than measuring age from delivery', async (t) => {
  const f = await fixture(t);
  await f.update({mode:'success',generatedAt:8_000,symbol:'OLD'});
  await assert.rejects(f.manager.get());
  assert.equal(f.manager.isReady(), false);
});

test('a worker exiting without a result fails promptly and later refreshes can recover', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  await f.update({mode:'exit'});
  await assert.rejects(f.manager.refresh(), /exited before delivery/);
  await f.update({mode:'success',generatedAt:10_000,symbol:'RECOVERED'});
  assert.equal((await f.manager.get()).findToken('sol','one')?.symbol, 'RECOVERED');
});

// Real worker-thread termination must be exercised against the platform timer;
// faking only the parent clock cannot advance the worker's event loop.
test('terminates a stalled worker at the deadline and refuses reads after shutdown', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, 500);
  await f.update({mode:'hang'});
  await assert.rejects(f.manager.refresh(), /timed out/);
  await f.manager.stop();
  assert.equal(f.manager.isReady(), false);
  await assert.rejects(f.manager.get(), /stopped/);
});

test('shutdown terminates an active refresh and rejects its waiting readers', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  await f.update({mode:'hang'});
  const rejected = assert.rejects(f.manager.refresh(), /exited before delivery/);
  await f.manager.stop();
  await rejected;
  await assert.rejects(f.manager.get(), /stopped/);
});

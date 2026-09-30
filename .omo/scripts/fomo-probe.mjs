// Planning probe: capture the REAL FOMO alert payload, keyless (60s-delayed free tier = 0 credits).
// Writes raw JSONL to disk, prints only a compact schema summary. No product code, no key.
import { writeFileSync } from 'node:fs';

const OUT = '/home/namvt/Desktop/dev-space/signal_scan/.omo/evidence/fomo-user-watch/task-0-alert-sample.jsonl';
const URL = 'wss://api.fomoapi.io/ws/alerts'; // keyless => free, ~60s delayed
const TARGET_ALERTS = 120;
const MAX_MS = 115_000;

const raw = [];
const alerts = [];
const t0 = Date.now();
let ws;

function done(reason) {
  writeFileSync(OUT, raw.join('\n'), 'utf8');
  summarize(reason);
  try { ws?.close(); } catch {}
  process.exit(0);
}

function summarize(reason) {
  const counts = (arr) => {
    const m = {};
    for (const v of arr) m[String(v)] = (m[String(v)] ?? 0) + 1;
    return m;
  };
  const msgTypes = counts(rawMessages.map((m) => m.type));
  const alertTypes = counts(alerts.map((a) => a.type));
  const keys = {};
  for (const a of alerts) for (const k of Object.keys(a)) keys[k] = (keys[k] ?? 0) + 1;
  const chains = counts(alerts.map((a) => a.chain));

  console.log('=== CAPTURE ===');
  console.log('stop reason        :', reason);
  console.log('elapsed ms         :', Date.now() - t0);
  console.log('raw messages       :', raw.length);
  console.log('alert messages     :', alerts.length);
  console.log('raw bytes on disk  :', raw.join('\n').length);
  console.log('\n=== message .type distribution ===');
  console.log(JSON.stringify(msgTypes));
  console.log('\n=== alert .type distribution ===');
  console.log(JSON.stringify(alertTypes));
  console.log('\n=== alert chain values ===');
  console.log(JSON.stringify(chains));
  console.log('\n=== key presence across ' + alerts.length + ' alerts (name: count) ===');
  console.log(JSON.stringify(keys, null, 0));
  const money = ['usdValue', 'amountUsd', 'sizeUsd', 'realizedPnlUsd', 'priceUsd'];
  console.log('\n=== money-field null rate ===');
  for (const k of money) {
    if (keys[k] === undefined) continue;
    const present = alerts.filter((a) => a[k] !== null && a[k] !== undefined).length;
    console.log(`  ${k}: non-null ${present}/${alerts.length}`);
  }
  const handleish = ['trader', 'userHandle', 'handle', 'username', 'displayName', 'user'];
  console.log('\n=== handle-ish keys present? ===');
  for (const k of handleish) console.log(`  ${k}: ${keys[k] ?? 0}`);
  console.log('\n=== ONE FULL SAMPLE ALERT (trimmed) ===');
  console.log(JSON.stringify(alerts[0] ?? null, null, 2).slice(0, 1500));
  console.log('\n=== ONE SAMPLE PER alert.type ===');
  const seen = new Set();
  for (const a of alerts) {
    if (seen.has(a.type)) continue;
    seen.add(a.type);
    console.log(`--- ${a.type} ---`);
    console.log(JSON.stringify(a).slice(0, 700));
  }
}

let rawMessages = [];
try {
  ws = new WebSocket(URL);
  ws.addEventListener('open', () => console.log('WORKING: socket open (keyless)'));
  ws.addEventListener('error', (e) => console.log('socket error:', e?.message ?? e?.type ?? 'unknown'));
  ws.addEventListener('close', (e) => console.log('socket closed:', e?.code, e?.reason ?? ''));
  ws.addEventListener('message', (ev) => {
    const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
    if (text === 'ping' || text === 'pong') return;
    let m;
    try { m = JSON.parse(text); } catch { return; }
    raw.push(text);
    rawMessages.push(m);
    if (m.type === 'alert') alerts.push(m);
    if (alerts.length >= TARGET_ALERTS) done(`reached ${TARGET_ALERTS} alerts`);
  });
} catch (e) {
  console.log('constructor threw:', String(e));
}

setTimeout(() => done(`timeout ${MAX_MS}ms`), MAX_MS);

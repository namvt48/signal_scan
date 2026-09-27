// Validate the final rule set against prod-stored values (cas20.json):
//   T100 -> tfFor(age) rung, always overwritten (live ratio)
//   LF   -> same rung as T100 (one rung per token = what the FE shows), always
//           overwritten; deployed_at clamps the pre-genesis back-fill filler
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { NANSEN_HOURLY_STATS_URL, hourlyStatsBody } from '../dist/providers/nansen.js';
import { tfFor, t100Genesis, exchangeAnchorLf } from '../dist/snapshot.js';

const WS = process.env.CRAWL_WS_ENDPOINT || 'ws://localhost:3000';
const NOW = Date.now();
const CAS = JSON.parse(readFileSync(process.env.CAS20 || '/tmp/opencode/cas20.json', 'utf8'));

let browser = null;
let page = null;
async function getPage() {
  if (!browser?.connected) browser = await puppeteer.connect({ browserWSEndpoint: WS, defaultViewport: { width: 1280, height: 800 } });
  if (!page) {
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    await page.goto('https://app.nansen.ai/token-god-mode', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await new Promise((r) => setTimeout(r, 4000));
  }
  return page;
}
async function post(url, body) {
  for (let a = 1; a <= 2; a++) {
    try {
      const out = await (await getPage()).evaluate(async ({ url, body }) => {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
        return { status: res.status, json: await res.json().catch(() => null) };
      }, { url, body });
      if (out.status !== 403 || a === 2) return out;
      page = null;
      await sleep(6000);
    } catch (e) {
      page = null;
      if (a === 2) throw e;
      await sleep(6000);
    }
  }
  throw new Error('unreachable');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const n = (v) => (v == null ? 'null' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(3) + 'M' : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(+v.toFixed(4)));
const pct = (a, b) => (a == null || b == null || b === 0 ? '-' : ((Math.abs(a - b) / Math.abs(b)) * 100).toFixed(2) + '%');

async function series(ca, chain, rung, label) {
  const { status, json } = await post(NANSEN_HOURLY_STATS_URL, hourlyStatsBody(ca, chain, rung, false, label));
  const rows = json?.data;
  if (status !== 200 || !Array.isArray(rows)) throw new Error(`HTTP ${status} ${JSON.stringify(json)?.slice(0, 100)}`);
  return rows.filter((r) => typeof r.totalBalance === 'number' && Number.isFinite(r.totalBalance)).map((r) => ({ t: r.blockDate, total: r.totalBalance }));
}

const out = [];
const failures = [];
console.log(`final-rule validation — ${CAS.length} CAs @ ${new Date(NOW).toISOString()}`);
console.log(`both metrics on rung=tfFor(age) | T100 + LF always overwrite (LF clamped to deployed_at)\n`);
console.log('sym          age    rung      T100mult new/stored   (d)      LF new/stored                     (d)      LFwrite');
console.log('-'.repeat(112));
for (const c of CAS) {
  const age = c.d ? (NOW - c.d) / 86_400_000 : 0;
  const t100Rung = tfFor(age);
  try {
    const t100 = t100Genesis(await series(c.ca, c.ch, t100Rung, 'top_100_holders'));
    await sleep(1500);
    const lf = exchangeAnchorLf(await series(c.ca, c.ch, t100Rung, 'exchange'), c.d ?? 0);
    await sleep(1500);
    const t1 = t100?.multiple;
    const l = lf?.total;
    const gate = l != null;
    out.push({ sym: c.sym, age: +age.toFixed(1), t100Rung, t1, t1old: c.tm, t100pct: t100?.pct, l, lold: c.gb, gate });
    console.log(
      `${String(c.sym).padEnd(12)} ${age.toFixed(1).padStart(5)}d ${t100Rung.padEnd(9)} ` +
        `${`${n(t1)}/${n(c.tm)}`.padEnd(20)} ${pct(t1, c.tm).padStart(8)} ` +
        `${`${n(l)}/${n(c.gb)}`.padEnd(30)} ${pct(l, c.gb).padStart(8)} ${gate ? 'WRITE' : 'keep'}`,
    );
  } catch (e) {
    failures.push({ sym: c.sym, err: String(e).slice(0, 160) });
    console.log(`${String(c.sym).padEnd(12)} ${age.toFixed(1).padStart(5)}d ${t100Rung.padEnd(9)} FETCH FAILED: ${String(e).slice(0, 60)}`);
  }
}
console.log('-'.repeat(112));
const lfWrites = out.filter((r) => r.gate);
const t100Moved = out.filter((r) => r.t1old == null || Math.abs((r.t1 ?? 0) - r.t1old) > 1e-9);
console.log(`\n${out.length} ok, ${failures.length} failed`);
console.log(`\nLF WRITTEN (${lfWrites.length}):`);
for (const r of lfWrites) console.log(`  ${String(r.sym).padEnd(12)} ${n(r.lold)} -> ${n(r.l)}  (${pct(r.l, r.lold)})`);
console.log(`\nLF not written — empty fetch (${out.length - lfWrites.length}): ${out.filter((r) => !r.gate).map((r) => r.sym).join(', ')}`);
console.log(`\nT100 value moves after overwrite (${t100Moved.length}):`);
for (const r of t100Moved) console.log(`  ${String(r.sym).padEnd(12)} ${n(r.t1old)} -> ${n(r.t1)}  (${pct(r.t1, r.t1old)})`);
for (const f of failures) console.log(`\nFAILED ${f.sym}: ${f.err}`);
process.stdout.write('', () => process.exit(0));

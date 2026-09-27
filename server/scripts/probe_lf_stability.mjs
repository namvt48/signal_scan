// Probe: is the LF anchor for LINK stable across repeated fetches at the same rung?
// Prints point count, first/last bucket, and the anchored (leftmost total>0) value each iteration.
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { NANSEN_HOURLY_STATS_URL, hourlyStatsBody } from '../dist/providers/nansen.js';
import { exchangeAnchorLf, tfFor } from '../dist/snapshot.js';

const WS = process.env.CRAWL_WS_ENDPOINT || 'ws://localhost:3000';
const SYM = process.env.PROBE_SYM || 'LINK';
const ITERS = Number(process.env.PROBE_ITERS || 5);
const CAS = JSON.parse(readFileSync(process.env.CAS20 || '/tmp/opencode/cas20.json', 'utf8'));
const t = CAS.find((c) => String(c.sym).toUpperCase().includes(SYM.toUpperCase()));
if (!t) throw new Error(`no CA matching ${SYM}`);

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(url, body) {
  for (let a = 1; a <= 3; a++) {
    try {
      const out = await (await getPage()).evaluate(async ({ url, body }) => {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
        return { status: res.status, json: await res.json().catch(() => null) };
      }, { url, body });
      if (out.status !== 403 || a === 3) return out;
      page = null;
      await sleep(6000);
    } catch (e) {
      page = null;
      if (a === 3) throw e;
      await sleep(6000);
    }
  }
  throw new Error('unreachable');
}
async function series(rung, label) {
  const { status, json } = await post(NANSEN_HOURLY_STATS_URL, hourlyStatsBody(t.ca, t.ch, rung, false, label));
  const rows = json?.data;
  if (status !== 200 || !Array.isArray(rows)) throw new Error(`HTTP ${status} ${JSON.stringify(json)?.slice(0, 120)}`);
  return rows.filter((r) => typeof r.totalBalance === 'number' && Number.isFinite(r.totalBalance)).map((r) => ({ t: r.blockDate, total: r.totalBalance }));
}
const n = (v) => (v == null ? 'null' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(3) + 'M' : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(+v.toFixed(4)));

const ageDays = t.d ? (Date.now() - t.d) / 86_400_000 : 0;
console.log(`probe ${t.sym} ${t.ca} chain=${t.ch} age=${ageDays.toFixed(1)}d tfFor(age)=${tfFor(ageDays)} stored_gb=${n(t.gb)}\n`);

for (const rung of ['year', 'month']) {
  const seen = [];
  console.log(`--- rung=${rung} x${ITERS} ---`);
  for (let i = 1; i <= ITERS; i++) {
    try {
      const rows = await series(rung, 'exchange');
      const lf = exchangeAnchorLf(rows);
      const first = rows[0];
      const firstPos = rows.find((r) => r.total > 0);
      seen.push(lf?.total ?? null);
      console.log(
        `  #${i} pts=${String(rows.length).padStart(4)} firstBucket=${String(first?.t).padEnd(12)} firstTotal=${n(first?.total).padStart(14)}` +
          ` | leftmost>0 @${String(firstPos?.t).padEnd(12)} = ${n(firstPos?.total).padStart(14)} | anchorLf=${n(lf?.total).padStart(14)}`,
      );
    } catch (e) {
      console.log(`  #${i} FAILED ${String(e).slice(0, 90)}`);
    }
    await sleep(1500);
  }
  const uniq = [...new Set(seen.map((v) => (v == null ? 'null' : n(v))))];
  console.log(`  => distinct anchored values: ${uniq.join(' | ')}  ${uniq.length > 1 ? '** UNSTABLE **' : '(stable)'}\n`);
}
process.stdout.write('', () => process.exit(0));

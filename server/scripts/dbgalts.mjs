// Boundary sensitivity: for CAs whose TF-ladder rung is ambiguous, show every
// candidate TF side by side so the rung boundary can be pinned with evidence.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { NANSEN_HOURLY_STATS_URL, hourlyStatsBody } from '../dist/providers/nansen.js';

const WS = process.env.CRAWL_WS_ENDPOINT || 'ws://localhost:3000';
const CAS = JSON.parse(fs.readFileSync('/tmp/opencode/cas20.json', 'utf8'));
const pick = (sym) => CAS.find((c) => c.sym.includes(sym));
const JOBS = [
  ['EMBER', 'week'], ['EMBER', 'month'],
  ['STONK', 'week'], ['STONK', 'month'], ['STONK', 'year'],
  ['LINK', 'year'],
];

let browser = null, page = null;
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
  for (let a = 1; a <= 3; a++) {
    try {
      const p = await getPage();
      const out = await p.evaluate(async ({ url, body }) => {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
        return { status: res.status, json: await res.json().catch(() => null) };
      }, { url, body });
      if (out.status !== 403 || a === 3) return out;
      page = null; await new Promise((r) => setTimeout(r, 6000));
    } catch (e) { page = null; if (a === 3) return { status: 0, json: null, err: String(e).slice(0, 80) }; await new Promise((r) => setTimeout(r, 6000)); }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const atMs = (p) => (typeof p.t === 'number' ? p.t : Date.parse(String(p.t)));
const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const n = (v) => (v == null ? 'null' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(3) + 'M' : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(+v.toFixed(4)));
async function series(ca, label, date) {
  const { status, json } = await post(NANSEN_HOURLY_STATS_URL, hourlyStatsBody(ca, 'sol', date, false, label));
  const rows = json?.data;
  if (status !== 200 || !Array.isArray(rows)) return null;
  return rows.filter((r) => typeof r.totalBalance === 'number' && Number.isFinite(r.totalBalance))
    .map((r) => ({ t: r.blockDate, total: r.totalBalance })).sort((a, b) => atMs(a) - atMs(b));
}
const now = Date.now();
for (const [sym, tf] of JOBS) {
  const c = pick(sym);
  if (!c) { console.log(`!! ${sym} not found`); continue; }
  const ageD = ((now - c.d) / 864e5).toFixed(1);
  const t = await series(c.ca, 'top_100_holders', tf); await sleep(2200);
  const e = await series(c.ca, 'exchange', tf); await sleep(2200);
  const fmt = (pts) => {
    if (!pts) return 'FAILED';
    const pos = pts.filter((p) => p.total > 0);
    if (!pos.length) return `${pts.length} rows, no positive`;
    const A = pos[0].total;
    const minPos = Math.min(...pos.map((p) => p.total));
    const gaps = pts.slice(1, 4).map((p, i) => (atMs(p) - atMs(pts[i])) / 3.6e6);
    const gran = gaps.every((g) => g <= 2) ? 'HOURLY' : 'DAILY';
    return `${String(pts.length).padStart(3)} rows ${gran.padEnd(6)} A=${n(A).padStart(12)} @${iso(atMs(pos[0]))}  minPos=${n(minPos).padStart(12)}  A/B=${(A / minPos).toFixed(4)}`;
  };
  console.log(`\n${sym.padEnd(7)} age=${ageD}d TF=${tf.padEnd(6)}  (stored LF=${n(c.gb)}, stored T100 pct=${c.tp.toFixed(3)} mult=${c.tm.toFixed(3)})`);
  console.log(`   top_100: ${fmt(t)}`);
  console.log(`   exchange: ${fmt(e)}`);
}
process.stdout.write('', () => process.exit(0));

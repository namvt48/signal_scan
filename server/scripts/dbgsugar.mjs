// Does the API accept wider TF sugars (3M/90D/6M/half)? If a 90D rung exists and
// STONK's leftmost there == its stored 348.860M, the app has a rung between
// month and year that the ladder must include.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { NANSEN_HOURLY_STATS_URL, hourlyStatsBody } from '../dist/providers/nansen.js';

const WS = process.env.CRAWL_WS_ENDPOINT || 'ws://localhost:3000';
const CAS = JSON.parse(fs.readFileSync('/tmp/opencode/cas20.json', 'utf8'));
const c = CAS.find((x) => x.sym.includes(process.env.SYM || 'STONK'));
const SUGARS = ['quarter', '3m', '90d', '6m', 'half', 'ytd', 'all'];

const browser = await puppeteer.connect({ browserWSEndpoint: WS, defaultViewport: { width: 1280, height: 800 } });
const page = await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
await page.goto('https://app.nansen.ai/token-god-mode', { waitUntil: 'domcontentloaded', timeout: 45_000 });
await new Promise((r) => setTimeout(r, 4000));

const atMs = (p) => (typeof p.t === 'number' ? p.t : Date.parse(String(p.t)));
const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const n = (v) => (v == null ? 'null' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(3) + 'M' : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(+v.toFixed(4)));

async function series(label, date) {
  const body = hourlyStatsBody(c.ca, 'sol', date, false, label);
  const out = await page.evaluate(async ({ url, body }) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  }, { url: NANSEN_HOURLY_STATS_URL, body });
  const rows = out.json?.data;
  if (out.status !== 200 || !Array.isArray(rows)) return { status: out.status, note: JSON.stringify(out.json)?.slice(0, 140) };
  const pts = rows.filter((r) => typeof r.totalBalance === 'number' && Number.isFinite(r.totalBalance)).map((r) => ({ t: r.blockDate, total: r.totalBalance })).sort((a, b) => atMs(a) - atMs(b));
  const pos = pts.filter((p) => p.total > 0);
  return { rows: pts.length, first: pos[0] ? `${iso(atMs(pos[0]))}=${n(pos[0].total)}` : 'none', min: n(Math.min(...pts.map((p) => p.total))), max: n(Math.max(...pts.map((p) => p.total))) };
}

console.log(`${c.sym}  ca=${c.ca}  stored LF=${n(c.gb)}  stored T100 pct=${c.tp.toFixed(3)} mult=${c.tm.toFixed(3)}`);
for (const s of SUGARS) {
  for (const label of ['top_100_holders', 'exchange']) {
    const r = await series(label, s);
    await new Promise((x) => setTimeout(x, 2200));
    console.log(`  date=${s.padEnd(8)} ${label.padEnd(16)} ${r.note ? `REJECTED/ERR ${r.note}` : `rows=${String(r.rows).padStart(3)} first=${String(r.first).padStart(30)} min=${r.min} max=${r.max}`}`);
  }
}
await page.close().catch(() => {});
process.stdout.write('', () => process.exit(0));

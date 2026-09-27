// Granularity experiment: does a GENESIS-anchored SHORT window give hourly rows
// (true genesis hour) while the long clamped window gives daily rows (day close)?
// usage: CRAWL_WS_ENDPOINT=ws://localhost:3000 node server/scripts/dbgwin.mjs
import puppeteer from 'puppeteer-core';
import { NANSEN_HOURLY_STATS_URL, hourlyStatsBody } from '../dist/providers/nansen.js';

const WS = process.env.CRAWL_WS_ENDPOINT || 'ws://localhost:3000';
const CAS = [
  ['FWDI', 'FWDtiB5fXHdVAewPqvHPL2dh4aBC1C6GacQbePoQXKjz', '2026-09-14T22:56:00Z'],
  ['ELON', 'GY9mZfyPpxXxBXBxS2hB2XjhP3kfUsywTvgveozxpump', '2026-09-02T23:38:00Z'],
  ['ZCAT', 'HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR', '2026-08-30T23:29:00Z'],
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
  for (let a = 1; a <= 2; a++) {
    try {
      const p = await getPage();
      const out = await p.evaluate(async ({ url, body }) => {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
        return { status: res.status, json: await res.json().catch(() => null) };
      }, { url, body });
      if (out.status !== 403 || a === 2) return out;
      page = null; await new Promise((r) => setTimeout(r, 6000));
    } catch (e) { page = null; if (a === 2) throw e; await new Promise((r) => setTimeout(r, 6000)); }
  }
  throw new Error('unreachable');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const atMs = (p) => (typeof p.t === 'number' ? p.t : Date.parse(String(p.t)));
const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const n = (v) => (v == null ? 'null' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(3) + 'M' : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(+v.toFixed(4)));

async function snap(ca, label, date) {
  const { status, json } = await post(NANSEN_HOURLY_STATS_URL, hourlyStatsBody(ca, 'sol', date, false, label));
  const rows = json?.data;
  if (status !== 200 || !Array.isArray(rows)) return { status, note: `HTTP ${status}` };
  const pts = rows.filter((r) => typeof r.totalBalance === 'number' && Number.isFinite(r.totalBalance)).map((r) => ({ t: r.blockDate, total: r.totalBalance })).sort((a, b) => atMs(a) - atMs(b));
  const gaps = pts.slice(1, 6).map((p, i) => (atMs(p) - atMs(pts[i])) / 3.6e6);
  const gran = gaps.length ? (gaps.every((g) => g <= 2) ? 'HOURLY' : gaps.every((g) => g >= 20) ? 'DAILY' : `mixed[${gaps.join(',')}]`) : '?';
  const fp = pts.find((p) => p.total > 0);
  const vals = pts.map((p) => p.total);
  return { status, pts, gran, fp, min: Math.min(...vals), max: Math.max(...vals) };
}

const now = Date.now();
for (const [sym, ca, depS] of CAS) {
  const dep = Date.parse(depS);
  const wins = [
    ['prod: max(now-365d, dep) -> now', { from: depS, to: new Date(now).toISOString() }],
    ['genesis: dep -> dep+2d', { from: depS, to: new Date(dep + 2 * 864e5).toISOString() }],
    ['genesis: dep-1d -> dep+3d', { from: new Date(dep - 864e5).toISOString(), to: new Date(dep + 3 * 864e5).toISOString() }],
    ['sugar: date="month"', 'month'],
  ];
  console.log(`\n${'='.repeat(80)}\n${sym}  dep=${depS}\n${'='.repeat(80)}`);
  for (const [name, date] of wins) {
    for (const label of ['top_100_holders', 'exchange']) {
      const r = await snap(ca, label, date);
      await sleep(2200);
      if (r.pts) {
        console.log(`\n[${name}] label=${label}  rows=${r.pts.length} gran=${r.gran}`);
        console.log(`   firstPos=${r.fp ? `${iso(atMs(r.fp))} = ${n(r.fp.total)}` : 'none'}   min=${n(r.min)} max=${n(r.max)}`);
        for (const p of r.pts.slice(0, 4)) console.log(`     ${iso(atMs(p))}  ${n(p.total).padStart(14)}`);
      } else console.log(`\n[${name}] label=${label}  FAILED ${r.note}`);
    }
  }
}
process.stdout.write('', () => process.exit(0));

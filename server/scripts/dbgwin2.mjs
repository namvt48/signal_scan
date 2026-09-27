// Pin the TF rule: which fixed-TF window (`date` sugar) reproduces the user's
// authoritative numbers? Compares week/month/year + raw 365d span per CA.
import puppeteer from 'puppeteer-core';
import { NANSEN_HOURLY_STATS_URL, hourlyStatsBody } from '../dist/providers/nansen.js';

const WS = process.env.CRAWL_WS_ENDPOINT || 'ws://localhost:3000';
const CAS = [
  ['FWDI (age 2.8d, user TF 7D)', 'FWDtiB5fXHdVAewPqvHPL2dh4aBC1C6GacQbePoQXKjz', '2026-09-14T22:56:00Z'],
  ['ELON (age 14d, user TF 30D)', 'GY9mZfyPpxXxBXBxS2hB2XjhP3kfUsywTvgveozxpump', '2026-09-02T23:38:00Z'],
  ['ZCAT (age 17d, user TF 30D)', 'HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR', '2026-08-30T23:29:00Z'],
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
  if (status !== 200 || !Array.isArray(rows)) return { status, note: `HTTP ${status} ${JSON.stringify(json)?.slice(0, 120)}` };
  const pts = rows.filter((r) => typeof r.totalBalance === 'number' && Number.isFinite(r.totalBalance)).map((r) => ({ t: r.blockDate, total: r.totalBalance })).sort((a, b) => atMs(a) - atMs(b));
  const gaps = pts.slice(1, 6).map((p, i) => (atMs(p) - atMs(pts[i])) / 3.6e6);
  const gran = gaps.length ? (gaps.every((g) => g <= 2) ? 'HOURLY' : gaps.every((g) => g >= 20) ? 'DAILY' : `mixed[${gaps.join(',')}]`) : '?';
  const fp = pts.find((p) => p.total > 0);
  const vals = pts.map((p) => p.total);
  const min = Math.min(...vals), max = Math.max(...vals);
  const mult = fp && min > 0 ? fp.total / min : null;
  return { pts, gran, fp, min, max, mult };
}

const now = Date.now();
for (const [name, ca, depS] of CAS) {
  const oneYearAgo = new Date(now - 365 * 864e5).toISOString();
  const wins = [
    ['week', 'week'],
    ['month', 'month'],
    ['year', 'year'],
    ['raw365d {now-365d,now}', { from: oneYearAgo, to: new Date(now).toISOString() }],
  ];
  console.log(`\n${'='.repeat(84)}\n${name}\n  ca=${ca}  dep=${depS}\n${'='.repeat(84)}`);
  for (const [wname, date] of wins) {
    for (const label of ['top_100_holders', 'exchange']) {
      const r = await snap(ca, label, date);
      await sleep(2200);
      if (!r.pts) { console.log(`\n  [${wname}] ${label}: FAILED ${r.note}`); continue; }
      console.log(`\n  [${wname}] ${label}  rows=${r.pts.length} gran=${r.gran}`);
      console.log(`     first=${r.fp ? `${iso(atMs(r.fp))}=${n(r.fp.total)}` : 'none'}  min=${n(r.min)} max=${n(r.max)}  A/B=${r.mult ? r.mult.toFixed(4) : '-'}`);
      console.log('     head: ' + r.pts.slice(0, 5).map((p) => `${iso(atMs(p))}=${n(p.total)}`).join('  '));
    }
  }
}
process.stdout.write('', () => process.exit(0));

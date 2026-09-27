// LOCAL debug crawl for the 20 tracked CAs — prints the RAW series + the pure-fn
// output (t100Genesis / exchangeAnchorLf) using the SAME clamped window as prod
// (seriesFromMs), so we can compare against the numbers read off the FE chart.
//
// usage: CRAWL_WS_ENDPOINT=ws://localhost:3000 node server/scripts/dbg20.mjs [full]
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { NANSEN_HOURLY_STATS_URL, hourlyStatsBody } from '../dist/providers/nansen.js';
import { seriesFromMs, t100Genesis, exchangeAnchorLf } from '../dist/snapshot.js';

const CAP = 365 * 864e5;
const WS = process.env.CRAWL_WS_ENDPOINT || 'ws://localhost:3000';
const DETAIL = process.argv.includes('full');
const FOCUS = ['FWDtiB5fXHdVAewPqvHPL2dh4aBC1C6GacQbePoQXKjz', 'GY9mZfyPpxXxBXBxS2hB2XjhP3kfUsywTvgveozxpump', 'HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR'];

const cas = JSON.parse(fs.readFileSync('/tmp/opencode/cas20.json', 'utf8'));

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
const n = (v) => (v == null ? 'null' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(+v.toFixed(4)));

async function series(ca, dep, label) {
  const now = Date.now();
  const from = new Date(seriesFromMs(now, dep, CAP)).toISOString();
  const { status, json } = await post(NANSEN_HOURLY_STATS_URL, hourlyStatsBody(ca, 'sol', { from, to: new Date(now).toISOString() }, false, label));
  const rows = json?.data;
  if (status !== 200 || !Array.isArray(rows)) return { status, from, points: null };
  const points = rows
    .filter((r) => typeof r.totalBalance === 'number' && Number.isFinite(r.totalBalance))
    .map((r) => ({ t: r.blockDate, total: r.totalBalance }))
    .sort((a, b) => atMs(a) - atMs(b));
  return { status, from, points };
}
const firstPos = (p) => (p ? p.find((x) => x.total > 0) : undefined);
const leftOf = (p, days) => (p ? p.find((x) => atMs(x) >= Date.now() - days * 864e5) : undefined);

console.log(`\n##### LOCAL CRAWL 20 CA — win = max(now-365d, dep) #####\n`);
for (const [i, c] of cas.entries()) {
  const dep = c.d;
  const tag = `${String(i + 1).padStart(2)}/${cas.length} ${String(c.sym || '?').padEnd(9)} ${c.ca.slice(0, 12)}`;
  try {
    const t100 = await series(c.ca, dep, 'top_100_holders');
    await sleep(2500);
    const ex = await series(c.ca, dep, 'exchange');
    await sleep(2500);
    const g = t100.points ? t100Genesis(t100.points) : undefined;
    const lf = ex.points ? exchangeAnchorLf(ex.points) : undefined;
    const f100 = firstPos(t100.points), fex = firstPos(ex.points);
    const l7 = leftOf(t100.points, 7), l30 = leftOf(t100.points, 30);
    console.log(`${tag} dep=${dep ? iso(dep) : '?'}  winFrom=${iso(Date.parse(t100.from))}`);
    console.log(`      chart(top_100) status=${t100.status} n=${t100.points?.length ?? '-'}  firstPos=${f100 ? `${iso(atMs(f100))} = ${n(f100.total)}` : 'none'}  left7d=${l7 ? n(l7.total) : '-'} left30d=${l30 ? n(l30.total) : '-'}`);
    console.log(`      exch(exchange) status=${ex.status} n=${ex.points?.length ?? '-'}  firstPos=${fex ? `${iso(atMs(fex))} = ${n(fex.total)}` : 'none'}`);
    console.log(`      T100 pct=${g ? g.pct.toFixed(4) : '-'} x${g ? g.multiple.toFixed(4) : '-'} anchor=${g ? g.anchorAt.slice(0, 16) : '-'}   LF(exch)=${lf ? n(lf.total) : '-'} @${lf ? lf.at.slice(0, 16) : '-'}`);
    console.log(`      STORED lf=${c.gb == null ? 'null' : n(c.gb)}  t100_pct=${c.tp}  t100_x=${c.tm}  anchor=${c.a ? iso(c.a) : 'null'}`);
    if (DETAIL || FOCUS.includes(c.ca)) {
      console.log(`      --- top_100 first 10 ---`);
      for (const p of (t100.points || []).slice(0, 10)) console.log(`          ${iso(atMs(p))}  ${n(p.total)}`);
      console.log(`      --- exchange first 10 ---`);
      for (const p of (ex.points || []).slice(0, 10)) console.log(`          ${iso(atMs(p))}  ${n(p.total)}`);
    }
    console.log('');
  } catch (e) {
    console.log(`${tag} ERROR ${String(e?.message || e)}`);
  }
}
process.stdout.write('', () => process.exit(0));

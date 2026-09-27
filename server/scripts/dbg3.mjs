// FOCUS debug: full row dump for the 3 mismatching CAs, all label variants.
// usage: CRAWL_WS_ENDPOINT=ws://localhost:3000 node server/scripts/dbg3.mjs
import puppeteer from 'puppeteer-core';
import { NANSEN_HOURLY_STATS_URL, hourlyStatsBody } from '../dist/providers/nansen.js';
import { seriesFromMs, t100Genesis, exchangeAnchorLf } from '../dist/snapshot.js';

const CAP = 365 * 864e5;
const WS = process.env.CRAWL_WS_ENDPOINT || 'ws://localhost:3000';
const FOCUS = [
  ['FWDI', 'FWDtiB5fXHdVAewPqvHPL2dh4aBC1C6GacQbePoQXKjz', '2026-09-14T22:56'],
  ['ELON', 'GY9mZfyPpxXxBXBxS2hB2XjhP3kfUsywTvgveozxpump', '2026-09-02T23:38'],
  ['ZCAT', 'HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR', '2026-08-30T23:29'],
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

async function fetchSeries(ca, dep, label, exclude) {
  const now = Date.now();
  const from = new Date(seriesFromMs(now, dep, CAP)).toISOString();
  const { status, json } = await post(NANSEN_HOURLY_STATS_URL, hourlyStatsBody(ca, 'sol', { from, to: new Date(now).toISOString() }, exclude, label));
  const rows = json?.data;
  if (status !== 200 || !Array.isArray(rows)) return { status, from, points: null };
  return {
    status,
    from,
    points: rows.filter((r) => typeof r.totalBalance === 'number' && Number.isFinite(r.totalBalance)).map((r) => ({ t: r.blockDate, total: r.totalBalance })).sort((a, b) => atMs(a) - atMs(b)),
  };
}
const firstPos = (p) => p?.find((x) => x.total > 0);

for (const [sym, ca, depS] of FOCUS) {
  const dep = Date.parse(depS);
  const now = Date.now();
  console.log(`\n${'='.repeat(78)}\n${sym}  ${ca}\n dep=${depS}  now=${iso(now)}  winFrom=${iso(seriesFromMs(now, dep, CAP))}\n${'='.repeat(78)}`);
  for (const [label, exclude] of [['top_100_holders', false], ['top_100_holders', true], ['exchange', false]]) {
    const r = await fetchSeries(ca, dep, label, exclude);
    await sleep(2500);
    const fp = firstPos(r.points);
    const vals = (r.points || []).map((p) => p.total);
    console.log(`\n-- label=${label} excludeExchanges=${exclude} status=${r.status} rows=${r.points?.length ?? '-'}`);
    console.log(`   firstPos=${fp ? `${iso(atMs(fp))} = ${n(fp.total)}` : 'none'}   min=${vals.length ? n(Math.min(...vals)) : '-'}   max=${vals.length ? n(Math.max(...vals)) : '-'}`);
    for (const p of r.points || []) console.log(`     ${iso(atMs(p))}  ${n(p.total).padStart(14)}`);
  }
  const t100 = await fetchSeries(ca, dep, 'top_100_holders', false);
  await sleep(2500);
  const g = t100.points ? t100Genesis(t100.points) : undefined;
  console.log(`\n   >> t100Genesis = ${g ? `pct=${g.pct.toFixed(4)} multiple=${g.multiple.toFixed(4)} anchor=${iso(typeof g.anchorAt === 'number' ? g.anchorAt : Date.parse(String(g.anchorAt)))}` : 'undefined'}`);
  const ex = await fetchSeries(ca, dep, 'exchange', false);
  await sleep(2500);
  const lf = ex.points ? exchangeAnchorLf(ex.points) : undefined;
  console.log(`   >> exchangeAnchorLf = ${lf ? `${n(lf.total)} @${iso(Date.parse(lf.at))}` : 'undefined'}`);
}
process.stdout.write('', () => process.exit(0));

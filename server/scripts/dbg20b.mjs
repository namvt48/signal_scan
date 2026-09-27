// Verify the TF-ladder rule across all 20 tracked CAs.
// Rule: TF = smallest of {week(7d), month(30d), year(365d)} that is >= token age.
//   T100: A = leftmost total>0, B = min  -> pct=(A-B)/A*100, mult=A/B
//   LF  : leftmost total>0 of the `exchange` label
// Prints stored (DB) vs new (TF-ladder) so they can be diffed side by side.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { NANSEN_HOURLY_STATS_URL, hourlyStatsBody } from '../dist/providers/nansen.js';

const WS = process.env.CRAWL_WS_ENDPOINT || 'ws://localhost:3000';
const CAS = JSON.parse(fs.readFileSync('/tmp/opencode/cas20.json', 'utf8'));

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
function metrics(pts) {
  if (!pts?.length) return null;
  const live = pts.filter((p) => p.total > 0);
  if (!live.length) return null;
  const A = live[0], vals = pts.map((p) => p.total);
  const B = Math.min(...vals.filter((v) => v > 0 >= 0 ? v >= 0 : true));
  const Bmin = Math.min(...vals);
  return { A, B, Bmin, min: Bmin, max: Math.max(...vals), at: A.t };
}
const tfFor = (ageMs) => (ageMs <= 7 * 864e5 ? 'week' : ageMs <= 30 * 864e5 ? 'month' : 'year');

const now = Date.now();
const out = [];
for (const c of CAS) {
  const ageMs = now - c.d;
  const ageD = (ageMs / 864e5).toFixed(1);
  const tf = tfFor(ageMs);
  const t = await series(c.ca, 'top_100_holders', tf); await sleep(2200);
  const e = await series(c.ca, 'exchange', tf); await sleep(2200);
  const mt = metrics(t), me = metrics(e);
  // A/B with B = min over positive values (trough), as the FE/rule uses the chart min
  let pct = null, mult = null, aVal = null, bVal = null;
  if (mt && mt.A.total > 0) {
    const positives = t.map((p) => p.total).filter((v) => v > 0);
    bVal = Math.min(...positives);
    aVal = mt.A.total;
    if (bVal > 0) { pct = ((aVal - bVal) / aVal) * 100; mult = aVal / bVal; }
  }
  const lf = me?.A.total ?? null;
  out.push({
    sym: c.sym, ca: c.ca, ageD, tf,
    storedLf: c.gb, newLf: lf,
    storedPct: c.tp, storedMult: c.tm,
    newPct: pct, newMult: mult,
    A: aVal, B: bVal, anchor: mt?.at ?? null, lfAt: me?.at ?? null,
    nT: t?.length ?? 0, nE: e?.length ?? 0,
  });
  console.log(`${c.sym.padEnd(10)} age=${ageD.padStart(5)} TF=${tf.padEnd(5)} nT/nE=${String(out.at(-1).nT)}/${String(out.at(-1).nE)}`);
}

console.log(`\n${'='.repeat(150)}`);
console.log('sym        age   TF     | storedLF            newLF               | storedTP  storedTM | newTP     newTM   | A(=leftmost pos)      B(=trough)         | lfAt                anchor');
console.log('-'.repeat(150));
for (const r of out) {
  const chgLf = r.storedLf != null && r.newLf != null && Math.abs(r.storedLf - r.newLf) > Math.max(1, 1e-6 * Math.abs(r.newLf)) ? '*' : ' ';
  console.log(
    `${r.sym.padEnd(10)} ${r.ageD.padStart(5)} ${r.tf.padEnd(6)} | ${String(n(r.storedLf)).padStart(14)}${chgLf}${String(n(r.newLf)).padStart(14)} | ` +
    `${(r.storedPct ?? 0).toFixed(3).padStart(9)} ${String(r.storedMult ?? 0).padStart(8)} | ` +
    `${(r.newPct == null ? 'null' : r.newPct.toFixed(3)).padStart(8)} ${(r.newMult == null ? 'null' : r.newMult.toFixed(3)).padStart(7)} | ` +
    `${String(n(r.A)).padStart(14)} ${String(n(r.B)).padStart(18)} | ${(r.lfAt ? iso(r.lfAt) : '-').padEnd(19)} ${r.anchor ? iso(r.anchor) : '-'}`,
  );
}
fs.writeFileSync('/tmp/opencode/dbg20b.json', JSON.stringify(out, null, 1));
process.stdout.write('', () => process.exit(0));

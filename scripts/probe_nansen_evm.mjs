// T2 probe (plan .omo/plans/evm-base-bsc.md, risk R1): does Nansen's FREE
// app-questions door accept EVM chain slugs (`base`, `bnb`)?
//
// Replays the EXACT request shape of server/src/providers/nansen.ts
// (essentialDataBody / holdersGiniBody) through the SAME transport as
// server/src/crawl.ts: a real Chromium via browserless CDP (CRAWL_WS_ENDPOINT,
// default ws://chrome:3000), same-origin from app.nansen.ai after cf_clearance.
// Falls back to plain HTTPS (expected: Cloudflare 403 — that is what makes the
// door browser-only) so the evidence file records both attempts.
//
// Run anywhere:  node scripts/probe_nansen_evm.mjs
// Run on instance B (sidecar exists):
//   ssh root@194.163.187.250 'cd /root/signal_scan_b && docker compose -p signal_scan_b cp scripts/probe_nansen_evm.mjs api:/app/probe_nansen_evm.mjs && docker compose -p signal_scan_b exec api node /app/probe_nansen_evm.mjs'
// (inside the api container puppeteer-core resolves from /app/node_modules)
//
// Writes evidence/T2-nansen-evm-probe.json. NEVER prints keys/cookies/proxy creds.

import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import net from 'node:net';

const WS = process.env.CRAWL_WS_ENDPOINT || 'ws://chrome:3000';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TOKEN_GOD_MODE = 'https://app.nansen.ai/token-god-mode';

// Free app-questions endpoints (nansen.ts:44-47)
const ENDPOINTS = {
  essential: 'https://app.nansen.ai/api/questions/tgm-essential-data',
  gini: 'https://app.nansen.ai/api/questions/tgm-holders-gini-stats',
};

// Real, well-known CAs per chain (liquid tokens — a row must exist if the chain is supported).
const CHAINS = [
  { canonical: 'sol', slug: 'solana', ca: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', control: true },
  { canonical: 'base', slug: 'base', ca: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }, // USDC on Base
  { canonical: 'bsc', slug: 'bnb', ca: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' }, // WBNB
  // Distinguishing control: an invented slug. If unknown chains 400/404 with a
  // specific error while `base`/`bnb` behave like `solana`, that is the signal.
  { canonical: 'fake', slug: 'notachain', ca: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', control: true },
];

// EXACT body shapes — mirrors essentialDataBody / holdersGiniBody (nansen.ts:96-113).
function essentialBody(ca, slug) {
  return { parameters: { chain: slug, tokenAddress: ca }, filters: {}, pagination: { page: 1, recordsPerPage: 100 }, order: { order: 'desc' } };
}
function giniBody(ca, slug) {
  return { parameters: { tokenAddress: ca, chain: slug }, filters: {}, pagination: { page: 1, recordsPerPage: 100 }, order: { order: 'desc' } };
}
const REQUESTS = [];
for (const c of CHAINS) {
  REQUESTS.push({ ...c, endpoint: 'essential', url: ENDPOINTS.essential, body: essentialBody(c.ca, c.slug) });
  if (!c.control || c.canonical === 'sol') {
    REQUESTS.push({ ...c, endpoint: 'gini', url: ENDPOINTS.gini, body: giniBody(c.ca, c.slug) });
  }
}

/** Strip any user:pass@ from URLs so evidence never carries proxy creds. */
function redact(s) {
  return String(s).replace(/\/\/[^/?#\s]*@/g, '//');
}
function snippet(txt) {
  return redact(String(txt ?? '').slice(0, 240));
}

// ---------------------------------------------------------------------------
// Transport (a): browser door over CDP — same shape as crawl.ts realConnect.
// ---------------------------------------------------------------------------
async function loadPuppeteer() {
  try {
    return (await import('puppeteer-core')).default;
  } catch {
    try {
      // repo-root run: resolve from server/node_modules
      const req = createRequire(new URL('../server/package.json', import.meta.url));
      return req('puppeteer-core');
    } catch {
      return null;
    }
  }
}

function wsReachable(wsUrl, timeoutMs = 2500) {
  return new Promise((resolve) => {
    try {
      const u = new URL(wsUrl);
      const sock = net.connect({ host: u.hostname, port: Number(u.port || 80), timeout: timeoutMs });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('timeout', () => { sock.destroy(); resolve(false); });
      sock.once('error', () => { sock.destroy(); resolve(false); });
    } catch { resolve(false); }
  });
}

// Runs INSIDE the nansen page — identical to crawl.ts inPageFetch.
async function inPageFetch(args) {
  try {
    const r = await fetch(args.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(args.body),
    });
    const txt = await r.text();
    return { status: r.status, contentType: r.headers.get('content-type') ?? '', head: txt.slice(0, 240), len: txt.length, threw: false };
  } catch (e) {
    return { status: 0, contentType: '', head: String((e && e.message) || e).slice(0, 160), len: 0, threw: true };
  }
}

async function doorProbe(results) {
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) { results.push({ transport: 'door', error: 'puppeteer-core unavailable' }); return false; }
  if (!(await wsReachable(WS))) { results.push({ transport: 'door', error: `CDP endpoint unreachable: ${redact(WS)}` }); return false; }
  let browser = null, page = null;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: WS, defaultViewport: { width: 1280, height: 800 } });
    page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    await page.goto(TOKEN_GOD_MODE, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // CF-clear warmup (crawl.ts D3): poll cf_clearance, cap ~60s.
    const t0 = Date.now();
    for (;;) {
      const cookies = await browser.cookies().catch(() => []);
      if (cookies.some((c) => c.name === 'cf_clearance')) break;
      if (Date.now() - t0 > 60_000) throw new Error('warmup timeout: no cf_clearance in 60s');
      await new Promise((r) => setTimeout(r, 2500));
    }
    for (const req of REQUESTS) {
      const res = await page.evaluate(inPageFetch, { url: req.url, body: req.body });
      results.push({
        transport: 'door', canonical: req.canonical, slug: req.slug, endpoint: req.endpoint,
        url: req.url, method: 'POST', status: res.status, contentType: res.contentType,
        len: res.len, snippet: snippet(res.head), threw: res.threw,
      });
      console.log(`[door] ${req.canonical}/${req.slug} ${req.endpoint} -> ${res.status} ${snippet(res.head).slice(0, 120)}`);
    }
    return true;
  } catch (e) {
    results.push({ transport: 'door', error: redact(String((e && e.message) || e)).slice(0, 200) });
    return false;
  } finally {
    await page?.close().catch(() => {});
    await browser?.disconnect().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Transport (b): plain HTTPS from node — documents the CF wall (crawl.ts header
// comment: curl/node-fetch = 403, verified). Kept as evidence, not as a bypass.
// ---------------------------------------------------------------------------
async function httpsProbe(results) {
  for (const req of REQUESTS) {
    try {
      const r = await fetch(req.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
        body: JSON.stringify(req.body),
      });
      const txt = await r.text();
      results.push({
        transport: 'https', canonical: req.canonical, slug: req.slug, endpoint: req.endpoint,
        url: req.url, method: 'POST', status: r.status, contentType: r.headers.get('content-type') ?? '',
        len: txt.length, snippet: snippet(txt), threw: false,
      });
      console.log(`[https] ${req.canonical}/${req.slug} ${req.endpoint} -> ${r.status} ${snippet(txt).slice(0, 100)}`);
    } catch (e) {
      results.push({ transport: 'https', canonical: req.canonical, slug: req.slug, endpoint: req.endpoint, url: req.url, method: 'POST', status: 0, threw: true, snippet: snippet(String((e && e.message) || e)) });
    }
  }
}

// ---------------------------------------------------------------------------
const results = [];
const doorOk = await doorProbe(results);
await httpsProbe(results);

// Verdict logic: door results decide; https-only ⇒ BLOCKED-LOCALLY.
function doorRows(slug) { return results.filter((r) => r.transport === 'door' && r.slug === slug && typeof r.status === 'number'); }
let verdict, reasoning;
if (!doorOk) {
  verdict = 'BLOCKED-LOCALLY';
  reasoning = 'No chrome sidecar reachable at CRAWL_WS_ENDPOINT and plain HTTPS is Cloudflare-walled (expected: the free door is browser-only). Re-run on instance B.';
} else {
  const base = doorRows('base'), bnb = doorRows('bnb'), sol = doorRows('solana'), fake = doorRows('notachain');
  const ok = (rows) => rows.length > 0 && rows.every((r) => r.status === 200);
  const rejected = (rows) => rows.length > 0 && rows.every((r) => r.status === 400 || r.status === 404 || r.status === 422);
  if (ok(sol) && ok(base) && ok(bnb)) { verdict = 'SUPPORTED'; reasoning = 'base+bnb returned 200 payloads through the browser door, same as the solana control.'; }
  else if (ok(sol) && (rejected(base) || rejected(bnb))) { verdict = 'UNSUPPORTED'; reasoning = 'solana control 200 but EVM slugs rejected with 4xx chain errors.'; }
  else { verdict = 'INCONCLUSIVE'; reasoning = 'Door answered but statuses did not form a clean pattern — inspect evidence JSON.'; }
  if (fake.length) reasoning += ` Fake-slug control (notachain): ${fake.map((r) => r.status).join(',')}.`;
}

const evidence = { task: 'T2', plan: '.omo/plans/evm-base-bsc.md', ts: new Date().toISOString(), wsEndpoint: redact(WS), doorOk, verdict, reasoning, results };
mkdirSync(new URL('../evidence', import.meta.url).pathname, { recursive: true });
writeFileSync(new URL('../evidence/T2-nansen-evm-probe.json', import.meta.url), JSON.stringify(evidence, null, 2));

console.log(`\nVERDICT: ${verdict} — ${reasoning}`);
console.log('Evidence: evidence/T2-nansen-evm-probe.json');
process.exit(0);

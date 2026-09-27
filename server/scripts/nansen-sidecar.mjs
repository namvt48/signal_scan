// Nansen probe transport — LOCAL. CDP vào browserless Chrome chạy trên máy này
// (docker run -d --name nansen-chrome -p 3000:3000 browserless/chrome:1.61-chrome-stable)
// -> request đi từ trang Chrome đã clear CF, không cần ssh --server, không cần
// copy cookie/UA. Cùng transport + cùng body builder với prod poller
// (import truc tiep tu dist/providers/nansen.js).
//
// stdin: each "ca [depMs]" line -> one CA; stdout: one JSON per CA, keys =
// {essential,chart,gini,volume,change,balances} -> {status, json}, plus "dep".
//
// usage: docker run -d --name nansen-chrome -p 3000:3000 browserless/chrome:1.61-chrome-stable
//        node server/scripts/nansen-sidecar.mjs <chain> <back> <wantCsv> < list.txt
import readline from 'node:readline';
import puppeteer from 'puppeteer-core';
import {
  NANSEN_ESSENTIAL_DATA_URL,
  NANSEN_HOURLY_STATS_URL,
  NANSEN_HOLDERS_GINI_URL,
  NANSEN_VOLUME_DETAILS_URL,
  NANSEN_HOLDERS_CHANGE_URL,
  NANSEN_HOLDERS_BALANCES_URL,
  essentialDataBody,
  hourlyStatsBody,
  holdersGiniBody,
  volumeDetailsBody,
  holdersChangeBody,
  holdersBalancesBody,
} from '../dist/providers/nansen.js';

const [chain, backS, wantCsv] = process.argv.slice(2);
// Charts API toi da ~1Y: tu ngay dep rat xa van phai nam trong range hop le.
const winFrom = (depMs, backDays) =>
  new Date(Math.max(depMs - backDays * 864e5, Date.now() - 364 * 864e5)).toISOString();
const back = +backS || 3;
const want = (wantCsv || 'essential,chart,gini').split(',');
const WS = process.env.CRAWL_WS_ENDPOINT || 'ws://localhost:3000';

let browser = null;
let workPage = null;

async function getBrowser() {
  if (browser?.connected) return browser;
  browser = await puppeteer.connect({
    browserWSEndpoint: WS,
    defaultViewport: { width: 1280, height: 800 },
  });
  browser.on('disconnected', () => {
    browser = null;
  });
  return browser;
}

// One persistent stealth page — same trick as prod crawl.js getWorkPage:
// CF clearance cookie survives every later call.
async function getWorkPage() {
  if (!workPage) {
    workPage = (async () => {
      const b = await getBrowser();
      const p = await b.newPage();
      await p.setUserAgent(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      );
      await p.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      await p.goto('https://app.nansen.ai/token-god-mode', {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      await new Promise((r) => setTimeout(r, 4000));
      return p;
    })();
    workPage.catch(() => {
      workPage = null;
    });
  }
  return workPage;
}

async function browserPostJson(url, body) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const page = await getWorkPage();
    try {
      const out = await page.evaluate(async ({ url, body }) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: res.status, json: await res.json().catch(() => null) };
      }, { url, body });
      if (out.status !== 403 || attempt === 2) return out;
      // 403 + body null = Nansen rate-limit (non-browser-shaped reject) ->
      // back off before rebuilding the cleared page; rebuild chỉ khi cần.
      await sleep(8000);
      if (out.json === null) workPage = null;
    } catch (e) {
      workPage = null;
      if (attempt === 2) throw e;
      await sleep(8000);
    }
  }
  throw new Error('unreachable');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const el = () => (((Date.now() - t0) / 1000).toFixed(1) + 's').padStart(6);
// log ra STDERR (stdout giữ thuần JSON cho python đọc). prefix "> " dễ grep.
const log = (...a) => console.error(`[${el()}] >`, ...a);
const rows = [];
const rl = readline.createInterface({ input: process.stdin, terminal: false });
for await (const ln of rl) {
  const [ca, dep] = ln.trim().split(/\s+/);
  if (ca) rows.push([ca, +dep || 0]);
}
log(`${rows.length} CA · chain=${chain} · back=${back}d · q=${want.join(',')} · chrome=${WS}`);

// Wraps browserPostJson: log endpoint + symbol + status + latency for ONE call.
async function q(tag, key, url, body) {
  const t = Date.now();
  const r = await browserPostJson(url, body);
  log(`  ${tag()} ${key.padEnd(9)} HTTP ${r.status} (${Date.now() - t}ms)`);
  return r;
}

for (let i = 0; i < rows.length; i++) {
  const [ca, depArg] = rows[i];
  const out = { ca };
  let symbol = ''; // fill sau response essential -> log các call sau co ten
  const tag = () => `${i + 1}/${rows.length} ${ca.slice(0, 8)}${symbol ? ':' + symbol : ''}`;
  log(`CA ${tag()} (chain=${chain})`);
  try {
    let dep = depArg;
    if (want.includes('essential') || !dep) {
      out.essential = await q(tag, 'essential', NANSEN_ESSENTIAL_DATA_URL, essentialDataBody(ca, chain));
      const r0 = (out.essential?.json?.data || [])[0];
      symbol = r0?.symbol || '';
      const ts = r0?.deployedTimestamp;
      if (ts && !dep) dep = Date.parse(ts);
      log(`  ${tag()} dep=${dep ? new Date(dep).toISOString() : '?'} symbol=${symbol || '?'}`);
    }
    out.symbol = symbol || null;
    out.dep = dep || null;
    if (want.includes('chart') && dep)
      out.chart = await q(
        tag,
        'chart',
        NANSEN_HOURLY_STATS_URL,
        hourlyStatsBody(ca, chain, {
          from: winFrom(dep, back),
          to: new Date().toISOString(),
        }),
      );
    // chartex = LF: label 'exchange', CUNG window dep-back..now nhu chart de
    // row ngay-anchor khop dung so hover app tab=exchanges (rule v5: LF =
    // gia tri exchange tai CUNG DATE voi anchor T100). Ref: KIWI 222.448M.
    // (Hourly-cut window cho gia tri khac: 09-04 daily=222.48M vs hourly=341M.)
    if (want.includes('chartex') && dep)
      out.chartEx = await q(
        tag,
        'chartex',
        NANSEN_HOURLY_STATS_URL,
        hourlyStatsBody(
          ca,
          chain,
          {
            from: winFrom(dep, back),
            to: new Date().toISOString(),
          },
          false,
          'exchange',
        ),
      );
    if (want.includes('gini'))
      out.gini = await q(tag, 'gini', NANSEN_HOLDERS_GINI_URL, holdersGiniBody(ca, chain));
    if (want.includes('volume'))
      out.volume = await q(tag, 'volume', NANSEN_VOLUME_DETAILS_URL, volumeDetailsBody(ca, chain));
    // Same endpoint, 3600s window — the 1H Volume column's source. Lets a live
    // check compare 1h vs 24h with the exact prod body builder.
    if (want.includes('volume1h'))
      out.volume1h = await q(tag, 'volume1h', NANSEN_VOLUME_DETAILS_URL, volumeDetailsBody(ca, chain, 3_600));
    if (want.includes('change'))
      out.change = await q(tag, 'change', NANSEN_HOLDERS_CHANGE_URL, holdersChangeBody(ca, chain));
    if (want.includes('balances'))
      out.balances = await q(tag, 'balances', NANSEN_HOLDERS_BALANCES_URL, holdersBalancesBody(ca, chain));
  } catch (e) {
    out.error = String(e?.message || e);
    log(`  ${tag()} ERROR ${out.error}`);
  }
  console.log(JSON.stringify(out));
  if (i < rows.length - 1) await sleep(2500);
}
log(`xong ${rows.length} CA sau ${el()}`);
// exitCode=0 khong du: socket fetch/websocket giu event loop song mai.
// Khong the exit(0) lien: stdout pipe >64KiB chua flush se bi cat. Exit sau
// khi write() callback bao toan bo du lieu da xuong os pipe.
process.stdout.write('', () => process.exit(0));

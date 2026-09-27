// Tổng USD một ví đã MUA một token trong N giờ gần nhất — cửa FREE
// app.nansen.ai/api/questions (0 credit), qua browserless Chrome đã clear CF.
//
// Bảng "Action" của /wallet-profiler-for-token chính là wp4t-transactions;
// wp4t-buy-sell trả cùng dữ liệu ở dạng event phẳng, không cần phân trang phức
// tạp. Mặc định dùng wp4t-buy-sell (1 call), --rows để xem chi tiết từng action.
//
// usage:
//   node server/scripts/nansen-wp4t-sum.mjs --wallet <W> --token <CA> [--hours 24]
//        [--rows] [--json] [--self-check]
// env: CRAWL_WS_ENDPOINT (default ws://localhost:3000)
//   docker run -d --name nansen-chrome -p 3000:3000 browserless/chrome:1.61-chrome-stable

import puppeteer from 'puppeteer-core';

const B = 'https://app.nansen.ai/api/questions/';
const WS = process.env.CRAWL_WS_ENDPOINT || 'ws://localhost:3000';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// --------------------------------------------------------------------------
// Pure (không network) — self-check chạy được offline.
// --------------------------------------------------------------------------

/** direction 1 = mua (khớp `txType: "buy"` của wp4t-transactions). */
export function sumBuyUsd(events, nowMs, windowMs) {
  return events
    .filter((e) => Number(e.direction) === 1)
    .filter((e) => Date.parse(e.blockTimestamp) >= nowMs - windowMs)
    .reduce((a, e) => a + (Number(e.valueUsd) || 0), 0);
}

/** wp4t-transactions rows -> {action, amount, usdAtTime, time} cho người đọc. */
export function toActionRows(rows) {
  return rows.map((r) => ({
    action: r.txType,
    amount: Number(r.directionalAmountOfTokens) || 0,
    usdAtTime: Number(r.usdValueAtTxTime) || 0,
    usdNow: Number(r.usdValueCurrent) || 0,
    time: r.blockTimestamp,
    tx: r.transactionHash,
  }));
}

function selfCheck() {
  const now = Date.parse('2026-09-17T07:28:26Z');
  const H = 3_600_000;
  const events = [
    { direction: 1, valueUsd: 100, blockTimestamp: '2026-09-16T08:36:13Z' }, // in, buy
    { direction: -1, valueUsd: 999, blockTimestamp: '2026-09-16T08:36:13Z' }, // sell -> skip
    { direction: 1, valueUsd: 500, blockTimestamp: '2026-09-15T00:00:00Z' }, // too old -> skip
    { direction: 1, valueUsd: 50, blockTimestamp: '2026-09-16T20:00:00Z' }, // in, buy
  ];
  const got = sumBuyUsd(events, now, 24 * H);
  if (got !== 150) throw new Error(`sumBuyUsd self-check: got ${got}, want 150`);
  const rows = toActionRows([
    { txType: 'buy', directionalAmountOfTokens: '2.5', usdValueAtTxTime: 10, usdValueCurrent: 12, blockTimestamp: 't', transactionHash: 'h' },
    { txType: 'sell', directionalAmountOfTokens: null, usdValueAtTxTime: undefined, usdValueCurrent: null, blockTimestamp: 't', transactionHash: 'h' },
  ]);
  if (rows[0].amount !== 2.5 || rows[0].usdAtTime !== 10 || rows[1].amount !== 0) {
    throw new Error('toActionRows self-check: mapping drifted');
  }
  console.log('self-check ok');
}

// --------------------------------------------------------------------------
// Network — browser CF-cleared, cùng transport với nansen-sidecar.mjs
// --------------------------------------------------------------------------

async function withPage(fn) {
  const browser = await puppeteer.connect({ browserWSEndpoint: WS, defaultViewport: { width: 1280, height: 800 } });
  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    await page.goto('https://app.nansen.ai/token-god-mode', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await new Promise((r) => setTimeout(r, 4_000));
    const post = (name, body) =>
      page.evaluate(
        async ({ url, body }) => {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
          });
          return { status: res.status, json: await res.json().catch(() => null) };
        },
        { url: B + name, body },
      );
    return await fn(post);
  } finally {
    await page.close();
    browser.disconnect();
  }
}

/** Mọi page của wp4t-transactions trong window (trần 100 row/call). */
async function fetchActionRows(post, { chain, wallet, token, from, to }) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const { status, json } = await post('wp4t-transactions', {
      parameters: {
        chain,
        paramWalletAddress: wallet,
        paramTokenAddress: token,
        datetimeFrom: from,
        datetimeTo: to,
        timeRange: { from, to },
      },
      filters: {},
      pagination: { page, recordsPerPage: 100 },
      order: { order: 'desc' },
    });
    if (status !== 200) throw new Error(`wp4t-transactions ${status}: ${JSON.stringify(json).slice(0, 200)}`);
    const rows = json?.data ?? [];
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

if (flag('self-check')) {
  selfCheck();
} else {
  const wallet = opt('wallet');
  const token = opt('token');
  const hours = Number(opt('hours', 24));
  const chain = opt('chain', 'solana');
  if (!wallet || !token) {
    console.error('usage: node server/scripts/nansen-wp4t-sum.mjs --wallet <W> --token <CA> [--hours 24] [--rows] [--json]');
    process.exit(2);
  }
  const now = Date.now();
  const from = new Date(now - hours * 3_600_000).toISOString();
  const to = new Date(now).toISOString();

  const rows = await withPage(async (post) => {
    if (flag('rows')) return fetchActionRows(post, { chain, wallet, token, from, to });
    const { status, json } = await post('wp4t-buy-sell', {
      parameters: {
        chain,
        tokenAddress: token,
        walletAddress: wallet,
        date: { from, to: new Date(now + 3_600_000).toISOString() },
        candleSize: '60',
      },
    });
    if (status !== 200) throw new Error(`wp4t-buy-sell ${status}: ${JSON.stringify(json).slice(0, 200)}`);
    return json?.data ?? [];
  });

  const total = flag('rows')
    ? rows.filter((r) => r.txType === 'buy').reduce((a, r) => a + (Number(r.usdValueAtTxTime) || 0), 0)
    : sumBuyUsd(rows, now, hours * 3_600_000);

  if (flag('json')) {
    console.log(JSON.stringify({ wallet, token, chain, hours, totalBuyUsd: total, rows: flag('rows') ? toActionRows(rows) : rows.map((r) => ({ time: r.blockTimestamp, direction: r.direction, usd: r.valueUsd, amount: r.value, dex: r.isDexTrade })) }, null, 2));
  } else {
    console.log(`wallet ${wallet}\ntoken  ${token}\nwindow last ${hours}h (${from} -> ${to})`);
    for (const r of flag('rows') ? toActionRows(rows) : rows) {
      console.log(
        flag('rows')
          ? `  ${r.time} ${String(r.action).padEnd(6)} amount=${r.amount} usdAtTime=${r.usdAtTime} usdNow=${r.usdNow}`
          : `  ${r.blockTimestamp} ${Number(r.direction) === 1 ? 'buy ' : 'sell'} amount=${r.value} usd=${r.valueUsd}`,
      );
    }
    console.log(`TOTAL BUY ${hours}h = ${total}`);
  }
}

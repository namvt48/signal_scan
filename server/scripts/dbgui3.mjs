// Try candidate token-page URL shapes; the shape that clears the "Validation
// error / Please use search" message is the one that renders a token page.
import puppeteer from 'puppeteer-core';

const WS = process.env.CRAWL_WS_ENDPOINT || 'ws://localhost:3000';
const CA = process.env.CA || 'FWDtiB5fXHdVAewPqvHPL2dh4aBC1C6GacQbePoQXKjz';
const BASE = 'https://app.nansen.ai';
const CANDIDATES = [
  `${BASE}/token-god-mode?tokenAddress=${CA}`,
  `${BASE}/token-god-mode?token=${CA}`,
  `${BASE}/token-god-mode?ca=${CA}`,
  `${BASE}/token-god-mode?search=${CA}`,
  `${BASE}/token-god-mode/${CA}`,
  `${BASE}/token-god-mode/sol/${CA}`,
  `${BASE}/token/${CA}`,
  `${BASE}/tokens/${CA}`,
];

const ERR = 'Validation error';
const browser = await puppeteer.connect({ browserWSEndpoint: WS, defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

for (const url of CANDIDATES) {
  let res = { url, ok: false, note: '' };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    await new Promise((r) => setTimeout(r, 5500));
    const info = await page.evaluate(() => {
      const re = /^(1H|1D|3D|7D|1W|1M|30D|3M|90D|6M|1Y|MAX|ALL)$/i;
      const nodes = [...document.querySelectorAll('button,[role="button"],[role="tab"],a,span,div')];
      const tfs = nodes.filter((n) => n.childElementCount <= 1 && re.test((n.textContent || '').trim())).slice(0, 30)
        .map((n) => ({ text: (n.textContent || '').trim(), disabled: n.disabled ?? null, aria: n.getAttribute('aria-disabled'), cls: (n.className || '').toString().slice(0, 60) }));
      return { url: location.href, hasErr: document.body.innerText.includes('Validation error'), body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 420), tfs };
    });
    res = { url, ok: !info.hasErr, note: `final=${info.url} tfs=${info.tfs.length} err=${info.hasErr}`, info };
  } catch (e) { res.note = `FAILED ${String(e).slice(0, 70)}`; }
  console.log(`\n${res.url}\n  ok=${res.ok} ${res.note}`);
  if (res.info) {
    console.log(`  body: ${res.info.body.slice(0, 300)}`);
    for (const t of res.info.tfs) console.log(`    TF "${t.text}" disabled=${t.disabled} aria=${t.aria} cls="${t.cls}"`);
    if (res.ok) { console.log('  >>> SUCCESS CANDIDATE'); break; }
  }
}
await page.close().catch(() => {});
process.stdout.write('', () => process.exit(0));

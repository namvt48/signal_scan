// Navigate the Nansen UI to a token page via the global search box, then read the
// chart's timeframe buttons and their enabled/disabled state.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const WS = process.env.CRAWL_WS_ENDPOINT || 'ws://localhost:3000';
const CA = process.env.CA || 'FWDtiB5fXHdVAewPqvHPL2dh4aBC1C6GacQbePoQXKjz';
const OUT = '/tmp/opencode';
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.connect({ browserWSEndpoint: WS, defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

const dumpTf = () => page.evaluate(() => {
  const re = /^(1H|1D|3D|7D|1W|1M|30D|3M|90D|6M|1Y|MAX|ALL)$/i;
  const nodes = [...document.querySelectorAll('button,[role="button"],[role="tab"],a,span,div,li')];
  const tfs = nodes.filter((n) => n.childElementCount <= 1 && re.test((n.textContent || '').trim())).slice(0, 40)
    .map((n) => ({ tag: n.tagName.toLowerCase(), text: (n.textContent || '').trim(), disabled: n.disabled ?? null, aria: n.getAttribute('aria-disabled'), cls: (n.className || '').toString().slice(0, 80) }));
  return { url: location.href, tfs, body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 900) };
});

await page.goto('https://app.nansen.ai/token-god-mode', { waitUntil: 'domcontentloaded', timeout: 45_000 });
await new Promise((r) => setTimeout(r, 7000));

// open search
let opened = false;
for (const sel of ['input[placeholder*="Search"]', 'input[type="search"]', 'input[type="text"]']) {
  const el = await page.$(sel);
  if (el) { await el.click().catch(() => {}); opened = true; break; }
}
if (!opened) {
  const btn = await page.$x?.("//*[contains(text(),'Search anything')]");
  console.log(`search input not found; xpath fallback=${btn?.length ?? 0}`);
  if (btn?.length) { await btn[0].click().catch(() => {}); opened = true; }
}
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: `${OUT}/ui-1-search-open.png` }).catch(() => {});

// type the CA
await page.keyboard.type(CA, { delay: 45 }).catch(() => {});
await new Promise((r) => setTimeout(r, 5000));
const afterType = await page.evaluate(() => {
  const items = [...document.querySelectorAll('[role="option"],[role="listitem"],li,a,div')]
    .filter((n) => n.childElementCount <= 2 && /FWD|Solana|SOL/i.test(n.textContent || ''))
    .slice(0, 15).map((n) => ({ tag: n.tagName.toLowerCase(), text: (n.textContent || '').trim().slice(0, 90), href: n.getAttribute('href') }));
  return { items, url: location.href };
});
console.log(`\nsearch dropdown items (${afterType.items.length}): ${JSON.stringify(afterType.items, null, 1)}`);
await page.screenshot({ path: `${OUT}/ui-2-typed.png` }).catch(() => {});

await page.keyboard.press('Enter').catch(() => {});
await new Promise((r) => setTimeout(r, 9000));
const after = await dumpTf();
console.log(`\n${'='.repeat(90)}\nafter Enter -> url=${after.url}`);
console.log(`TF-like elements (${after.tfs.length}):`);
for (const t of after.tfs) console.log(`  <${t.tag}> "${t.text}" disabled=${t.disabled} aria=${t.aria} cls="${t.cls}"`);
console.log(`body: ${after.body.slice(0, 700)}`);
await page.screenshot({ path: `${OUT}/ui-3-token.png`, fullPage: false }).catch(() => {});
await page.close().catch(() => {});
process.stdout.write('', () => process.exit(0));

// Scroll the token page to force lazy-mounted charts, then list every MUI toggle
// button with its enabled state and the full text of its button group, so the
// Balance chart's timeframe selector can be identified.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const WS = process.env.CRAWL_WS_ENDPOINT || 'ws://localhost:3000';
const CAS = JSON.parse(fs.readFileSync('/tmp/opencode/cas20.json', 'utf8'));
const now = Date.now();
const want = (process.env.SYMS || 'FWDI,ZCAT,LOCKINU,STONK').split(',');

const browser = await puppeteer.connect({ browserWSEndpoint: WS, defaultViewport: { width: 1440, height: 900 } });

for (const sym of want) {
  const c = CAS.find((x) => x.sym.includes(sym));
  if (!c) { console.log(`!! ${sym} not found`); continue; }
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  try {
    await page.goto(`https://app.nansen.ai/token-god-mode?tokenAddress=${c.ca}&chain=solana`, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    await new Promise((r) => setTimeout(r, 5000));
    // scroll to the bottom in steps to mount lazy charts
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.9)));
      await new Promise((r) => setTimeout(r, 1600));
    }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise((r) => setTimeout(r, 3500));
    const info = await page.evaluate(() => {
      const groups = new Map();
      for (const b of document.querySelectorAll('.MuiToggleButton-root')) {
        const grp = b.closest('.MuiToggleButtonGroup-root') || b.parentElement;
        const key = [...grp.querySelectorAll('.MuiToggleButton-root')].map((x) => (x.textContent || '').trim()).join('|');
        if (!groups.has(key)) groups.set(key, { labels: key, states: [] });
        groups.get(key).states.push({ text: (b.textContent || '').trim(), disabled: !!b.disabled, selected: /Mui-selected/.test(b.className || '') });
      }
      // any element (button or not) that carries a TF label
      const loose = [...document.querySelectorAll('button,[role="button"],span,div,li')]
        .filter((n) => n.childElementCount === 0 && /^(1h|1D|7D|30D|1M|3M|90D|1Y|Max|All|5m|6h|12h|24h)$/i.test((n.textContent || '').trim()))
        .slice(0, 60)
        .map((n) => ({ tag: n.tagName.toLowerCase(), text: (n.textContent || '').trim(), disabled: n.disabled ?? null, cls: (n.className || '').toString().slice(0, 70) }));
      const scrollH = document.body.scrollHeight, inner = window.innerHeight;
      return { groups: [...groups.values()], loose, scrollH, inner };
    });
    console.log(`\n${'='.repeat(96)}\n${c.sym}  age=${((now - c.d) / 864e5).toFixed(2)}d  pageHeight=${info.scrollH} viewport=${info.inner}`);
    console.log('  toggle groups:');
    for (const g of info.groups) console.log(`    [${g.labels}]  ->  ` + g.states.map((s) => `${s.text}${s.disabled ? '(x)' : ''}${s.selected ? '*' : ''}`).join(' '));
    console.log('  loose TF labels:');
    for (const l of info.loose) console.log(`    <${l.tag}> "${l.text}" disabled=${l.disabled} cls="${l.cls}"`);
  } catch (e) {
    console.log(`\n${sym} ERR ${String(e).slice(0, 90)}`);
  }
  await page.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
}
process.stdout.write('', () => process.exit(0));

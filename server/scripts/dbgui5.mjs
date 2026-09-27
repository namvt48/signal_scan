// Dump EVERY MUI toggle group + slider marks on the token page, labelled by the
// chart they belong to, for a few tokens of different ages. One fresh page per
// token (the shared page detaches on navigation).
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const WS = process.env.CRAWL_WS_ENDPOINT || 'ws://localhost:3000';
const CAS = JSON.parse(fs.readFileSync('/tmp/opencode/cas20.json', 'utf8'));
const now = Date.now();
const want = process.env.SYMS ? process.env.SYMS.split(',') : ['FWDI', 'ELON', 'ZCAT', 'LOCKINU', 'STONK'];

const browser = await puppeteer.connect({ browserWSEndpoint: WS, defaultViewport: { width: 1440, height: 1000 } });

for (const sym of want) {
  const c = CAS.find((x) => x.sym.includes(sym));
  if (!c) { console.log(`!! ${sym} not in cas20`); continue; }
  const ageD = ((now - c.d) / 864e5).toFixed(2);
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  try {
    await page.goto(`https://app.nansen.ai/token-god-mode?tokenAddress=${c.ca}&chain=solana`, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    await new Promise((r) => setTimeout(r, 6500));
    const info = await page.evaluate(() => {
      const label = (el) => {
        // walk up a few ancestors looking for a short heading-ish text
        let n = el, hops = 0;
        while (n && hops < 6) {
          const t = (n.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
          const head = t.find((s) => s.length <= 24 && !/^(Bought|Sold|5m|1h|6h|12h|24h|7D|1D|1M|Max|1Y|30D)$/.test(s));
          if (head && t.length > 1) return head;
          n = n.parentElement; hops++;
        }
        return '?';
      };
      const groups = [];
      const seen = new Set();
      for (const b of document.querySelectorAll('button,[role="button"]')) {
        if (!/MuiToggleButton/.test(b.className || '')) continue;
        const p = b.parentElement;
        if (seen.has(p)) continue;
        seen.add(p);
        groups.push({
          label: label(p),
          buttons: [...p.querySelectorAll('button,[role="button"]')].map((x) => ({ text: (x.textContent || '').trim(), disabled: !!x.disabled, selected: x.className.includes('Mui-selected') })),
        });
      }
      const marks = [...document.querySelectorAll('.MuiSlider-markLabel,.MuiSlider-mark')].map((m) => ({ label: (m.textContent || '').trim(), cls: (m.className || '').toString().slice(0, 60) }));
      return { url: location.href, groups, marks: marks.slice(0, 40) };
    });
    console.log(`\n${'='.repeat(96)}\n${c.sym}  age=${ageD}d  url=${info.url}`);
    for (const g of info.groups) {
      console.log(`  [${g.label}] ` + g.buttons.map((b) => `${b.text}${b.disabled ? '(x)' : ''}${b.selected ? '*' : ''}`).join(' '));
    }
    if (info.marks.length) console.log(`  slider marks: ` + info.marks.map((m) => `"${m.label}"`).join(' '));
  } catch (e) {
    console.log(`\n${c.sym} age=${ageD}d  ERR ${String(e).slice(0, 80)}`);
  }
  await page.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 700));
}
process.stdout.write('', () => process.exit(0));

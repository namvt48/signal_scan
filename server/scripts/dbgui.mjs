// Probe the Nansen app UI for the TF buttons and their enabled/disabled state,
// so the "highest enabled TF" rule can be read off the real UI instead of guessed.
import puppeteer from 'puppeteer-core';

const WS = process.env.CRAWL_WS_ENDPOINT || 'ws://localhost:3000';
const TF_RE = /^(1H|1D|3D|7D|1W|1M|30D|3M|90D|1Y|MAX|ALL|1y|7d)$/i;

const browser = await puppeteer.connect({ browserWSEndpoint: WS, defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

const urls = [
  'https://app.nansen.ai/token-god-mode',
  'https://app.nansen.ai/token-god-mode?address=FWDtiB5fXHdVAewPqvHPL2dh4aBC1C6GacQbePoQXKjz',
];
for (const url of urls) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch (e) { console.log(`goto ${url} FAILED ${String(e).slice(0, 90)}`); continue; }
  await new Promise((r) => setTimeout(r, 6000));
  const info = await page.evaluate((tfReSrc) => {
    const re = new RegExp(tfReSrc, 'i');
    const nodes = [...document.querySelectorAll('button,[role="button"],[role="tab"],a,span,div')];
    const tfs = nodes
      .filter((n) => n.childElementCount === 0 && re.test((n.textContent || '').trim()))
      .slice(0, 40)
      .map((n) => ({
        tag: n.tagName.toLowerCase(),
        text: (n.textContent || '').trim(),
        disabled: n.disabled ?? null,
        aria: n.getAttribute('aria-disabled'),
        cls: (n.className || '').toString().slice(0, 90),
        parentCls: (n.parentElement?.className || '').toString().slice(0, 60),
      }));
    const inputs = [...document.querySelectorAll('input')].map((n) => ({ ph: n.placeholder, type: n.type })).slice(0, 12);
    return { title: document.title, url: location.href, tfs, inputs, bodyText: document.body.innerText.slice(0, 600) };
  }, TF_RE.source);
  console.log(`\n${'='.repeat(90)}\nURL=${url}\n  -> title="${info.title}"  final=${info.url}`);
  console.log(`  TF-like elements (${info.tfs.length}):`);
  for (const t of info.tfs) console.log(`    <${t.tag}> "${t.text}" disabled=${t.disabled} aria=${t.aria} cls="${t.cls}" parent="${t.parentCls}"`);
  console.log(`  inputs: ${JSON.stringify(info.inputs)}`);
  console.log(`  body: ${info.bodyText.replace(/\n+/g, ' | ').slice(0, 400)}`);
}
await page.close().catch(() => {});
process.stdout.write('', () => process.exit(0));

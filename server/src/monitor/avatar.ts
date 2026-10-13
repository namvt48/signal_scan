import puppeteer, { type Browser, type Page } from 'puppeteer-core';

const IMAGE_SIZE = 224;
const CACHE_SIZE = 64;

export class DashboardAvatarRenderer {
  private readonly cache = new Map<string, Promise<Uint8Array>>();

  constructor(private readonly dashboardUrl: string, private readonly chromePressureUrl: string) {}

  render(symbol?: string): Promise<Uint8Array> {
    const letter = symbol?.slice(0, 1).toUpperCase() || '-';
    let image = this.cache.get(letter);
    if (image) return image;

    image = this.capture(letter);
    this.cache.set(letter, image);
    if (this.cache.size > CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    void image.catch(() => this.cache.delete(letter));
    return image;
  }

  private async capture(letter: string): Promise<Uint8Array> {
    const endpoint = new URL(this.chromePressureUrl);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    endpoint.pathname = '/';
    endpoint.hash = '';

    let browser: Browser | undefined;
    let page: Page | undefined;
    try {
      browser = await puppeteer.connect({ browserWSEndpoint: endpoint.toString() });
      page = await browser.newPage();
      await page.setViewport({ width: IMAGE_SIZE, height: IMAGE_SIZE, deviceScaleFactor: 1 });
      await page.goto(this.dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      await page.evaluate(async (avatarLetter) => {
        document.body.replaceChildren();
        document.body.style.cssText = 'margin:0;width:224px;height:224px;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#fff';
        const avatar = document.createElement('span');
        avatar.textContent = avatarLetter;
        avatar.style.cssText = 'box-sizing:border-box;width:56px;height:56px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.15);border-radius:16px;background:#1b2420;color:#d7fa4b;font-family:"Plus Jakarta Sans Variable",ui-sans-serif,system-ui,sans-serif;font-size:24px;font-weight:800;line-height:36px;transform:scale(4);transform-origin:center';
        document.body.append(avatar);
        await document.fonts.load('800 24px "Plus Jakarta Sans Variable"');
      }, letter);
      return new Uint8Array(await page.screenshot({ type: 'jpeg', quality: 90 }));
    } finally {
      try {
        await page?.close();
      } finally {
        browser?.disconnect();
      }
    }
  }
}

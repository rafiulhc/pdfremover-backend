// One shared headless Chromium for HTML -> PDF rendering.
const fs = require("fs");
const puppeteer = require("puppeteer-core");

function resolveChromiumPath(override) {
  if (override) return override;
  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch {} }
  return null;
}

function createBrowser({ chromiumPath, launch = (opts) => puppeteer.launch(opts) } = {}) {
  let browserPromise = null;

  function get() {
    if (!browserPromise) {
      browserPromise = launch({
        executablePath: resolveChromiumPath(chromiumPath) || undefined,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        headless: true,
      });
      browserPromise.catch(() => { browserPromise = null; });
    }
    return browserPromise;
  }

  async function close() {
    if (!browserPromise) return;
    try { (await browserPromise).close(); } catch {}
    browserPromise = null;
  }

  // The HTML comes from the request body, so it is untrusted. Block every network
  // request it makes (SSRF: e.g. cloud metadata at 169.254.169.254, internal services).
  async function htmlToPdf(html) {
    const browser = await get();
    const page = await browser.newPage();
    try {
      await page.setRequestInterception(true);
      page.on("request", (r) => {
        if (r.url().startsWith("data:")) r.continue();
        else r.abort();
      });
      await page.emulateMediaType("screen");
      await page.setContent(html, { waitUntil: "networkidle0" });
      return await page.pdf({
        format: "A4",
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: "0.4in", right: "0.4in", bottom: "0.4in", left: "0.4in" },
      });
    } finally {
      await page.close().catch(() => {});
    }
  }

  return { get, close, htmlToPdf };
}

module.exports = { createBrowser };

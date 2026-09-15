#!/usr/bin/env node
// Renders the README banner: docs/assets/artifact-site-banner.png (light) and
// artifact-site-banner-dark.png (dark), 2000×1000 on a transparent background, from the brand mark
// in src/app/icon.png and the wordmark set in Inter (fetched from Google Fonts while rendering,
// so the machine needs network access). Re-run after changing the copy below.
//
// No card: the mark, the wordmark and the wave sit directly on whichever page shows the image, and
// the wave fades out before the left and right edges, so the image has no visible boundary
// on GitHub in either colour scheme. A framed card with rounded corners read as a widget dropped
// onto the README, and its corners clipped the wave.
//
//   node scripts/readme-banner.mjs
//   E2E_CHROME=/path/to/chrome node scripts/readme-banner.mjs   # a Chrome other than the macOS default
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromePath = process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const icon = `data:image/png;base64,${readFileSync(path.join(root, "src/app/icon.png")).toString("base64")}`;

const copy = {
  tagline: "A shared home for AI-generated pages and documents,<br>on your own server.",
  sub: ["Open source", "Self-hosted", "Agent-ready"],
};

const themes = {
  light: {
    file: "artifact-site-banner.png",
    ink: "#171a17", tag: "#2f342f", sub: "#626862", rule: "#557341",
    wave: "#e4edc8", wave1: 0.9, wave2: 0.55,
  },
  dark: {
    file: "artifact-site-banner-dark.png",
    ink: "#f4f6f1", tag: "#d5dad1", sub: "#9ba398", rule: "#8fb46f",
    wave: "#557341", wave1: 0.28, wave2: 0.16,
  },
};

// The icon is a black mark on an opaque white square. Turn it into a tinted mark with a real alpha
// channel (alpha = inverted luminance), trimmed to its bounding box.
const cutMark = async (page, color) =>
  page.evaluate(async ([src, color]) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (let i = 0; i < d.data.length; i += 4) {
      const lum = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2];
      const a = Math.round(255 - lum);
      d.data[i] = r; d.data[i + 1] = g; d.data[i + 2] = b; d.data[i + 3] = a;
      if (a > 8) { const p = i / 4, x = p % c.width, y = (p - x) / c.width; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    }
    ctx.putImageData(d, 0, 0);
    const t = document.createElement("canvas");
    t.width = x1 - x0 + 1; t.height = y1 - y0 + 1;
    t.getContext("2d").drawImage(c, x0, y0, t.width, t.height, 0, 0, t.width, t.height);
    return t.toDataURL("image/png");
  }, [icon, color]);

/**
 * Fade the wave out over the outer 14% of each side, so the image has no visible left or right
 * edge on the page. Done on the pixels rather than with an SVG gradient mask: Chrome dithers
 * gradient masks, and that noise made the PNG seven times larger than it is with a clean ramp. Only
 * rows below the copy are touched (the wave and its accent line are the only things at the edges
 * there), so a longer tagline can never be eaten by the fade.
 */
const fadeEdges = async (page, png) =>
  Buffer.from((await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const band = Math.round(c.width * 0.14);
    const fromRow = Math.round(c.height * 0.62);
    for (let y = fromRow; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const edge = Math.min(x, c.width - 1 - x);
        if (edge >= band) continue;
        const k = edge / band;
        d.data[(y * c.width + x) * 4 + 3] = Math.round(d.data[(y * c.width + x) * 4 + 3] * k * k * (3 - 2 * k)); // smoothstep
      }
    }
    ctx.putImageData(d, 0, 0);
    return c.toDataURL("image/png").split(",")[1];
  }, `data:image/png;base64,${Buffer.from(png).toString("base64")}`)), "base64");

const html = (t, mark) => `<!doctype html><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;600;700&display=block" rel="stylesheet">
<style>
  html, body { margin: 0; background: transparent; }
  .card { position: relative; width: 1000px; height: 500px; box-sizing: border-box; overflow: hidden;
    background: transparent; font-family: Inter, sans-serif; }
  .card svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .stack { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .lockup { display: flex; align-items: center; gap: 26px; margin-top: -6px; }
  .lockup img { height: 76px; width: auto; display: block; }
  .name { font-size: 88px; font-weight: 700; letter-spacing: -0.035em; color: ${t.ink}; line-height: 1; margin-top: -2px; }
  .tag { margin-top: 34px; font-size: 27px; font-weight: 600; letter-spacing: -0.01em; color: ${t.tag}; line-height: 1.25; text-align: center; max-width: 900px; }
  .rule { width: 68px; height: 3px; border-radius: 2px; background: ${t.rule}; margin: 30px 0 24px; }
  .sub { font-size: 21px; font-weight: 500; letter-spacing: 0.005em; color: ${t.sub}; line-height: 1; }
  .sub span { padding: 0 12px; opacity: .55; }
</style>
<div class="card">
  <svg viewBox="0 0 1000 500" preserveAspectRatio="none" aria-hidden="true">
    <g>
      <path d="M-20 400 C 140 330, 260 470, 430 430 S 700 560, 1020 470 L 1020 520 L -20 520 Z" fill="${t.wave}" fill-opacity="${t.wave1}"/>
      <path d="M-20 450 C 160 390, 300 520, 480 470 S 780 560, 1020 500 L 1020 520 L -20 520 Z" fill="${t.wave}" fill-opacity="${t.wave2}"/>
      <path d="M-20 360 C 120 300, 220 420, 380 392" fill="none" stroke="${t.rule}" stroke-opacity="0.35" stroke-width="1.5"/>
    </g>
  </svg>
  <div class="stack">
    <div class="lockup"><img src="${mark}" alt=""><div class="name">artifact-site</div></div>
    <div class="tag">${copy.tagline}</div>
    <div class="rule"></div>
    <div class="sub">${copy.sub.join("<span>·</span>")}</div>
  </div>
</div>`;

const browser = await puppeteer.launch({
  executablePath: chromePath, headless: true,
  // Everything rendered here is hardcoded in this file, so the sandbox is dropped only where Chrome
  // cannot create one (CI containers), the same rule as the e2e tests. Keep it that way if the
  // script ever takes input from outside.
  args: [...(process.env.CI ? ["--no-sandbox"] : []), "--font-render-hinting=none", "--force-device-scale-factor=2"],
});
try {
  for (const t of Object.values(themes)) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 500, deviceScaleFactor: 2 });
    await page.setContent("<!doctype html><meta charset=utf-8>");
    const mark = await cutMark(page, t.ink);
    await page.setContent(html(t, mark), { waitUntil: "load" });
    // Inter is fetched from Google Fonts: wait for the font loads to settle, then poll until every
    // weight the banner uses is really available.
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(
      () => ["500 21px", "600 27px", "700 88px"].every((f) => document.fonts.check(`${f} Inter`)),
      { timeout: 30_000 },
    );
    const out = path.join(root, "docs/assets", t.file);
    writeFileSync(out, await fadeEdges(page, await page.screenshot({ omitBackground: true })));
    console.log(`wrote ${path.relative(root, out)}`);
    await page.close();
  }
} finally {
  await browser.close();
}

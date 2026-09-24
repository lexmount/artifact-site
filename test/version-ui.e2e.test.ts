import { describe, it, expect } from "vitest";
import puppeteer from "puppeteer-core";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const base = process.env.VIEWER_E2E_URL;
describe.skipIf(!base)("version UI deployed acceptance", () => {
  it("uses the same upload panel from library list/grid, viewer and history", async () => {
    const browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless:true, args:process.env.CI?["--no-sandbox"]:[] });
    const page = await browser.newPage(), dir = mkdtempSync(path.join(tmpdir(),"version-e2e-"));
    writeFileSync(path.join(dir,"report.html"),"<h1>Updated report</h1>");
    let slug = "";
    try {
      await page.setViewport({width:1440,height:900}); await page.setExtraHTTPHeaders({"accept-language":"en-US"}); await page.goto(base!,{waitUntil:"networkidle2"});
      expect(await page.$('a[href="/me?intent=update"]')).not.toBeNull();
      const created = await page.evaluate(async()=>{const r=await fetch('/api/sites',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'paste',title:'Version acceptance report',html:'<h1>Original report</h1>'})});const s=await r.json();localStorage.setItem(`sites:editToken:${s.slug}`,s.editToken);return s;}); slug=created.slug;
      const text = async (value:string) => { await page.waitForFunction(v=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent?.trim()===v),{},value); await page.evaluate(v=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent?.trim()===v)!.click(),value); };
      await page.goto(`${base}/me?intent=update`,{waitUntil:"networkidle2"}); await page.waitForSelector(`[data-slug="${slug}"] .row-more`); expect(await page.$('.update-intent')).not.toBeNull();
      await page.click(`[data-slug="${slug}"] .row-more`); await text('Upload new version'); await page.waitForSelector('dialog[open]'); expect(await page.$eval('dialog strong',e=>e.textContent)).toBe('Version acceptance report');
      await (await page.$('dialog input[type=file]'))!.uploadFile(path.join(dir,'report.html')); await page.waitForSelector('dialog footer .solid:not(:disabled)'); await page.click('dialog footer .solid'); await page.waitForSelector('dialog a.solid');
      const href=await page.$eval('dialog a.solid',e=>e.getAttribute('href')); expect(href).toContain(`/s/${slug}?version=`);
      const versions=await page.evaluate(async s=>(await (await fetch(`/api/sites/${s}/versions`)).json()).versions,slug); expect(versions).toHaveLength(2); expect(versions.some((v:{id:string})=>v.id===created.versionId)).toBe(true);
      await text('Done'); await page.click('button[aria-label="Grid view"]'); await page.waitForSelector('.result-grid .more-button'); await page.click('.result-grid .more-button'); await text('Upload new version'); await page.waitForSelector('dialog[open]'); await text('Cancel');
      await page.goto(`${base}/s/${slug}`,{waitUntil:'networkidle2'}); expect(await page.$('.fs-bar .brand img')).not.toBeNull(); expect(await page.$('.share-hint')).toBeNull();
      await page.click('.fs-bar button[aria-label="More"]'); await text('Upload new version'); await page.waitForSelector('dialog[open]'); await text('Cancel');
      await page.click('.fs-bar button[aria-label="More"]'); await text('Version history'); await page.waitForSelector('.drawer'); await text('Upload new version'); await page.waitForSelector('dialog[open]');
      if(process.env.E2E_SCREENSHOT_DIR){mkdirSync(process.env.E2E_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.E2E_SCREENSHOT_DIR,'version-upload-desktop.png')});}
      await page.setViewport({width:390,height:844}); expect(await page.$eval('dialog',e=>e.getBoundingClientRect().width)).toBeLessThanOrEqual(390);
    } finally {
      if(slug) await page.evaluate(async s=>fetch(`/api/sites/${s}`,{method:'DELETE'}),slug).catch(()=>{});
      await browser.close();rmSync(dir,{recursive:true,force:true});
    }
  },60000);
});

import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { upsertUser, createId, closeDbForTests } from "@/lib/db";
import { createSite } from "@/lib/sites";
import { mintSession } from "@/lib/session";
import { createComment, replyComment } from "@/lib/comments/service";
const url = process.env.NOTIFICATIONS_E2E_URL;
describe.skipIf(!url)("notification browser acceptance", () => {
  afterAll(closeDbForTests);
  it("opens the drawer, follows the reply deep link, and fits a mobile viewport", async () => {
    process.env.ARTIFACT_DATA_DIR = resolve(".data/notification-preview");
    process.env.ARTIFACT_PUBLIC_URL = url!;
    process.env.ARTIFACT_DEFAULT_VISIBILITY = "public";
    const owner = await upsertUser({
      authProvider: "notification-browser",
      providerSubject: createId("user"),
      displayName: "余一",
      emailVerified: true,
    });
    const reader = await upsertUser({
      authProvider: "notification-browser",
      providerSubject: createId("user"),
      displayName: "林晓",
      emailVerified: true,
    });
    const cookie = (
        await mintSession(new Request(url!), owner.id)
      ).cookie.split(";")[0],
      other = (await mintSession(new Request(url!), reader.id)).cookie.split(
        ";",
      )[0];
    const req = (value: string) =>
      new Request(url!, { headers: { cookie: value, origin: url! } });
    const { site } = await createSite(
      {
        mode: "paste",
        title: "产品使用指南",
        html: '<!doctype html><html><body style="font:20px system-ui;margin:64px;background:#f3f5ef;color:#171a17"><h1>产品使用指南</h1><p>团队可以直接在产物上讨论，并收到新回复通知。</p></body></html>',
      },
      { ownerId: owner.id },
    );
    const root = await createComment(req(cookie), site.slug, {
      scope: {
        siteId: site.id,
        versionId: site.currentVersionId,
        entry: { kind: "main" },
      },
      anchor: { schemaVersion: 1, kind: "document", filePath: "index.html" },
      body: "这里是否可以增加一个对比示例？",
      clientRequestId: randomUUID(),
    });
    const reply = await replyComment(
      req(other),
      site.slug,
      root.detail.thread.id,
      {
        body: "这里建议补充一个对比示例，帮助新用户理解两种方案的差异。",
        clientRequestId: randomUUID(),
      },
    );
    const { default: puppeteer } = await import("puppeteer-core");
    const browser = await puppeteer.launch({
      executablePath:
        process.env.E2E_CHROME ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
    try {
      await browser
        .defaultBrowserContext()
        .setCookie(
          {
            name: cookie.slice(0, cookie.indexOf("=")),
            value: cookie.slice(cookie.indexOf("=") + 1),
            domain: new URL(url!).hostname,
            path: "/",
          },
          {
            name: "locale",
            value: "zh-CN",
            domain: new URL(url!).hostname,
            path: "/",
          },
        );
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 1000 });
      page.setDefaultTimeout(60000);
      const errors: string[] = [];
      page.on("pageerror", (e) => {
        errors.push(String(e));
        console.error(String(e));
      });
      page.on("console", (m) => {
        if (m.type() === "error") console.error(m.text());
      });
      await page.goto(url!);
      await page.waitForSelector(".notification-bell");
      await page.click(".notification-bell");
      await page.waitForSelector(".notification-row a");
      await page.waitForFunction(() =>
        document
          .querySelector(".notification-drawer")
          ?.getAnimations()
          .every((a) => a.playState === "finished"),
      );
      await mkdir("output/acceptance", { recursive: true });
      await page.screenshot({
        path: "output/acceptance/notification-drawer.png",
      });
      await page.click(".notification-row a");
      await page.waitForFunction(() =>
        location.pathname.startsWith("/notifications/"),
      );
      await page
        .waitForSelector(`[data-message-id="${reply.id}"]`)
        .catch(async (e) => {
          console.error(await page.$eval("body", (e) => e.innerText));
          await page.screenshot({
            path: "output/acceptance/notification-failure.png",
          });
          throw e;
        });
      await vi.waitFor(
        async () =>
          expect(
            await page.$eval(`[data-message-id="${reply.id}"]`, (el) => {
              const r = el.getBoundingClientRect();
              return r.top >= 0 && r.top < innerHeight;
            }),
          ).toBe(true),
        { timeout: 30000 },
      );
      await page.waitForSelector(
        '.discussion-follow button[aria-pressed="true"]',
      );
      await page.screenshot({
        path: "output/acceptance/notification-reply.png",
      });
      await vi.waitFor(
        async () =>
          expect(
            await page.evaluate(async () => {
              const p = await fetch("/api/notifications?badge=1");
              return (await p.json()).hasUnread;
            }),
          ).toBe(false),
        { timeout: 10000 },
      );
      await page.evaluate(()=>{const buttons=Array.from(document.querySelectorAll("button"));const reply=buttons.find(button=>button.textContent?.trim()==="回复");if(!reply)throw new Error("Reply button missing");reply.click();});
      await page.waitForSelector(".comment-mention-picker > button");
      await page.click(".comment-mention-picker > button");
      await page.waitForSelector('.comment-mention-menu [role="option"]');
      await page.keyboard.press("Escape");
      await page.type("textarea", "你好@");
      await page.waitForSelector('.comment-mention-menu [role="option"]');
      await page.screenshot({path:"output/acceptance/mention-picker.png"});
      await page.keyboard.press("Enter");
      await page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>("textarea")?.value.includes("@林晓"));
      await page.type("textarea","请补充示例");
      await page.keyboard.down("Control");await page.keyboard.press("Enter");await page.keyboard.up("Control");
      await page.waitForSelector(".comment-message .comment-mention");
      expect(await page.$eval(".comment-message .comment-mention",el=>{const sample=document.createElement("span");sample.style.color="var(--focus)";document.body.append(sample);const expected=getComputedStyle(sample).color;sample.remove();return getComputedStyle(el).color===expected;})).toBe(true);
      await page.screenshot({path:"output/acceptance/mention-comment.png"});
      await page.goto(url!);
      await page.setViewport({
        width: 390,
        height: 844,
        isMobile: true,
        hasTouch: true,
      });
      await page.click(".notification-bell");
      await page.waitForSelector(".notification-row a");
      expect(
        await page.$eval(
          ".notification-drawer",
          (el) => el.getBoundingClientRect().width <= innerWidth,
        ),
      ).toBe(true);
      await page.waitForFunction(() =>
        document
          .querySelector(".notification-drawer")
          ?.getAnimations()
          .every((a) => a.playState === "finished"),
      );
      await page.screenshot({
        path: "output/acceptance/notification-mobile.png",
      });
      await page.keyboard.press("Escape");
      await page.waitForSelector(".notification-drawer", { hidden: true });
      expect(
        await page.$eval(
          ".notification-bell",
          (el) => el === document.activeElement,
        ),
      ).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 120000);
});

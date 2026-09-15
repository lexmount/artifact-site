// The translation core: English is the key, a missing entry is English (never blank), placeholders
// are filled by name, and locale resolution prefers an explicit choice over Accept-Language.
import { afterEach, describe, expect, it } from "vitest";
import { __resetMessagesForTests, interpolate, registerMessages, resolveLocale, translate, translatorFor } from "@/lib/i18n";
import { relTime } from "@/lib/rel-time";

afterEach(() => __resetMessagesForTests());

describe("translate", () => {
  it("returns the key itself for English and for any untranslated string", () => {
    registerMessages("zh-CN", { Upload: "上传" });
    expect(translate("en", "Upload")).toBe("Upload");
    expect(translate("zh-CN", "Upload")).toBe("上传");
    expect(translate("zh-CN", "Not in the dictionary")).toBe("Not in the dictionary");
  });

  it("merges dictionaries registered in several calls (one file per feature area)", () => {
    registerMessages("zh-CN", { A: "甲" });
    registerMessages("zh-CN", { B: "乙" });
    const t = translatorFor("zh-CN");
    expect([t("A"), t("B")]).toEqual(["甲", "乙"]);
  });

  it("fills {name} placeholders and leaves unknown ones visible", () => {
    expect(interpolate("{n} files, {size}", { n: 3, size: "2 MB" })).toBe("3 files, 2 MB");
    expect(interpolate("hello {who}", {})).toBe("hello {who}");
    registerMessages("zh-CN", { "{n} files": "{n} 个文件" });
    expect(translate("zh-CN", "{n} files", { n: 7 })).toBe("7 个文件");
  });
});

describe("resolveLocale", () => {
  it("explicit choice wins, then Accept-Language, then English", () => {
    expect(resolveLocale("zh-CN", "en-US")).toBe("zh-CN");
    expect(resolveLocale("zh", null)).toBe("zh-CN");
    expect(resolveLocale(null, "zh-TW,zh;q=0.9,en;q=0.8")).toBe("zh-CN"); // via the bare "zh"
    expect(resolveLocale(null, "zh-TW,en;q=0.8")).toBe("en");              // Traditional has no dictionary
    expect(resolveLocale("zh-HK", null)).toBe("en");
    expect(resolveLocale("zh-Hans-CN", null)).toBe("zh-CN");
    expect(resolveLocale(null, "fr-FR,fr;q=0.9,en;q=0.5")).toBe("en");
    expect(resolveLocale("klingon", "de")).toBe("en");
    expect(resolveLocale(undefined, undefined)).toBe("en");
  });
});

describe("relTime", () => {
  const t = translatorFor("en");
  const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);

  it("uses the singular for exactly one unit and the plural otherwise", () => {
    expect(relTime(now - 30_000, t, "en", now)).toBe("Just now");
    expect(relTime(now - MIN, t, "en", now)).toBe("1 minute ago");
    expect(relTime(now - 5 * MIN, t, "en", now)).toBe("5 minutes ago");
    expect(relTime(now - HOUR, t, "en", now)).toBe("1 hour ago");
    expect(relTime(now - 3 * HOUR, t, "en", now)).toBe("3 hours ago");
    expect(relTime(now - DAY, t, "en", now)).toBe("1 day ago");
    expect(relTime(now - 2 * DAY, t, "en", now)).toBe("2 days ago");
  });

  it("falls back to the calendar date after 30 days", () => {
    expect(relTime(now - 45 * DAY, t, "en", now)).toBe("12/1/2025");
  });
});

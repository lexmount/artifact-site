// The translation core: English is the key, a missing entry is English (never blank), placeholders
// are filled by name, and locale resolution prefers an explicit choice over Accept-Language.
import { afterEach, describe, expect, it } from "vitest";
import { __resetMessagesForTests, interpolate, registerMessages, resolveLocale, translate, translatorFor } from "@/lib/i18n";

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

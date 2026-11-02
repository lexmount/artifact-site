import { afterEach, expect, it } from "vitest";
import { getStorage, storageKey, __resetStorageForTests } from "@/lib/storage";
import { u8 } from "./helpers";
afterEach(__resetStorageForTests);

it("keeps package path policy isolated from default website storage", async () => {
  const packages = getStorage("package"), websites = getStorage();
  for (const name of [".git/config", "node_modules/lib/app.js"]) {
    await packages.writeFileToVersion("site_pkg", "ver_pkg", name, u8("data"));
    expect(Buffer.from(await packages.read("site_pkg", "ver_pkg", name)).toString()).toBe("data");
    expect((await packages.readRange("site_pkg", "ver_pkg", name, 0, 1)).total).toBe(4);
    expect(await packages.sizeOf("site_pkg", "ver_pkg", name)).toBe(4);
    await expect(websites.read("site_pkg", "ver_pkg", name)).rejects.toThrow();
    await expect(websites.writeFileToVersion("site_old", "ver_old", name, u8("x"))).rejects.toThrow();
    expect(storageKey("site_pkg", "ver_pkg", name, "package")).toBe(`sites/site_pkg/ver_pkg/${name}`);
  }
  await packages.copyVersionTree("site_pkg", "ver_pkg", "ver_copy");
  expect(await packages.list("site_pkg", "ver_copy")).toEqual([".git/config", "node_modules/lib/app.js"]);
  for (const name of ["../escape", "/etc/passwd", "a/../../b", "a\0b", "C:/windows", "a/./b"]) {
    await expect(packages.writeFileToVersion("site_pkg", "ver_pkg", name, u8("x"))).rejects.toThrow();
  }
});

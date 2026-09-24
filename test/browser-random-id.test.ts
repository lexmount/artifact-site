import { afterEach, expect, it, vi } from "vitest";
import { browserRandomId } from "@/lib/browser-random-id";
afterEach(()=>vi.unstubAllGlobals());
it("uses native UUIDs when available",()=>{
  vi.stubGlobal("crypto",{randomUUID:()=>"native-id"});
  expect(browserRandomId()).toBe("native-id");
});
it("creates a UUID with secure random bytes on HTTP origins",()=>{
  const getRandomValues=vi.fn((bytes:Uint8Array)=>{bytes.fill(255);return bytes;});
  vi.stubGlobal("crypto",{getRandomValues});
  expect(browserRandomId()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  expect(getRandomValues).toHaveBeenCalledOnce();
});

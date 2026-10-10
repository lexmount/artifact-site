import { afterEach, expect, it, vi } from "vitest";
import { safeReturn, viewerFamily } from "@/lib/viewer-return";
afterEach(() => vi.unstubAllEnvs());
it("preserves list filters and search but skips versions and editor loops", () => {
  const current = "https://example.com/s/demo?version=2";
  expect(safeReturn("/me?tab=owned&q=report#list", current)).toBe("/me?tab=owned&q=report#list");
  expect(safeReturn("/s/demo?version=1", current)).toBeNull();
  expect(safeReturn("/s/demo/edit", current)).toBeNull();
  expect(safeReturn("https://other.example/me", current)).toBeNull();
  expect(safeReturn("/api/sites", current)).toBeNull();
  expect(safeReturn("", current)).toBeNull();
});
it("stays within the configured mount", () => {
  vi.stubEnv("NEXT_PUBLIC_ARTIFACT_BASE_PATH", "/artifact-site");
  const current = "https://example.com/artifact-site/s/demo";
  expect(viewerFamily(current)).toBe("/s/demo");
  expect(safeReturn("/me", current)).toBeNull();
  expect(safeReturn("/artifact-site/?q=x", current)).toBe("/artifact-site/?q=x");
  expect(safeReturn("/artifact-site/api/sites", current)).toBeNull();
});

it("restores the target entry before considering the page just left", async () => {
  const { entryTrail } = await import("@/lib/viewer-return");
  const a = "https://example.com/s/a", b = "https://example.com/s/b";
  const fromList = entryTrail(a, undefined, undefined, {href:"https://example.com/me?q=report",trail:[]});
  const fromA = entryTrail(b, undefined, undefined, {href:a,trail:fromList});
  expect(fromA).toEqual(['/s/a','/me?q=report']);
  expect(entryTrail(a, {family:'/s/a',trail:fromList}, undefined, {href:b,trail:fromA})).toEqual(fromList);
  expect(entryTrail(a, undefined, fromA.slice(1), {href:b,trail:fromA})).toEqual(fromList);
  expect(entryTrail(b, {family:'/s/b',trail:fromA}, undefined, {href:a,trail:fromList})).toEqual(fromA);
  expect(entryTrail(a, undefined, undefined, null)).toEqual([]);
});

it("hands language navigation its chain once without needing a Referer", async () => {
  const { prepareViewerNavigation, takeViewerHandoff } = await import("@/lib/viewer-return");
  const stored = new Map<string, string>();
  vi.stubGlobal('window', {location:{href:'https://example.com/s/a?lang=en'}});
  vi.stubGlobal('history', {state:{artifactViewerReturn:{family:'/s/a',trail:['/me?q=report']}}});
  vi.stubGlobal('sessionStorage', {getItem:(key:string)=>stored.get(key) ?? null,setItem:(key:string,value:string)=>stored.set(key,value),removeItem:(key:string)=>stored.delete(key)});
  try {
    prepareViewerNavigation('https://example.com/s/a');
    expect(takeViewerHandoff('https://example.com/s/a')).toEqual(['/me?q=report']);
    expect(takeViewerHandoff('https://example.com/s/a')).toBeUndefined();
    prepareViewerNavigation('https://example.com/s/a');
    expect(takeViewerHandoff('https://example.com/s/a?version=other')).toBeUndefined();
  } finally { vi.unstubAllGlobals(); }
});

it("supports consecutive client returns when session storage is unavailable", async () => {
  const { prepareViewerNavigation, takeViewerHandoff } = await import("@/lib/viewer-return");
  vi.stubGlobal('window', {location:{href:'https://example.com/s/b'}});
  vi.stubGlobal('history', {state:{artifactViewerReturn:{family:'/s/b',trail:['/s/a','/me']}}});
  vi.stubGlobal('sessionStorage', {getItem:()=>{throw new Error('Blocked');},setItem:()=>{throw new Error('Blocked');},removeItem:()=>{throw new Error('Blocked');}});
  try {
    prepareViewerNavigation('https://example.com/s/a', true);
    expect(takeViewerHandoff('https://example.com/s/a')).toEqual(['/me']);
  } finally { vi.unstubAllGlobals(); }
});

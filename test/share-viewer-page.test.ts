// /v/<token> — the reader-side page: what it renders, what its share card says, and whether it
// records a view.
//
// The page is an async server component; vitest runs in node with no DOM, so it is awaited
// directly here to obtain the React element tree, which is then walked. This works only because
// every branch of the page is assembled from plain functions that return elements (not nested
// components) — the element tree is fully materialised, copy and iframe src included, so the
// assertions land on the real output rather than on source strings.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, createId, createShare, listShareViews, softDeleteSite, upsertUser } from "@/lib/db";
import { flushAfterResponseForTests } from "@/lib/after-response";
import { createSite } from "@/lib/sites";
import { mintSession } from "@/lib/session";
import { buildPasscodeCookie, createPasscode, createShareToken, hashPasscode, hashToken } from "@/lib/share";
import { platformCopy as rootMetadata } from "@/lib/platform-copy";
import type { Share, SharePolicy, Site } from "@/lib/types";

const ORIGIN = "https://artifacts.example.net";

/** The page and generateMetadata see the request only through next/headers. Keep it mutable: one set of headers per test case. */
let pageHeaders = new Headers();
// `cookies` too: the page's copy is resolved through getT(), which reads the locale cookie. No
// cookie and no Accept-Language → English, which is what every assertion below is written in.
vi.mock("next/headers", () => ({
  headers: async () => pageHeaders,
  cookies: async () => ({ get: () => undefined }),
}));

// Must be imported dynamically after vi.mock, otherwise the page module binds the real next/headers first.
const page = await import("@/app/v/[token]/page");
const { default: SharedViewPage, generateMetadata } = page;

const dirs: string[] = [];
let seq = 0;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "ah-share-view-"));
  dirs.push(dir);
  process.env.ARTIFACT_DATA_DIR = dir;
  process.env.ARTIFACT_PUBLIC_URL = ORIGIN;
  process.env.ARTIFACT_ENFORCE_OWNERSHIP = "on";
  process.env.ARTIFACT_OIDC_ISSUER = "https://idp.example/oidc";
  process.env.ARTIFACT_OIDC_CLIENT_ID = "cid";
  process.env.ARTIFACT_OIDC_CLIENT_SECRET = "secret";
  pageHeaders = new Headers({ host: "artifacts.example.net", "x-forwarded-proto": "https" });
});

afterEach(async () => {
  vi.useRealTimers();
  await flushAfterResponseForTests(); // any stray deferred view-log write lands before the DB closes
  await closeDbForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of [
    "ARTIFACT_DATA_DIR", "ARTIFACT_PUBLIC_URL", "ARTIFACT_ENFORCE_OWNERSHIP",
    "ARTIFACT_OIDC_ISSUER", "ARTIFACT_OIDC_CLIENT_ID", "ARTIFACT_OIDC_CLIENT_SECRET",
  ]) delete process.env[key];
});

// --- harness ------------------------------------------------------------------

/** Load what the browser would send into the header bag next/headers sees. */
function visit(opts: { cookies?: string[]; ip?: string; userAgent?: string } = {}) {
  const bag = new Headers({ host: "artifacts.example.net", "x-forwarded-proto": "https" });
  const jar = (opts.cookies ?? []).filter(Boolean).join("; ");
  if (jar) bag.set("cookie", jar);
  if (opts.ip) bag.set("x-real-ip", opts.ip);
  if (opts.userAgent) bag.set("user-agent", opts.userAgent);
  pageHeaders = bag;
}

// The page defers logShareView past the response (afterResponse); outside a Next request scope
// that runs as a tracked fire-and-forget. Flushing here keeps every assertion — and the collapse
// semantics of back-to-back renders — deterministic.
const render = async (token: string, e?: string) => {
  const tree = await SharedViewPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve(e ? { e } : {}) });
  await flushAfterResponseForTests();
  return tree;
};

const meta = (token: string) => generateMetadata({ params: Promise.resolve({ token }) });

async function signIn(displayName: string, email?: string) {
  const address = email ?? `${displayName.toLowerCase()}${++seq}@corp.example`;
  const user = await upsertUser({
    authProvider: "test", providerSubject: `sub_${displayName}_${++seq}`,
    email: address, emailVerified: true, displayName,
  });
  const { cookie } = await mintSession(new Request(`${ORIGIN}/`, { headers: { "x-forwarded-proto": "https" } }), user.id);
  return { id: user.id, cookie: cookie.split(";")[0], email: address };
}

const HTML = '<html><head><title>季度经营分析</title><meta name="description" content="2026 上半年 RSI 复盘"></head><body>x</body></html>';

async function publish(html = HTML): Promise<Site> {
  return (await createSite({ mode: "paste", html }, {})).site;
}

/** Create the share row directly — this file tests the reader's page; the minting route is covered by share-links.test.ts. */
async function shareOf(
  site: Site,
  policy: SharePolicy,
  opts: { passcode?: string; expiresAt?: number | null; revoked?: boolean; allowAi?: boolean } = {},
): Promise<{ token: string; share: Share; passcode?: string }> {
  const token = createShareToken();
  const passcode = policy === "passcode" ? opts.passcode ?? createPasscode() : undefined;
  const share = await createShare({
    id: createId("shr"),
    siteId: site.id,
    tokenHash: hashToken(token),
    policy,
    passcodeHash: passcode ? hashPasscode(passcode) : null,
    label: null,
    createdBy: null,
    createdAnonId: null,
    expiresAt: opts.expiresAt ?? null,
    allowAi: opts.allowAi ?? false,
  });
  return { token, share, passcode };
}

// --- element-tree helpers ------------------------------------------------------

type Node = { type?: unknown; props?: Record<string, unknown> } | string | number | null | undefined | boolean | Node[];

/** All visible text in the tree, joined into one string. */
function textOf(node: Node): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const props = (node as { props?: Record<string, unknown> }).props;
  return props ? textOf(props.children as Node) : "";
}

/** Every element in the tree (including host elements such as <iframe> and <form>). */
function elements(node: Node, out: { type: unknown; props: Record<string, unknown> }[] = []) {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
    return out;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type !== undefined) out.push({ type: el.type, props: el.props ?? {} });
  if (el.props) elements(el.props.children as Node, out);
  return out;
}

const hostTags = (node: Node, tag: string) =>
  elements(node).filter((el) => el.type === tag).map((el) => el.props);

/** Every navigation target in the tree (href / action / src), used to prove negatives such as "there is no edit entry point". */
function links(node: Node): string[] {
  return elements(node)
    .flatMap((el) => [el.props.href, el.props.action, el.props.src])
    .filter((v): v is string => typeof v === "string");
}

// --- share card ---------------------------------------------------------------

describe("generateMetadata — the card for each of the four policies", () => {
  it("public: uses the artifact's own title and description", async () => {
    const site = await publish();
    const { token } = await shareOf(site, "public");
    const m = await meta(token);

    expect(m.title).toBe("季度经营分析 — artifact-site");
    expect(m.description).toBe("2026 上半年 RSI 复盘");
    // og/twitter descriptions are left unset so Next derives them from the one above — they do not accept null.
    expect(m.openGraph?.description).toBeUndefined();
    expect(m.alternates?.canonical).toBe(`${ORIGIN}/v/${token}`);
  });

  it("public with an artifact that wrote no description: explicit null, never the platform tagline", async () => {
    const site = await publish("<html><head><title>没写描述的产物</title></head><body>x</body></html>");
    const { token } = await shareOf(site, "public");
    const m = await meta(token);

    expect(m.description).toBeNull();
    // Next treats undefined as "inherit", so the assertion must be on null: with toBeUndefined()
    // the version that still leaked the platform tagline would pass too.
    expect(m.description).not.toBeUndefined();
    expect(JSON.stringify(m)).not.toContain(rootMetadata.description);
  });

  it("the three protected policies: the title is still given, the description describes the gate rather than the artifact", async () => {
    const site = await publish();
    const expected: Record<string, string> = {
      login: "Protected content, visible after signing in · artifact-site",
      people: "Protected content, visible to invited members only · artifact-site",
      passcode: "Protected content, passcode required · artifact-site",
    };

    for (const policy of ["login", "people", "passcode"] as const) {
      const { token } = await shareOf(site, policy);
      const m = await meta(token);

      expect(m.title).toBe("季度经营分析 — artifact-site");
      expect(m.description).toBe(expected[policy]);
      // The crawler fetching the preview is anonymous; not one word of the artifact's own description may reach this card.
      expect(JSON.stringify(m)).not.toContain("2026 上半年 RSI 复盘");
      expect(JSON.stringify(m)).not.toContain(rootMetadata.description);
    }
  });

  it("revoked / expired / never existed / site deleted — one card for all four, and the description is null", async () => {
    const site = await publish();
    const revoked = await shareOf(site, "public");
    await (await import("@/lib/db")).revokeShare(revoked.share.id, Date.now());
    const expired = await shareOf(site, "public", { expiresAt: Date.now() - 1000 });

    const gone = await publish();
    const orphan = await shareOf(gone, "public");
    await softDeleteSite(gone.id);

    for (const token of [revoked.token, expired.token, orphan.token, "never-existed"]) {
      const m = await meta(token);
      expect(m.title).toBe("This link is no longer valid — artifact-site");
      expect(m.description).toBeNull();
      expect(m.description).not.toBeUndefined();
      expect(JSON.stringify(m)).not.toContain(rootMetadata.description);
      expect(JSON.stringify(m)).not.toContain("季度经营分析"); // not even the site title may leak
    }
  });
});

// --- the page itself ----------------------------------------------------------

describe("/v/<token> rendering", () => {
  it("when admitted it is a read-only artifact: the iframe points at preview, with no edit/version/share/save-as entry point", async () => {
    const site = await publish();
    const { token } = await shareOf(site, "public");
    visit();
    const tree = await render(token);

    const frames = hostTags(tree, "iframe");
    expect(frames).toHaveLength(1);
    expect(frames[0].src).toBe(`/api/preview/${site.slug}?share=${token}`);
    // The sandbox is identical to the owner's page — in particular, no allow-same-origin.
    expect(frames[0].sandbox).toBe("allow-forms allow-modals allow-scripts allow-popups allow-downloads");

    const text = textOf(tree);
    for (const forbidden of ["Edit", "Version history", "Share settings", "Save as a new site", "Rename", "Delete"]) {
      expect(text).not.toContain(forbidden);
    }
    // The negative is asserted on links too: there must be no path to the editor at all.
    expect(links(tree).some((href) => href.includes("/edit"))).toBe(false);
    expect(text).toContain("Read-only share");
  });

  it("needsLogin: offers a sign-in entry point, with return_to pointing back at this link", async () => {
    const site = await publish();
    const { token } = await shareOf(site, "login");
    visit();
    const tree = await render(token);

    expect(textOf(tree)).toContain("Sign in to view");
    expect(links(tree)).toContain(`/api/auth/login?return_to=${encodeURIComponent(`/v/${token}`)}`);
    expect(hostTags(tree, "iframe")).toHaveLength(0); // not a single byte of the artifact has gone out yet
  });

  it("with no IdP configured it does not draw a sign-in button that would inevitably 400", async () => {
    const site = await publish();
    const { token } = await shareOf(site, "login");
    delete process.env.ARTIFACT_OIDC_ISSUER;
    visit();
    const tree = await render(token);

    expect(links(tree).some((href) => href.startsWith("/api/auth/login"))).toBe(false);
    expect(textOf(tree)).toContain("no sign-in configured");
  });

  it("notInvited: says clearly 'you are not on the list', not 'the link is broken'", async () => {
    const site = await publish();
    const { token } = await shareOf(site, "people");
    const outsider = await signIn("Outsider");
    visit({ cookies: [outsider.cookie] });
    const tree = await render(token);

    expect(textOf(tree)).toContain("Your account is not on this link's access list");
    expect(hostTags(tree, "iframe")).toHaveLength(0);
  });

  it("needsPasscode: a real form that POSTs to unlock, with no dependency on JS", async () => {
    const site = await publish();
    const { token } = await shareOf(site, "passcode");
    visit();
    const tree = await render(token);

    const forms = hostTags(tree, "form");
    expect(forms).toHaveLength(1);
    expect(forms[0].method).toBe("post");
    expect(forms[0].action).toBe(`/api/shares/${token}/unlock`);
    expect(hostTags(tree, "input")[0].name).toBe("passcode");
    expect(hostTags(tree, "iframe")).toHaveLength(0);
  });

  it("after a wrong attempt it returns to the passcode page and says the code was wrong", async () => {
    const site = await publish();
    const { token } = await shareOf(site, "passcode");
    visit();

    expect(textOf(await render(token, "wrong"))).toContain("Incorrect passcode");
    expect(textOf(await render(token, "slow"))).toContain("Too many attempts");
    // Without e= the reader must not be accused of a wrong attempt out of nowhere.
    expect(textOf(await render(token))).not.toContain("Incorrect passcode");
  });

  it("coming back with the cookie unlock planted goes straight to the artifact", async () => {
    const site = await publish();
    const { token, share, passcode } = await shareOf(site, "passcode");
    expect(passcode).toBeTruthy();
    const grant = buildPasscodeCookie(
      new Request(`${ORIGIN}/`, { headers: { "x-forwarded-proto": "https" } }),
      { ...share, tokenHash: hashToken(token), passcodeHash: hashPasscode(passcode!) },
    ).split(";")[0];

    visit({ cookies: [grant] });
    expect(hostTags(await render(token), "iframe")).toHaveLength(1);
  });

  it("revoked / expired / nonexistent / site deleted: the identical sentence, indistinguishable to the reader", async () => {
    const site = await publish();
    const revoked = await shareOf(site, "public");
    await (await import("@/lib/db")).revokeShare(revoked.share.id, Date.now());
    const expired = await shareOf(site, "public", { expiresAt: Date.now() - 1000 });
    const gone = await publish();
    const orphan = await shareOf(gone, "public");
    await softDeleteSite(gone.id);
    visit();

    const rendered = await Promise.all(
      [revoked.token, expired.token, orphan.token, "never-existed"].map(async (t) => textOf(await render(t))),
    );
    for (const text of rendered) {
      expect(text).toContain("This link is no longer valid");
      // A state-specific heading ("Revoked", "Expired") would leak that the token once existed;
      // the body may list the possibilities, the page must never say which one applies.
      expect(text).not.toContain("Revoked");
      expect(text).not.toContain("Expired");
    }
    expect(new Set(rendered).size).toBe(1); // identical word for word
  });
});

// --- view log -----------------------------------------------------------------

describe("logShareView collapsing", () => {
  it("the same reader refreshing any number of times within 30 minutes is one row; only after that is another recorded", async () => {
    const site = await publish();
    const { token, share } = await shareOf(site, "public");
    visit({ ip: "203.0.113.42", userAgent: "TestBrowser/1.0" });

    await render(token);
    await render(token);
    await render(token);
    let views = await listShareViews(site.id, 100);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ shareId: share.id, ip: "203.0.113.42", userAgent: "TestBrowser/1.0" });

    // 31 minutes later is a new visit, not the same refresh.
    const later = Date.now() + 31 * 60 * 1000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(later);
    await render(token);
    vi.useRealTimers();

    views = await listShareViews(site.id, 100);
    expect(views).toHaveLength(2);
  });

  it("logged-in readers collapse by account; two different people each get their own row", async () => {
    const site = await publish();
    const { token } = await shareOf(site, "login");
    const a = await signIn("Reader A");
    const b = await signIn("Reader B");

    // Same egress IP — collapsing by IP would swallow the second person.
    visit({ cookies: [a.cookie], ip: "203.0.113.7" });
    await render(token);
    await render(token);
    visit({ cookies: [b.cookie], ip: "203.0.113.7" });
    await render(token);

    const views = await listShareViews(site.id, 100);
    expect(views).toHaveLength(2);
    expect(new Set(views.map((v) => v.userId))).toEqual(new Set([a.id, b.id]));
  });

  it("a refused reader leaves no view record — seeing nothing does not count as a view", async () => {
    const site = await publish();
    const { token } = await shareOf(site, "passcode");
    visit({ ip: "203.0.113.99" });

    await render(token);
    expect(await listShareViews(site.id, 100)).toHaveLength(0);
  });
});

// --- QA tier ------------------------------------------------------------------

import AssistantComponent from "@/components/assistant";

/** Whether the tree contains a given component type (a component that renders null can only be found by type, never by text). */
function containsComponent(node: unknown, type: unknown): boolean {
  if (Array.isArray(node)) return node.some((child) => containsComponent(child, type));
  if (node === null || typeof node !== "object") return false;
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === type) return true;
  return containsComponent(el.props?.children, type);
}

describe("QA tier — the assistant follows the share's flag, never the default", () => {
  beforeEach(() => {
    process.env.ARTIFACT_ASSISTANT_URL = "https://if.example.net";
  });
  afterEach(() => {
    delete process.env.ARTIFACT_ASSISTANT_URL;
  });

  it("mounts the assistant in qa mode for an allow_ai share", async () => {
    const site = await publish();
    const { token } = await shareOf(site, "public", { allowAi: true });
    visit();
    const tree = await render(token);
    expect(containsComponent(tree, AssistantComponent)).toBe(true);
  });

  it("stays JS-free for a share whose owner left the flag off", async () => {
    const site = await publish();
    const { token } = await shareOf(site, "public");
    visit();
    const tree = await render(token);
    expect(containsComponent(tree, AssistantComponent)).toBe(false);
  });

  it("stays off however the deployment is configured when the env is unset", async () => {
    delete process.env.ARTIFACT_ASSISTANT_URL;
    const site = await publish();
    const { token } = await shareOf(site, "public", { allowAi: true });
    visit();
    const tree = await render(token);
    expect(containsComponent(tree, AssistantComponent)).toBe(false);
  });
});

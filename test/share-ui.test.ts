// The share-link screen. The component itself needs a DOM (this repo's vitest environment is node,
// without jsdom), so the decisions are extracted into pure functions in components/share-model.ts
// and asserted here with real inputs; the remaining cases are structural constraints anchored on
// concrete strings in the source (that is what pins the two sentences that must appear in the UI).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EMAIL_EXACT_NOTICE, EDIT_POLICY_LOCK_NOTICE, EXPIRY_CHOICES, NO_NOTIFY_NOTICE, POLICY_HINT,
  POLICY_LABEL, POLICY_SHORT, SHARE_POLICY_MENU, TOKEN_ONCE_NOTICE, VISIBILITY_LABEL,
  addPerson, errorText, expiresAtFor, expiryChoiceOf, expiryDaysFor, expiryText, isEmailLike,
  isPendingPerson, needsPrivateNudge, personKey, personLabel, privateNudgeText, readFreshPasscode,
  readGrantResult, readGrants, readListedGrants, readMinted, readShares, readViews,
  reconcileSharing, removePerson, searchShouldRun, shareState, shareStateOf, shareUrl, viaLabel,
  viewerLabel, type PickedPerson, type ShareListItem, type ShareViewRow,
} from "@/components/share-model";
import { isLive } from "@/lib/share";
import { translatorFor } from "@/lib/i18n";
// Assert directly against the **API's own parsers**: a wrong field name/value does not make the API
// error out (POST treats the expiry as unset, PATCH as unchanged). This is the spot on this screen
// most likely to fail silently, and only running the real parsers catches it.
import { parseExpiry, parseLabel, parsePolicy } from "@/app/api/sites/[slug]/shares/_shared";
import { EXPIRY_DAYS, SHARE_POLICIES as SERVER_POLICIES } from "@/lib/types";

const abs = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(abs(rel), "utf8");

const panel = read("src/components/share-panel.tsx");
const links = read("src/components/share-links.tsx");
const picker = read("src/components/people-picker.tsx");
const views = read("src/components/share-views.tsx");
const css = read("src/app/globals.css");

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
/** The helpers that build a sentence take the caller's translator; English is the source. */
const t = translatorFor("en");

/** The shape the list endpoint returns (ShareSummary), not the storage-layer Share — it does not even carry a token. */
function share(over: Partial<ShareListItem> = {}): ShareListItem {
  return {
    id: "sh_1", policy: "login", label: null, hasPasscode: false,
    createdAt: NOW - DAY, expiresAt: null, revokedAt: null,
    ...over,
  };
}

// ── Site gate vs share link ──────────────────────────────────────────────────

describe("a restricted share on a site that is still open is decoration", () => {
  it("a live restricted share on a public site → must nudge", () => {
    expect(needsPrivateNudge("public", [share({ policy: "login" })], NOW)).toBe(true);
    expect(needsPrivateNudge("unlisted", [share({ policy: "people" })], NOW)).toBe(true);
    expect(needsPrivateNudge("unlisted", [share({ policy: "passcode" })], NOW)).toBe(true);
  });

  it("already private → no nudge (the gate is shut; the policy already applies)", () => {
    expect(needsPrivateNudge("private", [share({ policy: "people" })], NOW)).toBe(false);
  });

  it("only public shares → no nudge: public site + public share is a legitimate combination, and nagging only trains users to ignore the notice", () => {
    expect(needsPrivateNudge("public", [share({ policy: "public" })], NOW)).toBe(false);
    expect(needsPrivateNudge("public", [], NOW)).toBe(false);
  });

  it("the restricted share is revoked / expired → no nudge: it no longer blocks anything and is not guarding anyone", () => {
    expect(needsPrivateNudge("public", [share({ policy: "login", revokedAt: NOW - 10 })], NOW)).toBe(false);
    expect(needsPrivateNudge("public", [share({ policy: "login", expiresAt: NOW - 10 })], NOW)).toBe(false);
  });

  it("the nudge must include the address that bypasses the share, or the user cannot tell where the leak is", () => {
    expect(privateNudgeText("abc-123", t)).toContain("/s/abc-123");
    expect(privateNudgeText("abc-123", t)).toContain("Private");
  });
});

describe("private × login is a deadlock; the UI resolves it itself", () => {
  it("choosing private pulls the edit policy back to owner and says so — the server answers 400 for this combination", () => {
    const out = reconcileSharing({ visibility: "private", editPolicy: "login" });
    expect(out).toEqual({ visibility: "private", editPolicy: "owner", adjusted: true });
  });

  it("every other combination passes through unchanged; the user's choice is not overridden", () => {
    for (const v of ["public", "unlisted", "private"] as const) {
      for (const p of ["owner", "login"] as const) {
        if (v === "private" && p === "login") continue;
        expect(reconcileSharing({ visibility: v, editPolicy: p })).toEqual({ visibility: v, editPolicy: p, adjusted: false });
      }
    }
  });
});

// ── Expiry ───────────────────────────────────────────────────────────────────

describe("expiry choice → expiry instant → echo", () => {
  it("never is null, not a huge number (the API expresses no-expiry as null)", () => {
    expect(expiresAtFor("never", NOW)).toBeNull();
  });

  it("7 / 30 / 90 days are computed in real milliseconds", () => {
    expect(expiresAtFor("7d", NOW)).toBe(NOW + 7 * DAY);
    expect(expiresAtFor("30d", NOW)).toBe(NOW + 30 * DAY);
    expect(expiresAtFor("90d", NOW)).toBe(NOW + 90 * DAY);
  });

  it("round trip: the computed expiry instant echoes back as the same choice", () => {
    for (const c of ["never", "7d", "30d", "90d"] as const) {
      expect(expiryChoiceOf(expiresAtFor(c, NOW), NOW)).toBe(c);
    }
  });

  it("an already-expired instant echoes as the shortest choice, rather than falling outside the option set and blanking the select", () => {
    expect(expiryChoiceOf(NOW - DAY, NOW)).toBe("7d");
  });

  it("the copy says 'how much is left', rounded up — 10 hours remaining must not read as 0 days", () => {
    expect(expiryText(null, NOW, t)).toBe("Never expires");
    expect(expiryText(NOW - 1, NOW, t)).toBe("Expired");
    expect(expiryText(NOW + 10 * 3600_000, NOW, t)).toBe("Expires in less than 1 day");
    expect(expiryText(NOW + 3 * DAY, NOW, t)).toBe("Expires in 3 days");
  });
});

// ── Contract alignment: the request body's field names/values must pass the API's own parsers ──

describe("the expiry is sent as expiresInDays, not a timestamp", () => {
  it("every choice passes the server's parseExpiry — this test exists to catch my first version sending expiresAt", () => {
    for (const { value } of EXPIRY_CHOICES) {
      const days = expiryDaysFor(value);
      expect(() => parseExpiry(days, NOW)).not.toThrow();
      // The expiry instant the server computes and the one the UI echoes must be the same number.
      expect(parseExpiry(days, NOW)).toBe(expiresAtFor(value, NOW));
    }
  });

  it("the set of days in the dropdown = the set the API accepts; one extra choice is an option that is guaranteed to 400", () => {
    const mine = EXPIRY_CHOICES.map((c) => expiryDaysFor(c.value)).filter((d): d is number => d != null);
    expect(mine.sort((a, b) => a - b)).toEqual([...EXPIRY_DAYS].sort((a, b) => a - b));
  });

  it("never is null: the API reads it as 'does not expire', not as 'leave unchanged this time'", () => {
    expect(expiryDaysFor("never")).toBeNull();
    expect(parseExpiry(null, NOW)).toBeNull();
    // Control: a field absent from a PATCH means "keep as is" — so never must be sent as an explicit null.
    expect(parseExpiry(undefined, NOW)).toBeUndefined();
  });

  it("sending a day count the API does not accept is a 400 (proving the equality above is no coincidence)", () => {
    expect(() => parseExpiry(14, NOW)).toThrow();
  });
});

describe("the remaining request fields pass the server parsers too", () => {
  it("the four policies match the API verbatim", () => {
    expect([...SHARE_POLICY_MENU].sort()).toEqual([...SERVER_POLICIES].sort());
    for (const p of SHARE_POLICY_MENU) expect(parsePolicy(p, "login")).toBe(p);
  });

  it("the label input's maxLength does not exceed the API's cap", () => {
    const max = Number(/maxLength=\{(\d+)\}/.exec(links)?.[1]);
    expect(Number.isFinite(max)).toBe(true);
    expect(() => parseLabel("x".repeat(max))).not.toThrow();
  });

  it("the client really sends expiresInDays (a wrong field name does not error; it silently becomes never)", () => {
    expect(links).toContain("expiresInDays");
    expect(links).not.toContain("expiresAt:");
  });
});

describe("live / revoked / expired", () => {
  it("revocation outranks everything", () => {
    expect(shareState(share({ revokedAt: NOW - 1, expiresAt: NOW + DAY }), NOW)).toBe("revoked");
  });

  it("the boundary matches lib/share.isLive exactly — if the two sides judge separately you get 'the UI says live, opening it gives 404'", () => {
    const cases = [null, NOW - 1, NOW, NOW + 1, NOW + DAY];
    for (const expiresAt of cases) {
      const s = { revokedAt: null, expiresAt };
      expect(shareState(s, NOW) === "live", `expiresAt=${expiresAt}`).toBe(isLive(s, NOW));
    }
    // The instant exactly equal to now counts as expired (isLive requires strictly greater).
    expect(shareState({ revokedAt: null, expiresAt: NOW }, NOW)).toBe("expired");
  });

  it("when the server provides status it wins — a browser clock ten minutes slow must not make the panel and the server disagree", () => {
    const skewed = share({ expiresAt: NOW - DAY, status: "live" });
    expect(shareState(skewed, NOW)).toBe("expired"); // the local computation says so
    expect(shareStateOf(skewed, NOW)).toBe("live");  // but only the server gets to declare expiry
  });

  it("falls back to the local computation only when the server did not provide it (older responses)", () => {
    expect(shareStateOf(share({ expiresAt: NOW - DAY }), NOW)).toBe("expired");
  });
});

describe("shareUrl", () => {
  it("what goes out is /v/<token>, not the site address", () => {
    expect(shareUrl("https://hub.example", "tok_abc")).toBe("https://hub.example/v/tok_abc");
  });
  it("a trailing slash on origin does not produce //v/", () => {
    expect(shareUrl("https://hub.example/", "tok")).toBe("https://hub.example/v/tok");
  });
});

// ── One-time reveal: parse it wrong once and the link is gone for good ───────

describe("readMinted — the store holds only the hash; the plaintext appears in this one response only", () => {
  it("the API provides url directly", () => {
    const out = readMinted({ share: { id: "sh_9" }, url: "https://h/v/t1", passcode: null }, "https://h");
    expect(out?.url).toBe("https://h/v/t1");
    expect(out?.shareId).toBe("sh_9");
  });

  it("builds the url itself when the API provides only token — failing to parse it means the link the user just created is lost on the spot", () => {
    const out = readMinted({ share: { id: "sh_9" }, token: "t2" }, "https://h");
    expect(out?.url).toBe("https://h/v/t2");
  });

  it("picks up the access code too (both the passcode and code keys are accepted)", () => {
    expect(readMinted({ url: "https://h/v/t", passcode: "ABC234" }, "https://h")?.passcode).toBe("ABC234");
    expect(readMinted({ url: "https://h/v/t", code: "ABC234" }, "https://h")?.passcode).toBe("ABC234");
  });

  it("neither url nor token → null, so the UI can say 'revoke and recreate' instead of showing a fake link", () => {
    expect(readMinted({ share: { id: "sh_9" } }, "https://h")).toBeNull();
    expect(readMinted(null, "https://h")).toBeNull();
  });

  it("the code re-issued when PATCH switches to the passcode policy must be caught too — otherwise it is a link even its owner cannot open", () => {
    expect(readFreshPasscode({ share: { id: "sh_1" }, passcode: "K7M2QP" })).toBe("K7M2QP");
    // A code the user typed themselves is not echoed (the server returns only the one it generated); none must be fabricated then.
    expect(readFreshPasscode({ share: { id: "sh_1" } })).toBeNull();
  });
});

describe("the people list arrives with the list; there is no separate GET", () => {
  it("takes grants from the list row", () => {
    const people = readListedGrants(share({
      policy: "people",
      grants: [
        { userId: "u1", email: "a@x.com", displayName: "老王", pending: false },
        { userId: null, email: "b@x.com", displayName: null, pending: true },
      ],
    }));
    expect(people).toHaveLength(2);
    expect(isPendingPerson(people[1])).toBe(true);
  });

  it("no grants field means an empty list, not a crash", () => {
    expect(readListedGrants(share())).toEqual([]);
  });

  it("the component no longer GETs .../grants — that route has only POST/DELETE, and GET is a 405", () => {
    expect(links).not.toMatch(/grants`, \{ cache/);
  });
});

// ── The unregistered-email path ──────────────────────────────────────────────

describe("readGrantResult — adding succeeded, but the person may never get in", () => {
  const typed: PickedPerson = { userId: null, email: "her@corp.com", displayName: null };

  it("the stored row has no userId ⇒ pending, and the UI must show the warning on the spot", () => {
    const out = readGrantResult({ grant: { shareId: "sh", userId: null, email: "her@corp.com" } }, typed);
    expect(out.pending).toBe(true);
    expect(out.person.email).toBe("her@corp.com");
  });

  it("an account found by search ⇒ not pending", () => {
    const out = readGrantResult({ grant: { shareId: "sh", userId: "u7", email: "he@corp.com", displayName: "老王" } },
      { userId: "u7", email: "he@corp.com" });
    expect(out.pending).toBe(false);
    expect(out.person.displayName).toBe("老王");
  });

  it("the two shapes of the real API response", () => {
    // Unregistered: status=pending + grant.pending=true
    const pending = readGrantResult({
      status: "pending", code: "pending_email", message: "该邮箱尚未登录过本站，对方用它登录后会自动生效",
      grant: { userId: null, email: "her@corp.com", displayName: null, pending: true },
    }, typed);
    expect(pending.pending).toBe(true);
    // Registered: status=linked, and the email is normalised to lower case by the server
    const linked = readGrantResult({
      status: "linked",
      grant: { userId: "u7", email: "he@corp.com", displayName: "老王", pending: false },
    }, { userId: null, email: "He@Corp.com" });
    expect(linked.pending).toBe(false);
    expect(linked.person.email).toBe("he@corp.com");
  });

  it("the server phrasing it differently (status / matched / invited / pending / registered) is recognised just the same", () => {
    const flags = [{ status: "pending" }, { matched: false }, { invited: true }, { pending: true }, { registered: false }];
    for (const flag of flags) {
      expect(readGrantResult({ ...flag, grant: { userId: "u7", email: "x@y.com" } }, typed).pending).toBe(true);
    }
  });

  it("`id` in the response is not used as userId — it is most likely the grant/share id, and mistaking it swallows the warning", () => {
    const out = readGrantResult({ id: "sh_1", email: "her@corp.com", userId: null }, typed);
    expect(out.person.userId).toBeNull();
    expect(out.pending).toBe(true);
  });

  it("an empty-shell response falls back to the local person and still counts as pending", () => {
    const out = readGrantResult({}, typed);
    expect(out.person.email).toBe("her@corp.com");
    expect(out.pending).toBe(true);
  });
});

describe("people list: dedupe, labels, unregistered detection", () => {
  it("the same email in different case is one person", () => {
    const list = addPerson([{ userId: null, email: "A@x.com" }], { userId: null, email: "a@X.com" });
    expect(list).toHaveLength(1);
  });

  it("people with accounts dedupe by userId and do not swallow each other over an empty email", () => {
    let list = addPerson([], { userId: "u1", email: null });
    list = addPerson(list, { userId: "u2", email: null });
    expect(list).toHaveLength(2);
    expect(personKey(list[0])).not.toBe(personKey(list[1]));
  });

  it("removal uses the same key", () => {
    const list = removePerson([{ userId: null, email: "A@x.com" }], { userId: null, email: "a@x.com" });
    expect(list).toEqual([]);
  });

  it("display name > email > id", () => {
    expect(personLabel({ userId: "u1", email: "a@x.com", displayName: "老王" }, t)).toBe("老王");
    expect(personLabel({ userId: "u1", email: "a@x.com" }, t)).toBe("a@x.com");
    expect(personLabel({ userId: "u1", email: null }, t)).toBe("u1");
  });

  it("no userId means 'has never signed in to this site'", () => {
    expect(isPendingPerson({ userId: null, email: "a@x.com" })).toBe(true);
    expect(isPendingPerson({ userId: "u1", email: null })).toBe(false);
  });
});

describe("input decisions", () => {
  it("Enter adds an email: the request goes out only if it looks like an email, so a name is not added as a grant that never matches", () => {
    expect(isEmailLike("a@x.com")).toBe(true);
    expect(isEmailLike("  a@x.com  ")).toBe(true);
    expect(isEmailLike("老王")).toBe(false);
    expect(isEmailLike("a@x")).toBe(false);
    expect(isEmailLike("a b@x.com")).toBe(false);
  });

  it("search runs only at ≥2 characters — a single character matches half the address book", () => {
    expect(searchShouldRun("a")).toBe(false);
    expect(searchShouldRun(" a ")).toBe(false);
    expect(searchShouldRun("ab")).toBe(true);
    expect(searchShouldRun("老王")).toBe(true);
  });
});

// ── View log ─────────────────────────────────────────────────────────────────

describe("view log", () => {
  const base: ShareViewRow = {
    shareId: "sh_1", siteId: "site_1", userId: null, anonId: "anon_1", ip: null,
    userAgent: null, viewedAt: NOW - 60_000,
  };

  it("an anonymous read is normal; it shows 'Not signed in' rather than blank or the anonId", () => {
    expect(viewerLabel(base, t)).toBe("Not signed in");
  });

  it("signed-in users show the display name first, then the email", () => {
    expect(viewerLabel({ ...base, userId: "u1", displayName: "老王", email: "a@x.com" }, t)).toBe("老王");
    expect(viewerLabel({ ...base, userId: "u1", email: "a@x.com" }, t)).toBe("a@x.com");
    expect(viewerLabel({ ...base, userId: "u1" }, t)).toBe("u1");
  });

  it("which share it came through: the label first, falling back to the policy name", () => {
    expect(viaLabel(base, [share({ id: "sh_1", label: "给客户" })], t)).toBe("给客户");
    expect(viaLabel(base, [share({ id: "sh_1", policy: "passcode" })], t)).toBe(POLICY_SHORT.passcode);
  });

  it("a share deleted beyond recovery must not show as blank — fall back to the id prefix", () => {
    expect(viaLabel({ ...base, shareId: "sh_deadbeef99" }, [], t)).toBe("sh_deadb");
  });
});

// ── Envelope: lenient reading ────────────────────────────────────────────────

describe("read* does not assume the API's envelope shape", () => {
  it("accepts {shares:[…]} / a bare array / {items:[…]}", () => {
    const one = [{ id: "sh_1" }];
    expect(readShares({ shares: one })).toHaveLength(1);
    expect(readShares(one)).toHaveLength(1);
    expect(readShares({ items: one })).toHaveLength(1);
    expect(readShares({ error: "boom" })).toEqual([]);
  });

  it("rows without an id are dropped, so undefined is never used to build a PATCH URL later", () => {
    expect(readShares({ shares: [{ policy: "login" }, { id: "sh_1" }] })).toHaveLength(1);
  });

  it("grants need at least one of userId or email", () => {
    expect(readGrants({ grants: [{ userId: "u1" }, { email: "a@x.com" }, { grantedAt: 1 }] })).toHaveLength(2);
  });

  it("views require viewedAt", () => {
    expect(readViews({ views: [{ shareId: "s", viewedAt: 1 }, { shareId: "s" }] })).toHaveLength(1);
  });

  it("errorText finds error/message and uses the fallback otherwise", () => {
    expect(errorText({ error: "没权限" }, "失败")).toBe("没权限");
    expect(errorText({ message: "没权限" }, "失败")).toBe("没权限");
    expect(errorText(null, "失败")).toBe("失败");
  });
});

// ── Structural constraints: no DOM in node, so anchor on the source ──────────

describe("private is now a real option", () => {
  it("the dropdown has private, and the label no longer says 'not yet enabled'", () => {
    expect(panel).toContain('<option value="private">');
    expect(VISIBILITY_LABEL.private).toContain("share link");
    expect(panel).not.toContain("not yet enabled");
    expect(VISIBILITY_LABEL.private).not.toContain("not yet enabled");
  });

  it("with private selected, 'anyone signed in can edit' is disabled — the server answers 400 for this combination", () => {
    expect(panel).toContain('disabled={visibility === "private"}');
    expect(EDIT_POLICY_LOCK_NOTICE).toContain("deadlock");
  });
});

describe("the two hard-constraint notices must actually render", () => {
  it("'Nobody will be notified' appears in both the create form and the one-time reveal block", () => {
    // A constant rather than scattered strings: one change updates everything, and the test cannot degrade into "grep a word that is always there".
    expect(NO_NOTIFY_NOTICE).toContain("Nobody will be notified");
    const uses = links.split("NO_NOTIFY_NOTICE").length - 1;
    expect(uses, "创建表单和铸出链接的那一刻都要说一遍").toBeGreaterThanOrEqual(2);
    expect(links).toContain("{t(NO_NOTIFY_NOTICE)}");
  });

  it("'the sign-in email must match exactly' sits in the people picker and makes clear that nobody will be told", () => {
    expect(EMAIL_EXACT_NOTICE).toContain("match it exactly");
    expect(EMAIL_EXACT_NOTICE).toContain("neither of you will be told");
    expect(picker).toContain("{t(EMAIL_EXACT_NOTICE)}");
  });

  it("'the link is shown only once' appears together with the reveal block", () => {
    expect(TOKEN_ONCE_NOTICE).toContain("shown only once");
    expect(links).toContain("{t(TOKEN_ONCE_NOTICE)}");
  });
});

describe("defaults and options for a new share link", () => {
  it("the default is login — not public, and not the strictest policy either", () => {
    const decl = links.slice(links.indexOf("useState<SharePolicy>"));
    expect(decl.slice(0, 60)).toContain('"login"');
  });

  it("all four policies are in the dropdown, and each has a sentence spelling out its cost", () => {
    expect([...SHARE_POLICY_MENU].sort()).toEqual(["login", "passcode", "people", "public"]);
    for (const p of SHARE_POLICY_MENU) {
      expect(POLICY_LABEL[p].length, p).toBeGreaterThan(4);
      expect(POLICY_HINT[p].length, p).toBeGreaterThan(10);
    }
  });

  it("four expiry choices: never / 7 / 30 / 90", () => {
    expect(links).toContain("EXPIRY_CHOICES");
    for (const label of ["Never expires", "Expires in 7 days", "Expires in 30 days", "Expires in 90 days"]) {
      expect(read("src/components/share-model.ts")).toContain(label);
    }
  });

  it("the people picker expands only for the people policy; the access code is explained only for passcode", () => {
    expect(links).toContain('policy === "people" && (');
    expect(links).toContain('policy === "passcode" && (');
  });
});

describe("the 'Copy link' in the list must not be fake", () => {
  it("only links minted in this session get a copy button; the rest say plainly that they cannot be retrieved", () => {
    // The store holds only tokenHash; the list endpoint cannot return the plaintext — a button that does nothing when clicked is worse than none.
    expect(links).toContain("secret?.url ? (");
    expect(links).toContain("shown only once, when it was created");
  });
});

describe("view-log entry point", () => {
  it("lives inside the share panel and fetches only when expanded", () => {
    expect(links).toContain("<ShareViews");
    expect(views).toContain("/views");
    expect(views).toContain('aria-expanded={open}');
  });

  it("newest first: the most recent visit is at the top", () => {
    expect(views).toContain("b.viewedAt - a.viewedAt");
  });
});

describe("styling follows the paper-and-ink system without introducing a second visual language", () => {
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, " ");

  it("the new share- rules use the --line/--paper/--ink variables", () => {
    // The share- section only: it ends where the next section (.pfp) begins; the hub-shell rules
    // appended after it have their own radii and are not what this test is about.
    const start = cssCode.indexOf(".share-sec {");
    const block = cssCode.slice(start, cssCode.indexOf("\n.pfp", start));
    expect(block).toContain("var(--line)");
    expect(block).toContain("var(--ink-soft)");
    // Rounded corners are another language (the .me-list rules are legacy); the new block should have none apart from the select reset.
    expect(block.replace(/border-radius: 0;/g, "")).not.toContain("border-radius");
  });

  it("every class name the components use exists in the CSS", () => {
    const used = new Set<string>();
    for (const src of [panel, links, picker, views]) {
      for (const m of src.matchAll(/className="([^"{}]+)"/g)) {
        for (const cls of m[1].split(/\s+/)) if (cls.startsWith("share-")) used.add(cls);
      }
    }
    expect(used.size).toBeGreaterThan(8);
    for (const cls of used) expect(cssCode, `.${cls} 没有样式`).toContain(`.${cls}`);
  });
});

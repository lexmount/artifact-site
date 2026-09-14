"use client";

// Where the "My sites" folder shelf lives, chosen by sign-in state (issue #35):
//   · signed out (or no IdP)  → the browser's localStorage, exactly as before
//   · signed in               → the account, through /api/me/folders — the same shelf on every device
// Both expose the same FolderState and the same four operations, so the component never branches.
//
// The hand-over happens once: the first time an account shelf is loaded in a browser that still
// holds a local one, the local shelf is imported (folders matched by name, sites filed where the
// account had no opinion yet) and then cleared. After that the browser is a client, not a store.
import { useCallback, useEffect, useState } from "react";
import {
  EMPTY_FOLDERS, FOLDERS_KEY, assignSite, createFolder, deleteFolder, newFolderId, parseFolders, renameFolder, serializeFolders,
  type FolderState,
} from "@/lib/folders";
import { readLocal, useLocalJson, writeLocal } from "@/lib/local-store";
import { adoptStoredSites } from "@/lib/adoption";

/** `refused` = the rule said no (blank name, full shelf); `storage` = the browser write failed;
 *  `server` = the account API said no (the message is in `error`). */
export type ShelfOutcome = { outcome: "ok"; id?: string } | { outcome: "refused" | "storage" } | { outcome: "server"; error: string };

export interface Shelf {
  mode: "local" | "account";
  state: FolderState;
  /** Account shelf still loading (or importing the local one). Local mode is never loading. */
  loading: boolean;
  create(name: string, slug?: string): Promise<ShelfOutcome>;
  rename(id: string, name: string): Promise<ShelfOutcome>;
  remove(id: string): Promise<ShelfOutcome>;
  assign(slug: string, folderId: string | null): Promise<ShelfOutcome>;
}

async function call(path: string, init: RequestInit): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  try {
    const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: (body as { error?: string } | null)?.error ?? `HTTP ${res.status}` };
    return { ok: true, body };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function asState(body: unknown): FolderState {
  return parseFolders(JSON.stringify(body));
}

/**
 * Hand a browser-local shelf over to the account — once per signed-in user per page load, from
 * wherever it is first asked for. Called on every page by <FolderSync> (so the hand-over happens
 * silently on the first visit after sign-in, no tab to open) and by useShelf before it reads the
 * account, so both callers share ONE request; a second call while the first is in flight, or after
 * it succeeded, just returns the same promise. Only a successful import forgets the local copy.
 */
const syncs = new Map<string, Promise<boolean>>();
export function syncLocalShelf(userId: string): Promise<boolean> {
  const pending = syncs.get(userId);
  if (pending) return pending;
  const stored = readLocal(FOLDERS_KEY);
  const localState = parseFolders(stored);
  const hasLocal = localState.folders.length > 0 || Object.keys(localState.assign).length > 0;
  if (!hasLocal) return Promise.resolve(false);
  const run = (async () => {
    // Ownership first: a site this browser made before the account existed is claimed by
    // /api/me/adopt on the same page load. Importing before that settles would skip its
    // assignment as "not your site" — and then forget it with the local copy. Memoised, so the
    // welcome burst and this share one call.
    await adoptStoredSites();
    const result = await call("/api/me/folders/import", { method: "POST", body: stored ?? "" });
    if (result.ok) {
      // Forget the local copy only if it is still the one that was sent. A change made while the
      // import was in flight (the shelf is still in local mode until the account answers) stays
      // put and is picked up by the next page load — the import is idempotent, so that is safe.
      if (readLocal(FOLDERS_KEY) === stored) writeLocal(FOLDERS_KEY, null);
      return true;
    }
    syncs.delete(userId); // a failed import keeps the evidence and may be retried
    return false;
  })();
  syncs.set(userId, run);
  return run;
}

/** Test hook: forget which users have been synced in this page. */
export function __resetShelfSyncForTests(): void {
  syncs.clear();
}

export function useShelf(userId: string | null): Shelf {
  const local = useLocalJson(FOLDERS_KEY, parseFolders, EMPTY_FOLDERS);
  const [account, setAccount] = useState<{ userId: string; state: FolderState } | null>(null);
  // Loading is DERIVED (signed in, account shelf not yet here for this user) rather than a state
  // flag set inside the effect — no setState-in-effect, and no way for it to disagree with `account`.

  // Load the account shelf — after the local one has been handed over, if there was one.
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    (async () => {
      await syncLocalShelf(userId).catch(() => false);
      const result = await call("/api/me/folders", { method: "GET" });
      if (!alive) return;
      // A failed load leaves the browser on its local shelf (still readable, still editable) rather
      // than on an empty account shelf that would look like everything vanished.
      if (result.ok) setAccount({ userId, state: asState(result.body) });
    })();
    return () => { alive = false; };
  }, [userId]);

  const reload = useCallback(async (): Promise<ShelfOutcome> => {
    if (!userId) return { outcome: "ok" };
    const r = await call("/api/me/folders", { method: "GET" });
    if (!r.ok) return { outcome: "server", error: r.error };
    setAccount({ userId, state: asState(r.body) });
    return { outcome: "ok" };
  }, [userId]);

  /** Local mode: read-modify-write against fresh storage so another tab's change is never clobbered. */
  const mutateLocal = useCallback((fn: (s: FolderState) => FolderState): ShelfOutcome => {
    const current = parseFolders(readLocal(FOLDERS_KEY));
    const next = fn(current);
    if (next === current) return { outcome: "refused" };
    return writeLocal(FOLDERS_KEY, serializeFolders(next)) ? { outcome: "ok" } : { outcome: "storage" };
  }, []);

  const onAccount = Boolean(userId) && account?.userId === userId;

  const create = useCallback(async (name: string, slug?: string): Promise<ShelfOutcome> => {
    if (!onAccount) {
      const id = newFolderId();
      const r = mutateLocal((s) => {
        const withFolder = createFolder(s, name, id, Date.now());
        if (withFolder === s) return s;
        return slug ? assignSite(withFolder, slug, id) : withFolder;
      });
      return r.outcome === "ok" ? { outcome: "ok", id } : r;
    }
    if (!name.trim()) return { outcome: "refused" };
    const created = await call("/api/me/folders", { method: "POST", body: JSON.stringify({ name }) });
    if (!created.ok) return { outcome: "server", error: created.error };
    const id = (created.body as { folder: { id: string } }).folder.id;
    if (slug) {
      const filed = await call("/api/me/folders/assignments", { method: "PUT", body: JSON.stringify({ slug, folderId: id }) });
      if (!filed.ok) { await reload(); return { outcome: "server", error: filed.error }; }
    }
    const r = await reload();
    return r.outcome === "ok" ? { outcome: "ok", id } : r;
  }, [onAccount, mutateLocal, reload]);

  const rename = useCallback(async (id: string, name: string): Promise<ShelfOutcome> => {
    if (!onAccount) return mutateLocal((s) => renameFolder(s, id, name));
    const r = await call(`/api/me/folders/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) });
    return r.ok ? reload() : { outcome: "server", error: r.error };
  }, [onAccount, mutateLocal, reload]);

  const remove = useCallback(async (id: string): Promise<ShelfOutcome> => {
    if (!onAccount) return mutateLocal((s) => deleteFolder(s, id));
    const r = await call(`/api/me/folders/${encodeURIComponent(id)}`, { method: "DELETE" });
    return r.ok ? reload() : { outcome: "server", error: r.error };
  }, [onAccount, mutateLocal, reload]);

  const assign = useCallback(async (slug: string, folderId: string | null): Promise<ShelfOutcome> => {
    if (!onAccount) return mutateLocal((s) => assignSite(s, slug, folderId));
    const r = await call("/api/me/folders/assignments", { method: "PUT", body: JSON.stringify({ slug, folderId }) });
    return r.ok ? reload() : { outcome: "server", error: r.error };
  }, [onAccount, mutateLocal, reload]);

  return {
    mode: onAccount ? "account" : "local",
    state: onAccount ? account!.state : local,
    loading: Boolean(userId) && !onAccount,
    create, rename, remove, assign,
  };
}

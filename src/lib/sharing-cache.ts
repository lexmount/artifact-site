import { appFetch } from "@/lib/app-path";
import { registerClientCache } from "@/lib/client-cache";
import type { Visibility } from "@/lib/types";

export type CommentSettings = { mainPolicy: "login" | "members" | "off"; readerAccess: boolean };
export type SharingSettings = {
  siteId: string;
  visibility: Visibility;
  canManageMembers: boolean;
  members: { id: string; name: string | null }[];
  moreMembers: boolean;
};
type Snapshot = {
  resetVersion: number;
  sharing: SharingSettings | null;
  comments: CommentSettings | null;
  pending: boolean;
  sharingPending: boolean;
  commentsPending: boolean;
  sharingError: boolean;
  commentsError: boolean;
  commentsUnavailable: boolean;
};
export const emptySharing: Snapshot = { resetVersion: 0, sharing: null, comments: null, pending: false, sharingPending: false, commentsPending: false, sharingError: false, commentsError: false, commentsUnavailable: false };

/** Session-local observable data, never an authorization decision. Writes authorize on the server. */
class SharingResource {
  private snapshot = emptySharing;
  private listeners = new Set<() => void>();
  private inflight: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private epoch = 0;
  private expires = 0;
  constructor(private slug: string) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  get active() { return this.listeners.size > 0 || this.inflight !== null; }
  private publish(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach(listener => listener());
  }
  clear() {
    this.epoch++;
    this.generation++;
    this.controller?.abort();
    this.inflight = null;
    this.expires = 0;
    this.publish({ ...emptySharing, resetVersion: this.epoch });
  }
  captureMutation() {
    const epoch = this.epoch;
    return (patch: Pick<Partial<Snapshot>, "sharing" | "comments">) => {
      if (epoch !== this.epoch) return false;
      this.update(patch);
      return true;
    };
  }
  update(patch: Pick<Partial<Snapshot>, "sharing" | "comments">) {
    // A pre-mutation response must not roll back a successful edit.
    this.generation++;
    this.controller?.abort();
    this.inflight = null;
    this.expires = 0;
    this.publish({ ...patch, pending: false, sharingPending: false, commentsPending: false });
  }
  load(force = false): Promise<void> {
    if (this.inflight) {
      const failedRequestSettled = (this.snapshot.sharingError && !this.snapshot.sharingPending)
        || (this.snapshot.commentsError && !this.snapshot.commentsPending);
      if (!force || !failedRequestSettled) return this.inflight;
      // A failed request can be retried even if its sibling has not finished.
      // Invalidate before aborting so late responses cannot replace the retry.
      this.generation++;
      this.controller?.abort();
      this.inflight = null;
    }
    if (!force && this.expires > Date.now()) return Promise.resolve();
    const generation = ++this.generation;
    const controller = this.controller = new AbortController();
    this.publish({ pending: true, sharingPending: true, commentsPending: true });
    let denied = false;
    const current = () => this.generation === generation;
    const read = async (kind: "sharing" | "comments") => {
      try {
        const response = await appFetch(`/api/sites/${encodeURIComponent(this.slug)}/${kind === "sharing" ? "sharing?summary=1" : "comment-settings"}`, { cache: "no-store", signal: controller.signal });
        if (!current()) return;
        if (kind === "comments" && response.status === 404) {
          this.publish({ comments: null, commentsError: false, commentsUnavailable: true });
          return;
        }
        if (!response.ok) {
          if (kind === "sharing" && [401, 403, 404].includes(response.status)) {
            denied = true;
            this.publish({ sharing: null, comments: null });
          } else if (kind === "comments" && [401, 403, 404].includes(response.status)) {
            this.publish({ comments: null });
          }
          throw new Error("Sharing lookup failed");
        }
        const data = await response.json();
        if (current() && !denied) this.publish(kind === "sharing" ? { sharing: data, sharingError: false } : { comments: data, commentsError: false, commentsUnavailable: false });
      } catch {
        if (current()) this.publish(kind === "sharing" ? { sharingError: true } : { commentsError: true });
      } finally {
        if (current()) this.publish(kind === "sharing" ? { sharingPending: false } : { commentsPending: false });
      }
    };
    this.inflight = Promise.all([read("sharing"), read("comments")]).then(() => {
      if (!current()) return;
      this.inflight = null;
      this.expires = this.snapshot.sharingError || this.snapshot.commentsError ? 0 : Date.now() + 30_000;
      this.publish({ pending: false });
    });
    return this.inflight;
  }
}
const resources = new Map<string, SharingResource>();
registerClientCache(() => {
  for (const [key, resource] of resources) {
    resource.clear();
    if (!resource.active) resources.delete(key);
  }
});
export function sharingResource(identity: string, slug: string) {
  const key = JSON.stringify([identity, slug]);
  let resource = resources.get(key);
  if (!resource) {
    for (const [oldKey, value] of resources) {
      if (resources.size < 64) break;
      if (!value.active) resources.delete(oldKey);
    }
    resource = new SharingResource(slug);
    resources.set(key, resource);
  }
  return resource;
}

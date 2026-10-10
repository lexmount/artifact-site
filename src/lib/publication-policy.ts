import "server-only";
import type { RbacQuery } from "@/lib/rbac-store";
import type { Site } from "@/lib/types";

/** Runs inside the authorized version transaction; never perform network I/O here. */
export interface PublicationCommit {
  q: RbacQuery;
  site: Site;
  versionId: string;
  request: Request;
  creating: boolean;
  official: boolean;
  publishOfficial: () => Promise<void>;
}

/**
 * Deployment integration boundary. Defaults publish immediately and preserve the
 * existing reader view. These are additional publication constraints, never an
 * authorization grant: callers must still check identity, admission and paths.
 * Keep deployment-specific implementations outside the shared implementation.
 */
export interface PublicationPolicy {
  readerSite(request: Request, site: Site): Promise<Site>;
  externalSite(site: Site): Promise<Site>;
  allowsVersion(site: Site, versionId: string): Promise<boolean>;
  allowsRequestVersion(request: Request, site: Site, versionId: string): Promise<boolean>;
  commitVersion(input: PublicationCommit): Promise<void>;
}

export const publicationPolicy: PublicationPolicy = {
  async readerSite(_request, site) { return site; },
  async externalSite(site) { return site; },
  async allowsVersion() { return true; },
  async allowsRequestVersion() { return true; },
  async commitVersion({ official, publishOfficial }) {
    if (official) await publishOfficial();
  },
};

import { resolveAuthority, type Viewer } from "@/lib/authz";
import type { Site } from "@/lib/types";
export async function resolveRole(viewer: Viewer, site: Site) {
  return (await resolveAuthority(viewer, site)).role;
}

import NotFound from "@/app/not-found";
import RecentUnavailable from "@/components/recent-unavailable";

export { generateMetadata } from "@/app/not-found";

/** Missing sites and access-denied sites deliberately share the same 404 response.
 * Forget either failed direct entrance: an expired session can therefore remove a still-live
 * private site from this browser's history. After signing in, owners can reopen it from My sites
 * to record it again. Do not expose a deletion/access-denial flag to distinguish these cases.
 */
export default async function ViewerNotFound() {
  return <><RecentUnavailable />{await NotFound()}</>;
}

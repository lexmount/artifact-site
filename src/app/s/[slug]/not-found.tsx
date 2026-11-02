import NotFound from "@/app/not-found";
import RecentUnavailable from "@/components/recent-unavailable";

export { generateMetadata } from "@/app/not-found";

/** Remove missing/deleted site entrances from browser history. Access denial has its own screen. */
export default async function ViewerNotFound() {
  return <><RecentUnavailable />{await NotFound()}</>;
}

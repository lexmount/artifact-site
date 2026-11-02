import { localPath } from "../../src/lib/app-path";

// Keep router identity stable, as Next does. A refresh is observable without remounting the app.
const router = { refresh: () => window.dispatchEvent(new Event("fixture:refresh")), push() {} };
export const useRouter = () => router;
export const usePathname = () => localPath(window.location.pathname);
export const useSearchParams = () => new URLSearchParams(window.location.search);

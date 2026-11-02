export const useRouter = () => ({ refresh() {}, push(path: string) { location.assign(path); } });
export const usePathname = () => location.pathname;
export const useSearchParams = () => new URLSearchParams(location.search);

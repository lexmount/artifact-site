export type TenantRow = { id: string; name: string; slug: string; disabledAt: number | null; role: string; defaultUserCount?: number; siteCount?: number };
export const systemTenant = (id: string) => id === "init" || id === "anonymous";

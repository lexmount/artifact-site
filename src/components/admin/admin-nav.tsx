"use client";

// The console's four views. Same tab strip as "My sites" (hm-tabs), driven by the route rather
// than by state so every view has an address an operator can bookmark or send.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/components/locale-provider";

const TABS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/sites", label: "Sites" },
  { href: "/admin/authorization", label: "Authorization" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/system", label: "System" },
] as const;

export default function AdminNav() {
  const t = useT();
  const path = usePathname();
  const isCurrent = (href: string) => (href === "/admin" ? path === "/admin" : path.startsWith(href));
  const current = TABS.find((tab) => isCurrent(tab.href)) ?? TABS[0];
  return (
    <>
      {/* The view's name as the page title, above the tab strip — the tabs are navigation, not a heading. */}
      <div className="work-title admin-title"><h1>{t(current.label)}</h1></div>
      <nav className="hm-tabs admin-nav" aria-label={t("Administration views")}>
        {TABS.map(({ href, label }) => (
          <Link key={href} href={href} className="hm-tab" aria-current={isCurrent(href) ? "page" : undefined}>{t(label)}</Link>
        ))}
      </nav>
    </>
  );
}

// /admin — the administration console. The gate is HERE, server-side, once for every view:
// anyone who is not an administrator gets the ordinary 404, so the console does not announce
// itself. The API behind each view re-checks on every call; this is the page's own door.
import AppShell from "@/components/app-shell";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import AdminNav from "@/components/admin/admin-nav";
import { resolveAdmin } from "@/lib/admin";
import { viewerRequestFromHeaders } from "@/lib/authz";
import { getT } from "@/lib/i18n-server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Administration — artifact-site"), robots: { index: false, follow: false } };
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const request = viewerRequestFromHeaders(await headers(), "/admin");
  if (!(await resolveAdmin(request))) notFound();
  return (
    <AppShell section="admin">
      <div className="admin-shell">
        <AdminNav />
        <section className="admin-view">{children}</section>
      </div>
    </AppShell>
  );
}

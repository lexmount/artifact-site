import { headers } from "next/headers";
import { notFound } from "next/navigation";
import AppShell from "@/components/app-shell";
import AuthorizationConsole from "@/components/authorization-console";
import { viewerRequestFromHeaders } from "@/lib/authz";
import { resolveSession } from "@/lib/session";
import { resolveAdmin } from "@/lib/admin";
import { getT } from "@/lib/i18n-server";
export default async function AuthorizationPage() {
  const request=viewerRequestFromHeaders(await headers(),"/authorization");
  if(!await resolveSession(request)&&!await resolveAdmin(request))notFound();
  const t=await getT();
  return <AppShell><div className="admin-shell"><div className="work-title"><h1>{t("Authorization")}</h1></div><AuthorizationConsole /></div></AppShell>;
}

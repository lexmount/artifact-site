import { KeyRound } from "lucide-react";
import Link from "next/link";
import { getT } from "@/lib/i18n-server";
import { appPath } from "@/lib/app-path";
import { config } from "@/lib/config";
import { getUser } from "@/lib/db";
import type { Session } from "@/lib/types";
import SiteAccessActions from "@/components/site-access-actions";

export default async function MainPasscodeEntry({ slug, version, error, session }: { slug: string; version?: string; error?: string; session: Session | null }) {
  const t = await getT();
  const user = session ? await getUser(session.userId) : null;
  const label = user?.email || user?.displayName;
  return <main className="main-passcode-entry">
    <KeyRound size={28} aria-hidden="true"/>
    <h1>{t("Enter the passcode")}</h1>
    <p>{t("Ask the person who shared this link for its passcode.")}</p>
    <form action={appPath(`/api/sites/${encodeURIComponent(slug)}/main-sharing/unlock`)} method="post">
      <label htmlFor="main-passcode">{t("Passcode")}</label>
      <input id="main-passcode" name="passcode" required maxLength={64} autoComplete="off" autoCapitalize="characters" spellCheck={false} aria-describedby="main-passcode-hint"/>
      {version && <input type="hidden" name="version" value={version}/>}
      <p id="main-passcode-hint">{t("Passcodes are not case-sensitive.")}</p>
      {error && <p role="alert">{t(error === "slow" ? "Too many attempts. Try again later." : error === "empty" ? "Please enter the passcode" : "Incorrect passcode")}</p>}
      <button className="btn solid" type="submit">{t("Open artifact")}</button>
    </form>
    <div className="main-passcode-recovery">
      {config.oidcEnabled && <p>{t("Already have access? Sign in with the authorized account.")}</p>}
      {label && <p>{t("Current account: {account}", { account: label })}</p>}
      <div className="main-passcode-actions">
        <SiteAccessActions signedIn={Boolean(session)} loginEnabled={config.oidcEnabled} />
        <Link className="btn" href="/">{t("Back to home")}</Link>
      </div>
    </div>
  </main>;
}

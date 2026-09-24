// App shell. One light theme, on purpose: the product is black on near-white with a light green,
// and the artifacts it hosts bring their own colours.
import { previewLoadTrackerScript } from "@/lib/comments/preview-load";

import { Suspense } from "react";
import { cookies } from "next/headers";
import Analytics from "@/components/analytics";
import { config } from "@/lib/config";
import { SESSION_COOKIE_NAMES } from "@/lib/session-cookie";
import type { Metadata } from "next";
import "./globals.css";
import NavigationShell from "@/components/navigation-shell";
import NavigationMetrics from "@/components/navigation-metrics";
import WelcomeBurst from "@/components/welcome-burst";
import FolderSync from "@/components/folder-sync";
import { LocaleProvider } from "@/components/locale-provider";
import { AuthConfigProvider } from "@/components/auth-config-provider";
import { getLocale, getT } from "@/lib/i18n-server";

import { platformCopy } from "@/lib/platform-copy";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t(platformCopy.title), description: t(platformCopy.description) };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const cookieStore = await cookies();
  // Presence avoids flashing a login action for returning users. Only /api/auth/me validates it.
  // A sibling-domain development cookie may also cause a placeholder on HTTPS. This display-only
  // hint accepts that harmless false positive; session validation still ignores that cookie on HTTPS.
  const hasSessionHint = Object.values(SESSION_COOKIE_NAMES).some(name => cookieStore.has(name));
  return (
    <html lang={locale}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: previewLoadTrackerScript }} />
        <meta name="theme-color" content="#fdfdfd" />
      </head>
      <body>
        <LocaleProvider locale={locale}>
          <AuthConfigProvider enabled={config.oidcEnabled} hasSessionHint={hasSessionHint}>
            <NavigationShell>{children}</NavigationShell>
            <NavigationMetrics />
            {/* Mounted app-wide: the auth callback can land on any page. */}
            <WelcomeBurst />
            {/* Mounted app-wide: a signed-in browser hands its local folder shelf to the account on any page. */}
            <FolderSync />
            {config.gaMeasurementId && <Suspense fallback={null}><Analytics measurementId={config.gaMeasurementId} hosts={config.gaHosts} /></Suspense>}
          </AuthConfigProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}

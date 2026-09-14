// App shell. One light theme, on purpose: the product is black on near-white with a light green,
// and the artifacts it hosts bring their own colours.
import type { Metadata } from "next";
import "./globals.css";
import WelcomeBurst from "@/components/welcome-burst";
import FolderSync from "@/components/folder-sync";
import { LocaleProvider } from "@/components/locale-provider";
import { getLocale, getT } from "@/lib/i18n-server";

// Platform-level copy, aimed at whoever is about to publish something. Every page that a READER
// can be sent to must override the description — otherwise Next merges this one down and the
// share card for someone's report ends up advertising the uploader. See /s/[slug]'s
// generateMetadata, which is the page that mistake actually reached.
//
// Names what people publish (reports, dashboards) instead of what they drag (.zip), because the
// formats are an implementation detail and the reader-facing value is "it is already online".
/** The platform's own copy (English source; translated at render time). Exported so the pages a
 *  READER lands on can assert they never inherit it. */
export const platformCopy = {
  title: "artifact-site — turn your work into a link to share and collaborate",
  description: "Upload it and it is online. Pages, reports, dashboards — all become links you can share and edit in place.",
} as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t(platformCopy.title), description: t(platformCopy.description) };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale}>
      <head>
        <meta name="theme-color" content="#fdfdfd" />
      </head>
      <body>
        <LocaleProvider locale={locale}>
          {children}
          {/* Mounted app-wide: the auth callback can land on any page. */}
          <WelcomeBurst />
          {/* Mounted app-wide: a signed-in browser hands its local folder shelf to the account on any page. */}
          <FolderSync />
        </LocaleProvider>
      </body>
    </html>
  );
}

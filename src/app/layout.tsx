// App shell. One light theme, on purpose: the product is black on near-white with a light green,
// and the artifacts it hosts bring their own colours.
import type { Metadata } from "next";
import "./globals.css";
import WelcomeBurst from "@/components/welcome-burst";
import FolderSync from "@/components/folder-sync";
import { LocaleProvider } from "@/components/locale-provider";
import { getLocale, getT } from "@/lib/i18n-server";

import { platformCopy } from "@/lib/platform-copy";

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

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import MePage from "../../src/components/me-page";
import NavigationShell from "../../src/components/navigation-shell";
import { AuthConfigProvider } from "../../src/components/auth-config-provider";
import { LocaleProvider } from "../../src/components/locale-provider";
import type { DirectoryPage } from "../../src/lib/directory-query";

const directory: DirectoryPage = {
  sites: [], permissions: {}, total: 0, ownedTotal: 33,
  query: { scope: "owned", page: 0, q: "", sort: "updated", folder: "all" },
  counts: { all: 0, unfiled: 0, byId: {} }, folders: { folders: [], assign: {} },
};

function Fixture() {
  const [refreshes, setRefreshes] = useState(0);
  useEffect(() => {
    const refreshed = () => setRefreshes(count => count + 1);
    window.addEventListener("fixture:refresh", refreshed);
    return () => window.removeEventListener("fixture:refresh", refreshed);
  }, []);
  return <LocaleProvider locale="en"><AuthConfigProvider enabled hasSessionHint>
    <output data-refreshes>{refreshes}</output>
    <NavigationShell><MePage userId="reader" allSites={[]} directory={directory} /></NavigationShell>
  </AuthConfigProvider></LocaleProvider>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);

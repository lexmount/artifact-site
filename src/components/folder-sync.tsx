"use client";

// Mounted app-wide (see app/layout.tsx): the moment a page loads for a signed-in user, any folder
// shelf this browser still keeps locally is handed over to the account — without anyone opening
// "My sites". Renders nothing. Idempotent per user per page load (lib/folder-shelf.syncLocalShelf).
import { useEffect } from "react";
import { syncLocalShelf } from "@/lib/folder-shelf";
import { useAuth } from "@/lib/use-auth";

export default function FolderSync() {
  const { user } = useAuth();
  useEffect(() => {
    if (!user) return;
    void syncLocalShelf(user.id).catch(() => { /* the next page load tries again */ });
  }, [user]);
  return null;
}

"use client";
import { useCallback, useLayoutEffect, useRef } from "react";
import { useAuth } from "@/lib/use-auth";
import { learnHint } from "@/lib/coachmarks";

/** Keep early interactions until identity is known, without changing event-handler identity. */
export function useLearnHint() {
  const { user, loading } = useAuth();
  const owner = useRef<string | null>(null);
  const pending = useRef(new Set<string>());
  useLayoutEffect(() => {
    owner.current = loading ? null : user?.id ?? "browser";
    if (owner.current === null) return;
    for (const name of pending.current) learnHint(owner.current, name);
    pending.current.clear();
  }, [loading, user?.id]);
  return useCallback((name: string) => {
    if (owner.current === null) pending.current.add(name);
    else learnHint(owner.current, name);
  }, []);
}

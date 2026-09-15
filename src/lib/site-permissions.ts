"use client";
import { useEffect, useState } from "react";
import type { SitePermissions } from "@/lib/authz";
import { useStoredToken } from "@/lib/edit-token";
import { siteFetch } from "@/lib/share-context";
/** Local receipts are submitted for verification; only the server's answer enables an action. */
export function useSitePermissions(slug: string, initial?: SitePermissions) {
    const token = useStoredToken(slug);
    const [resolved, setResolved] = useState<{
        slug: string;
        permissions: SitePermissions;
    } | null>(null);
    useEffect(() => {
        let alive = true;
        siteFetch(`/api/sites/${slug}/permissions`, {
            method: token ? "POST" : "GET",
            headers: token ? { "x-edit-token": token } : {}, cache: "no-store",
        }).then(async (res) => res.ok ? await res.json() : null).then(body => {
            if (alive && body?.permissions)
                setResolved({ slug, permissions: body.permissions });
        }).catch(() => { });
        return () => { alive = false; };
    }, [slug, token]);
    return resolved?.slug === slug ? resolved.permissions : initial;
}
export function usePermissionsForSites(slugs: string[], tokens: Record<string, string>) {
    const key = JSON.stringify(slugs.map(slug => [slug, tokens[slug] ?? ""]));
    const [result, setResult] = useState<Record<string, SitePermissions>>({});
    useEffect(() => {
        let alive = true;
        const pairs = JSON.parse(key) as [
            string,
            string
        ][];
        Promise.all(pairs.map(async ([slug, token]) => {
            const res = await siteFetch(`/api/sites/${slug}/permissions`, { method: "GET", headers: token ? { "x-edit-token": token } : {}, cache: "no-store" });
            return [slug, res.ok ? (await res.json()).permissions : undefined] as const;
        })).then(entries => { if (alive)
            setResult(Object.fromEntries(entries.filter(([, permissions]) => permissions))); }).catch(() => { });
        return () => { alive = false; };
    }, [key]);
    return result;
}

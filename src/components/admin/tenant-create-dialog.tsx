"use client";
import { useEffect, useState } from "react";
import { useT } from "@/components/locale-provider";
import { adminFetch } from "./format";
import TenantFormDialog from "./tenant-form-dialog";

export default function TenantCreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const t = useT();
  const [name, setName] = useState(""), [slug, setSlug] = useState(""), [email, setEmail] = useState("");
  const [availability, setAvailability] = useState<{ slug: string; available: boolean } | null>(null);
  const [checkError, setCheckError] = useState("");
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      if (!/^[a-z][a-z0-9-]{1,62}$/.test(slug)) return;
      adminFetch<{ slug: string; available: boolean }>(`/api/admin/tenants/availability?slug=${encodeURIComponent(slug)}`)
        .then(result => { if (alive) { setAvailability(result); setCheckError(""); } })
        .catch(e => { if (alive) setCheckError(e.message); });
    }, 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [slug]);
  return <TenantFormDialog title={t("Create tenant")} confirmLabel={t("Create tenant")} onClose={onClose} disabled={!name.trim() || !email || !availability?.available || availability.slug !== slug} onSubmit={async () => {
    await adminFetch("/api/tenants", { method: "POST", body: { name: name.trim(), slug, adminEmail: email.trim() } }); await onCreated();
  }}>
    <label>{t("Tenant name")}<input autoFocus required maxLength={100} value={name} onChange={e => setName(e.target.value)}/></label>
    <label>{t("English identifier")}<input required minLength={2} maxLength={63} pattern="[a-z][a-z0-9-]{1,62}" autoCapitalize="none" spellCheck={false} value={slug} onChange={e => { setSlug(e.target.value.toLowerCase().trim()); setAvailability(null); setCheckError(""); }}/></label>
    <p>{t("2–63 lowercase letters, digits or hyphens. Start with a letter. Cannot be changed later.")}</p>
    <p role="status">{checkError ? t(checkError) : availability?.slug === slug ? t(availability.available ? "Identifier available" : "This workspace identifier is already in use") : slug ? t("Enter a valid identifier to check availability.") : ""}</p>
    <label>{t("First administrator email")}<input required type="email" value={email} onChange={e => setEmail(e.target.value)}/></label>
    <p>{t("Use an active account that has already signed in with a verified email.")}</p>
    <p>{t("Creating a tenant does not change the administrator's default publishing tenant.")}</p>
  </TenantFormDialog>;
}

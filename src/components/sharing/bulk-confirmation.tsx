"use client";
import { useEffect, useId, useRef } from "react";
import { useT } from "@/components/locale-provider";
import { countText } from "@/lib/i18n";
import type { BulkSharingItem } from "@/lib/bulk-sharing-model";
import { SharingDialog } from "./scope-dialog";

export default function BulkSharingConfirmation({ items, listInDiscover, onListingChange, onClose, onSubmit }: {
  items: BulkSharingItem[];
  listInDiscover: boolean | undefined;
  onListingChange: (value: boolean) => void;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  const t = useT(), id = useId(), checkbox = useRef<HTMLInputElement>(null);
  const listed = items.filter(item => item.policy.audience === "public").length;
  const retained = items.filter(item => (item.requestedPolicy ?? item.policy).audience === "public").length;
  const allListed = retained === items.length;
  const mixed = listInDiscover === undefined && retained > 0 && !allListed;
  const checked = listInDiscover ?? allListed;
  const adding = listInDiscover && !allListed;
  useEffect(() => { if (checkbox.current) checkbox.current.indeterminate = mixed; }, [mixed]);
  return <SharingDialog
    title={countText(t, items.length, "Allow anyone to access this site?", "Allow anyone to access these {n} sites?")}
    description={countText(t, items.length, "Anyone with the link can access this site without signing in.", "Anyone with a link can access these {n} sites without signing in.")}
    className="sharing-confirmation sharing-access-confirmation bulk-sharing-confirmation" alert danger
    onClose={onClose} onBack={onClose} onSubmit={onSubmit} confirmLabel={t(adding ? "Allow access and list" : "Allow access")}>
    <div className="sharing-discovery">
      <label className="bulk-discover-choice" htmlFor={id}>
        <span>{t("Also list in Discover")}</span>
        <input ref={checkbox} id={id} type="checkbox" checked={checked}
          aria-checked={mixed ? "mixed" : checked} aria-describedby={`${id}-status`}
          onChange={event => onListingChange(event.target.checked)}/>
      </label>
      <p id={`${id}-status`} aria-live="polite">{listInDiscover !== undefined
        ? countText(t, listInDiscover ? items.length : 0, "1 site will be listed in Discover", "{n} sites will be listed in Discover")
        : allListed ? t("All selected sites are already listed in Discover.")
        : t("{listed} of {total} sites already listed in Discover", { listed, total: items.length })}</p>
    </div>
  </SharingDialog>;
}

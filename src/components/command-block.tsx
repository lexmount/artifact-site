"use client";

// One line an agent can be handed, on a black bar, with a copy button. Used by the home page's
// "or let an agent publish it" and by the agent guide (there in a larger size).
import { useState } from "react";
import { useT } from "@/components/locale-provider";

export default function CommandBlock({ command, size = "normal", copyLabel, disabled = false }: { command: string; size?: "normal" | "large"; copyLabel?: string; disabled?: boolean }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(command); } catch { return; } // the text is selectable; leave manual copying to the person
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }
  return (
    <div className={`command${size === "large" ? " command-large" : ""}`}>
      <code>{command}</code>
      <button type="button" disabled={disabled} onClick={copy} aria-label={copyLabel ?? t("Copy the publish prompt")}>{copied ? t("Copied") : t("Copy")}</button>
    </div>
  );
}

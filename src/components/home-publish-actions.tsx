"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useT } from "@/components/locale-provider";
import Uploader from "@/components/uploader";
import BookmarkletLink from "@/components/bookmarklet-link";
import { agentPrompt } from "@/lib/agent-prompt";

export default function HomePublishActions({ base }: { base: string }) {
  const t = useT();
  const prompt = agentPrompt(base, t);
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  const fallback = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => { if (manual) { fallback.current?.focus(); fallback.current?.select(); } }, [manual]);

  async function copy() {
    if (timer.current) clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(prompt);
      setManual(false); setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 2400);
    } catch {
      setCopied(false); setManual(true);
      fallback.current?.focus(); fallback.current?.select();
    }
  }

  return <div className="home-publish-actions">
    <div className="home-action-row">
      <button type="button" className="btn solid home-copy-prompt" onClick={copy}>
        {copied ? <Check size={17} aria-hidden="true" /> : <Copy size={17} aria-hidden="true" />}
        <span className="home-copy-label"><span aria-hidden={copied}>{t("Copy prompt for agent")}</span>{copied && <span className="home-copied">{t("Copied")}</span>}</span>
      </button>
      <Uploader inline footerAction={<>
        <Link role="menuitem" className="menu-item" href="/me?intent=update">{t("Update an existing artifact →")}</Link>
        <BookmarkletLink menuItem />
      </>} />
    </div>
    <span className="sr-only home-copy-status" role="status">{copied ? t("Copied") : ""}</span>
    <p className="home-action-hint">{t("Copy, then paste into the agent you already use.")}</p>
    <Link className="agent-connect-link home-connect" href="/for-agents#cli">{t("CLI / MCP connection →")}</Link>
    {manual && <div className="home-copy-fallback">
      <label htmlFor="agent-prompt-fallback" role="alert">{t("Could not copy automatically. Select the prompt below and copy it manually.")}</label>
      <textarea id="agent-prompt-fallback" ref={fallback} value={prompt} readOnly rows={5} />
    </div>}
  </div>;
}

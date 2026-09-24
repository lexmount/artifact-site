"use client";
import { Check, Globe, Link2, Loader2, MessageCircle } from "lucide-react";
import { useT } from "@/components/locale-provider";

type Audience = "public" | "login";
const options = [
  {policy:"public", Icon:Globe, title:"Anyone can view", description:"Anyone with the link can view it. New quick links expire in 30 days."},
  {policy:"login", Icon:MessageCircle, title:"Signed-in users can view and comment", description:"Sign in to view and comment. New quick links expire in 30 days."},
] as const;

/** The two audiences share one interaction and layout, including clipboard feedback. */
export default function QuickShareOptions({busy, copied, onCopy}: {
  busy: Audience | null;
  copied: Audience | null;
  onCopy: (audience: Audience) => Promise<void>;
}) {
  const t = useT();
  return <div className="share-quick-options">{options.map(({policy, Icon, title, description}) =>
    <article className="share-quick-option" key={policy}>
      <span className="share-quick-icon"><Icon size={16} aria-hidden="true" /></span>
      <div><b>{t(title)}</b><p>{t(description)}</p></div>
      <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void onCopy(policy)}>
        {busy === policy ? <Loader2 size={13} className="spin" /> : copied === policy ? <Check size={13} /> : <Link2 size={13} />}
        {t(copied === policy ? "Copied" : "Copy link")}
      </button>
    </article>,
  )}</div>;
}

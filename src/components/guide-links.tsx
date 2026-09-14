"use client";

// The guide's jump links. Their targets are collapsed <details>, so following the anchor alone would
// scroll to a closed summary: open the target first, then let the anchor do the scrolling — and do
// the same once on mount for a visitor who arrives with the hash already in the URL.
import { useEffect } from "react";

export default function GuideLinks({ links, external }: {
  links: { id: string; label: string }[];
  external: { href: string; label: string };
}) {
  const open = (id: string) => {
    const el = document.getElementById(id);
    if (el instanceof HTMLDetailsElement) el.open = true;
  };
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    open(id);
    document.getElementById(id)?.scrollIntoView();
  }, []);
  return (
    <div className="guide-links">
      {links.map((l) => <a key={l.id} href={`#${l.id}`} onClick={() => open(l.id)}>{l.label}</a>)}
      <a href={external.href} target="_blank" rel="noopener">{external.label}</a>
    </div>
  );
}

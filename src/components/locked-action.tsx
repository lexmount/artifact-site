"use client";

// A write affordance the viewer cannot currently use, rendered so the reason is legible at a
// glance instead of hidden in a `title` attribute — which needs a two-second hover to appear and
// does not exist at all on touch.
//
// Deliberately still a button, not a disabled one: clicking opens the gate dialog, which is where
// the "why" and the consequences of signing in are explained. A disabled control would answer
// neither question and, per the design system's own note, gives touch users no recourse at all.
import { Lock } from "lucide-react";
import type { ReactNode } from "react";

export default function LockedAction({
  label,
  icon,
  hint,
  onOpen,
  variant = "button",
}: {
  label: string;
  icon: ReactNode;
  /** Short suffix stating what stands between the viewer and the action, e.g. "sign in required". */
  hint: string;
  onOpen: () => void;
  /** "menu-item" renders as a row of a More menu instead of a bar button. */
  variant?: "button" | "menu-item";
}) {
  if (variant === "menu-item") {
    return (
      <button type="button" role="menuitem" className="menu-item locked" onClick={onOpen} aria-label={`${label} (${hint})`}>
        <span className="locked-icon" aria-hidden="true">{icon}</span>
        {label}
        <span className="locked-hint"><Lock size={11} aria-hidden="true" /> {hint}</span>
      </button>
    );
  }
  return (
    <button type="button" className="btn sm locked" onClick={onOpen} aria-label={`${label} (${hint})`}>
      <span className="locked-icon" aria-hidden="true">{icon}</span>
      {label}
      <span className="locked-hint">
        <Lock size={11} aria-hidden="true" /> {hint}
      </span>
    </button>
  );
}

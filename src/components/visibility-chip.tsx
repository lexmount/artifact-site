// "Can this be shown to people?" — a small marker attached after the title.
//
// It exists because of a real incident: a private site was sent around as an ordinary link, the
// recipients saw only a 404, and neither side knew why. Nothing anywhere in the list had hinted that
// it was private — at the moment of sharing, that information was simply not at hand.
//
// So the marker appears only when a reminder is needed: public is the default and not worth the
// space; private and unlisted each get their own mark, because sending them out has different
// outcomes (the former cannot be opened by the recipient; the latter can be viewed by anyone with the
// link).
import { Lock, EyeOff } from "lucide-react";
import type { Visibility } from "@/lib/types";
import { useT } from "@/components/locale-provider";

const MARKS = {
  private: {
    icon: Lock,
    label: "Private",
    hint: "Only you and your collaborators can open this address. To show it to others, create a share link under \"Sharing\".",
  },
  unlisted: {
    icon: EyeOff,
    label: "Unlisted",
    hint: "Not shown on the home page, but anyone with this address can open it.",
  },
} as const;

export default function VisibilityChip({ visibility, contextualHint = false }: { visibility?: Visibility; contextualHint?: boolean }) {
  const t = useT();
  // Public needs no reminder; `undefined` means "unknown" (the Recently viewed list cannot
  // reconstruct visibility) and stays silent too — the cost of guessing wrong is letting someone
  // believe it is safe to share.
  if (!visibility || visibility === "public") return null;
  const mark = MARKS[visibility];
  if (!mark) return null;
  const Icon = mark.icon;
  const Tag = contextualHint ? "button" : "span";
  return (
    <Tag type={contextualHint ? "button" : undefined} className={`vis-chip vis-${visibility}`} title={contextualHint ? undefined : t(mark.hint)}>
      <Icon size={11} aria-hidden="true" />
      {t(mark.label)}
    </Tag>
  );
}

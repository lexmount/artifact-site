"use client";

// The dialog shown when someone reaches for an action they are not signed in for.
//
// It is deliberately NOT shown on arrival. Reading is anonymous by product promise (PRODUCT.md:
// "viewers can view and demo with just the link, no sign-in required") and most visitors only came to look at something a colleague
// sent them; a door on the way in would turn "sharing" into "requesting access". So the gate is
// tied to intent — it appears only once the viewer actually asks to do the thing.
//
// Being intent-triggered is also what earns it the right to explain the one consequence nobody
// would otherwise discover: signing in adopts every site this browser created anonymously into the
// account. That happens today, silently, in the OIDC callback. Announcing it beforehand is the
// difference between a helpful migration and finding your sites reassigned without being asked.
import { useCallback, useEffect, useRef } from "react";
import { LogIn, Lock, X } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { countText } from "@/lib/i18n";

/** What the viewer was reaching for — each states its own reason, in the product's own verbs. */
export type GateAction = "edit" | "share" | "rename" | "rollback" | "delete";

const REASON: Record<GateAction, { title: string; body: string }> = {
  edit: {
    title: "Sign in to edit",
    body: "Viewing and sharing need no sign-in. Changing the content does, so every version has a recorded author and can be recovered if something breaks.",
  },
  share: {
    title: "Sign in to set the sharing scope",
    body: "Anyone with the link can view — that does not change. Deciding who can edit means knowing who you are first.",
  },
  rename: { title: "Sign in to rename", body: "The site name is visible to every visitor; only the site's owner can change it." },
  rollback: { title: "Sign in to roll back", body: "A rollback changes what every visitor sees; only the site's owner can do it." },
  delete: { title: "Sign in to delete", body: "Deleting makes the link stop working immediately; only the site's owner can do it." },
};

export default function LoginGate({
  action,
  returnTo,
  pendingAdoptions,
  onClose,
}: {
  action: GateAction;
  /** Where to land after the round-trip — the page the viewer was on, not the home page. */
  returnTo: string;
  /**
   * How many sites this browser made anonymously and would hand over on sign-in. Null when the
   * count is unknown; the sentence is then omitted rather than guessed at.
   */
  pendingAdoptions: number | null;
  onClose: () => void;
}) {
  const t = useT();
  const dialog = useRef<HTMLDivElement | null>(null);
  const primary = useRef<HTMLAnchorElement | null>(null);
  const restoreFocus = useRef<Element | null>(null);
  const { title, body } = REASON[action];

  const close = useCallback(() => {
    onClose();
    // Send focus back where it came from; a dialog that dumps focus at the top of the document
    // makes a keyboard user re-traverse the whole header to get back to what they clicked.
    if (restoreFocus.current instanceof HTMLElement) restoreFocus.current.focus();
  }, [onClose]);

  useEffect(() => {
    restoreFocus.current = document.activeElement;
    primary.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        close();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      // Trap Tab inside the dialog: it is modal, so letting focus wander into the page behind it
      // would let a keyboard user operate controls they cannot see.
      const focusable = dialog.current.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)");
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const loginHref = `/api/auth/login?return_to=${encodeURIComponent(returnTo)}`;

  return (
    <div className="gate-scrim" role="presentation" onClick={close}>
      <div
        ref={dialog}
        className="gate"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gate-title"
        aria-describedby="gate-body"
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="gate-close" onClick={close} aria-label={t("Close")}>
          <X size={15} />
        </button>

        <div className="gate-head">
          <span className="gate-mark" aria-hidden="true"><Lock size={17} /></span>
          <div>
            <h2 id="gate-title">{t(title)}</h2>
            <p id="gate-body">{t(body)}</p>
          </div>
        </div>

        {pendingAdoptions != null && pendingAdoptions > 0 && (
          <p className="gate-note">
            {t("After signing in, the")} <b>{countText(t, pendingAdoptions, "{n} site", "{n} sites")}</b> {t("this browser created will move under your account, so you can keep managing them from another computer.")}
          </p>
        )}

        <div className="gate-actions">
          <a ref={primary} className="btn solid" href={loginHref}>
            <LogIn size={14} /> {t("Sign in with your company account")}
          </a>
          <button type="button" className="btn ghost" onClick={close}>{t("Keep browsing")}</button>
        </div>
      </div>
    </div>
  );
}

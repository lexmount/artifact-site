"use client";

// A "···" button that folds secondary actions into a small menu, so the action bar keeps its
// width for the title and the primary actions. The menu is portaled to <body> and positioned
// from the button's rect: the bar scrolls horizontally on narrow screens (overflow-x: auto), and
// an in-place absolute menu would be clipped by it.
//
// Items are the children — buttons or links carrying `role="menuitem" className="menu-item"`.
// Any click on a menu item closes the menu. The menu is hidden, never unmounted: an item such as
// VersionHistory owns the state of the drawer it opens, and unmounting it with the menu would
// close the drawer in the same tick it was opened.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";

export default function MoreMenu({ label, iconOnly = false, buttonClassName, buttonContent, disabled, onOpenChange, children }: {
  label: string;
  /** Just the "···" glyph; the label becomes the accessible name. */
  iconOnly?: boolean;
  /** Replace the trigger's classes (e.g. the row's bare "⋯", or the upload split button's caret). */
  buttonClassName?: string;
  /** Replace the trigger's content; with iconOnly the label still becomes the accessible name. */
  buttonContent?: ReactNode;
  disabled?: boolean;
  /** Reported on open/close so a host that auto-hides (the viewer's action bar) can hold still. */
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();

  const place = useCallback(() => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  }, []);

  const toggle = useCallback(() => {
    if (!open) place();
    setOpen((o) => !o);
  }, [open, place]);

  useEffect(() => { onOpenChange?.(open); return () => onOpenChange?.(false); }, [open, onOpenChange]);

  // Close on outside pointerdown, Escape, resize; keep the position honest while open. A click into
  // the hosted artifact is a pointerdown inside an iframe, which the parent document never sees —
  // the only trace it leaves is focus moving into the frame, i.e. a window blur. That path also
  // closes the menu on a tab switch, which is harmless.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menu.current?.contains(t) || button.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); button.current?.focus(); } };
    const onBlur = () => setOpen(false);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  const host = typeof document !== "undefined" ? document.body : null;

  return (
    <>
      <button
        ref={button}
        type="button"
        className={buttonClassName ?? `btn sm ghost more-button${iconOnly ? " icon-only" : ""}`}
        aria-label={iconOnly ? label : undefined}
        title={iconOnly ? label : undefined}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={toggle}
      >
        {buttonContent ?? <><MoreHorizontal size={iconOnly ? 18 : 14} aria-hidden="true" />{iconOnly ? null : <> {label}</>}</>}
      </button>
      {host && createPortal(
        <div
          ref={menu}
          id={id}
          role="menu"
          className="more-menu"
          hidden={!open || !pos}
          style={pos ? { top: pos.top, right: pos.right } : undefined}
          // Any activated item closes the menu — after the item's own handler has run (bubbling order).
          // Focus goes back to the button: the item it was on is about to be display:none.
          onClick={(e) => { if ((e.target as HTMLElement).closest('[role="menuitem"]')) { setOpen(false); button.current?.focus(); } }}
        >
          {children}
        </div>,
        host,
      )}
    </>
  );
}

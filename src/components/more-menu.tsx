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
import { useCallback, useEffect, useLayoutEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { menuPosition } from "@/lib/menu-position";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";

const subscribeToHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

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
  const [pos, setPos] = useState<ReturnType<typeof menuPosition> | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();

  const place = useCallback(() => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const size = menu.current?.getBoundingClientRect();
    const viewport = window.visualViewport;
    const next = menuPosition(r, size?.width ?? 0, size?.height ?? 0, {
      left: viewport?.offsetLeft ?? 0,
      top: viewport?.offsetTop ?? 0,
      width: viewport?.width ?? window.innerWidth,
      height: viewport?.height ?? window.innerHeight,
    });
    setPos((previous) => previous && previous.top === next.top && previous.left === next.left
      && previous.maxHeight === next.maxHeight && previous.maxWidth === next.maxWidth ? previous : next);
  }, []);

  // Measure the visible menu before paint, including its viewport-constrained height.
  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  const toggle = useCallback(() => {
    if (!open) place();
    setOpen((o) => !o);
  }, [open, place]);

  useEffect(() => { onOpenChange?.(open); return () => onOpenChange?.(false); }, [open, onOpenChange]);

  // Close on outside pointerdown, outside scroll or Escape; reposition as the viewport changes. A click into
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
    const anchor = button.current?.getBoundingClientRect();
    const onScroll = (e: Event) => {
      // Scrolling a tall menu must not move it or reset its scroll position.
      if (e.target instanceof Node && menu.current?.contains(e.target)) return;
      // A queued pre-open scroll or an unrelated panel must not dismiss this menu.
      const current = button.current?.getBoundingClientRect();
      if (anchor && current && current.top === anchor.top && current.left === anchor.left) return;
      if (menu.current?.contains(document.activeElement)) button.current?.focus({ preventScroll: true });
      setOpen(false);
    };
    const viewport = window.visualViewport;
    const observer = new ResizeObserver(place);
    if (menu.current) observer.observe(menu.current);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", onScroll, true);
    viewport?.addEventListener("resize", place);
    viewport?.addEventListener("scroll", place);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", onScroll, true);
      viewport?.removeEventListener("resize", place);
      viewport?.removeEventListener("scroll", place);
      observer.disconnect();
    };
  }, [open, place]);

  // The first hydrated tree must match SSR, where portals cannot be rendered. React switches
  // this snapshot after hydration; the hidden menu then stays mounted for its child drawers.
  const hydrated = useSyncExternalStore(subscribeToHydration, clientSnapshot, serverSnapshot);
  const host = hydrated ? document.body : null;

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
          style={pos ? { ...pos, "--menu-max-width": `${pos.maxWidth}px` } as CSSProperties : undefined}
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

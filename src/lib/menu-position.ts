type Anchor = { top: number; bottom: number; right: number };
type Viewport = { left: number; top: number; width: number; height: number };

/** Position a body-portaled menu in layout coordinates, inside the visible viewport. */
export function menuPosition(anchor: Anchor, width: number, height: number, viewport: Viewport) {
  const maxHeight = Math.max(0, viewport.height - 16);
  const maxWidth = Math.max(0, viewport.width - 16);
  const visibleHeight = Math.min(height, maxHeight);
  const visibleWidth = Math.min(width, maxWidth);
  const bottom = viewport.top + viewport.height - 8;
  const right = viewport.left + viewport.width - 8;
  const below = anchor.bottom + 6;
  const preferred = below + visibleHeight <= bottom ? below : anchor.top - 6 - visibleHeight;
  // If neither side fits, the scrollable menu may cover its trigger to keep all actions reachable.
  return {
    top: Math.max(viewport.top + 8, Math.min(preferred, bottom - visibleHeight)),
    left: Math.max(viewport.left + 8, Math.min(anchor.right - visibleWidth, right - visibleWidth)),
    maxHeight,
    maxWidth,
  };
}

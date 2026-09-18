/** Normalized crop-box coordinates, independent of viewport zoom and scroll. */
export type Point = { x: number; y: number };
export type Rotation = 0 | 90 | 180 | 270;
export function unrotatePoint(p: Point, rotation: Rotation): Point {
  switch (rotation) {
    case 90: return { x: p.y, y: 1 - p.x };
    case 180: return { x: 1 - p.x, y: 1 - p.y };
    case 270: return { x: 1 - p.y, y: p.x };
    default: return p;
  }
}
export function rotatePoint(p: Point, rotation: Rotation): Point {
  return unrotatePoint(p, ((360 - rotation) % 360) as Rotation);
}
export function normalizedPoint(client: Point, bounds: { left: number; top: number; width: number; height: number }, rotation: Rotation = 0): Point | null {
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const p = { x: (client.x - bounds.left) / bounds.width, y: (client.y - bounds.top) / bounds.height };
  if (p.x < 0 || p.y < 0 || p.x > 1 || p.y > 1) return null;
  return unrotatePoint(p, rotation);
}
export function regionBetween(a: Point, b: Point) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

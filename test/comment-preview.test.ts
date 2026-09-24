import { describe, expect, it } from "vitest";
import { acceptPreviewCommentEvent } from "@/lib/comments/preview-channel";
import { normalizedPoint, rotatePoint, unrotatePoint, regionBetween, type Rotation } from "@/lib/comments/geometry";
import type { CommentScope } from "@/lib/comments/contracts";
const scope: CommentScope = { siteId: "site", versionId: "old", entry: { kind: "main" } };
const source = {} as Window;
const expected = { source, channelId: "dc41869c-e1dd-46a2-93e1-7c58217737ae", scope, selecting: true };
const data = { protocol: "artifact-comments", schemaVersion: 1, channelId: expected.channelId, scope, event: { type: "selected", anchor: { kind: "document", schemaVersion: 1, filePath: "index.html" } } };
describe("preview host boundary", () => {
  it("accepts only the current frame, scope, channel and selection state", () => {
    expect(acceptPreviewCommentEvent({ source, data }, expected)).not.toBeNull();
    expect(acceptPreviewCommentEvent({ source: {} as Window, data }, expected)).toBeNull();
    expect(acceptPreviewCommentEvent({ source, data }, { ...expected, selecting: false })).toBeNull();
    expect(acceptPreviewCommentEvent({ source, data }, { ...expected, channelId: crypto.randomUUID() })).toBeNull();
    expect(acceptPreviewCommentEvent({ source, data }, { ...expected, scope: { ...scope, versionId: "new" } })).toBeNull();
    expect(acceptPreviewCommentEvent({ source, data }, { ...expected, scope: { ...scope, entry: { kind: "share", shareId: "share" } } })).toBeNull();
  });
  it("requires explicit text-selection capability independently of position picking", () => {
    const payload = {...data, event:{...data.event,type:"text-selected"}};
    expect(acceptPreviewCommentEvent({source,data:payload},expected)).toBeNull();
    expect(acceptPreviewCommentEvent({source,data:payload},{...expected,selecting:false,canSelectText:true})).not.toBeNull();
    expect(acceptPreviewCommentEvent({source:{} as Window,data:payload},{...expected,canSelectText:true})).toBeNull();
    expect(acceptPreviewCommentEvent({source,data:payload},{...expected,canSelectText:true,scope:{...scope,versionId:"another"}})).toBeNull();
  });
  it("rejects unknown keys, oversized/cyclic messages and unsolicited location responses", () => {
    expect(acceptPreviewCommentEvent({ source, data: { ...data, token: "untrusted" } }, expected)).toBeNull();
    expect(acceptPreviewCommentEvent({ source, data: { ...data, junk: "x".repeat(65537) } }, expected)).toBeNull();
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(acceptPreviewCommentEvent({ source, data: cyclic }, expected)).toBeNull();
    const located = { ...data, event: { type: "located", threadId: "a", outcome: "exact" } };
    expect(acceptPreviewCommentEvent({ source, data: located }, expected)).toBeNull();
    expect(acceptPreviewCommentEvent({ source, data: located }, { ...expected, pendingThreadId: "a" })).not.toBeNull();
  });
});
describe("anchor geometry", () => {
  it.each([0, 90, 180, 270] as Rotation[])("round trips rotation %s without changing the original point", angle => {
    const point = { x: .2, y: .7 };
    const result = unrotatePoint(rotatePoint(point, angle), angle);
    expect(result.x).toBeCloseTo(point.x); expect(result.y).toBeCloseTo(point.y);
  });
  it("excludes viewer padding and normalizes actual scroll/zoom bounds", () => {
    expect(normalizedPoint({ x: 60, y: 100 }, { left: 20, top: -100, width: 200, height: 400 })).toEqual({ x: .2, y: .5 });
    expect(normalizedPoint({ x: 0, y: 100 }, { left: 20, top: 0, width: 200, height: 400 })).toBeNull();
    expect(regionBetween({ x: .8, y: .7 }, { x: .2, y: .3 })).toMatchObject({ x: .2, y: .3 });
  });
});

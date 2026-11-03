import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import PolicyFields from "@/components/sharing/policy-fields";
import AudienceCards from "@/components/sharing/audience-cards";
import type { DocumentSharingState } from "@/components/sharing/main-sharing-model";
import { draggedSites, needsMoveConfirmation } from "@/lib/folder-move";
import type { SharingPreview } from "@/lib/sharing-policy";

it("hides organization access for init users even when a legacy policy is selected", () => {
  const policy = { audience: "tenant" as const, comments: true };
  const html = renderToStaticMarkup(createElement(PolicyFields, { value: policy, onChange: () => {}, includeOrganization: false }));
  expect(html).not.toContain('value="tenant"');
  expect(html).toContain("Choose access");
  expect(html).toContain("Current access");
  const data: DocumentSharingState = { policy, source: "manual", sourceId: null, sourceName: null, revision: 1, pending: false, links: 0, members: 0, canStop: true, follow: null, organization: { name: "Initial", canSelect: false } };
  const cards = renderToStaticMarkup(createElement(AudienceCards, { data, disabled: false, onChange: () => {}, onReset: async () => {} }));
  expect(cards).not.toContain('value="tenant"');
  expect(cards).toContain("Current access");
});

it("aligns scope audience wording and order with artifact sharing", () => {
  const html = renderToStaticMarkup(createElement(PolicyFields, { value: { audience: "private", comments: false }, onChange: () => {}, includeOrganization: true }));
  expect(html).toContain('value="tenant"');
  expect(html).toContain("Private");
  expect(html).toContain("Members of this organization");
  expect(html).not.toContain("Members of each document&#x27;s tenant");
});

it("drags the selection only when the dragged site belongs to it", () => {
  expect(draggedSites("a", ["a", "b"])).toEqual(["a", "b"]);
  expect(draggedSites("c", ["a", "b"])).toEqual(["c"]);
});

it("confirms inheritance changes even when the effective audience is unchanged", () => {
  const preview: SharingPreview = { confirmation: "review", excluded: 0, unchanged: 1, items: [] };
  expect(needsMoveConfirmation(preview)).toBe(false);
  preview.items.push({ slug: "a", title: "A", tenantName: "Team", before: { audience: "private", comments: false }, after: { audience: "private", comments: false }, changed: false, source: "folder", sourceName: "Design" });
  expect(needsMoveConfirmation(preview)).toBe(true);
});

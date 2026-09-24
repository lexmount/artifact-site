import { describe, expect, it } from "vitest";
import { readAcknowledgements, acknowledgeShareEducation, shouldShowShareEducation, educationKey, isShareEducationStorageKey } from "@/lib/share-education";

function memory() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
describe("private-site education", () => {
  it("refreshes only education changes or storage clearing", () => {
    expect(isShareEducationStorageKey(educationKey("alice", "site"))).toBe(true);
    expect(isShareEducationStorageKey(null)).toBe(true);
    expect(isShareEducationStorageKey("locale")).toBe(false);
    expect(isShareEducationStorageKey("artifact-site:header-pinned")).toBe(false);
  });
  it("requires three separate acknowledgements for each viewer and site", () => {
    const storage = memory();
    for (let n = 1; n <= 3; n++) expect(acknowledgeShareEducation(storage, "alice", "site-a")).toBe(n);
    expect(shouldShowShareEducation(readAcknowledgements(storage, "alice", "site-a"), 0)).toBe(false);
    expect(readAcknowledgements(storage, "alice", "site-b")).toBe(0);
    expect(readAcknowledgements(storage, "bob", "site-a")).toBe(0);
    expect(acknowledgeShareEducation(storage, "alice", "site-a")).toBe(3);
  });
  it("stops all site lessons after three server-side historical links", () => {
    expect(shouldShowShareEducation(0, 2)).toBe(true);
    expect(shouldShowShareEducation(0, 3)).toBe(false);
  });
  it("does not throw when storage is corrupt or unavailable", () => {
    expect(readAcknowledgements({getItem: () => "oops", setItem: () => {}}, "a", "b")).toBe(0);
    expect(acknowledgeShareEducation({getItem: () => {throw Error();}, setItem: () => {throw Error();}}, "a", "b")).toBe(1);
  });
});

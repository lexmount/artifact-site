import { describe, expect, it } from "vitest";
import {
  accessAudience, changeAudience, changeDiscovery, sharingChangeEffects,
} from "@/components/sharing/main-sharing-model";
import type { SharingPolicy, SharingState } from "@/lib/sharing-policy";
const policy = (audience: SharingPolicy["audience"], comments = true): SharingPolicy => ({ audience, comments });
const state = (audience: SharingPolicy["audience"], source: SharingState["source"] = "manual"): SharingState => ({
  policy: policy(audience), source, sourceId: null, sourceName: null, revision: 1, pending: false,
});
describe("main sharing transitions", () => {
  it("separates Discover listing from the audience without changing server policy values", () => {
    expect(accessAudience(policy("public"))).toBe("anyone");
    expect(changeAudience(policy("public"), "anyone")).toEqual(policy("public"));
    expect(changeAudience(policy("public"), "tenant")).toEqual(policy("tenant"));
    expect(changeDiscovery(policy("tenant"), true)).toEqual(policy("tenant"));
    expect(changeDiscovery(policy("passcode"), true)).toEqual(policy("passcode"));
    expect(changeAudience(changeAudience(policy("public"), "passcode"), "anyone")).toEqual(policy("anyone"));
    expect(changeDiscovery(policy("public", false), false)).toEqual(policy("anyone", false));
  });
  it("confirms expanding to anonymous access, including listing from a restricted audience", () => {
    for (const from of ["private", "tenant", "login"] as const) {
      expect(sharingChangeEffects(state(from), policy("anyone"))).toMatchObject({ publicAccess: true, listing: false, confirm: true });
      expect(sharingChangeEffects(state(from), policy("public"))).toMatchObject({ publicAccess: true, listing: true, confirm: true });
    }
  });
  it("updates ordinary audience, comment and discovery changes directly", () => {
    for (const next of [policy("private"), policy("login"), policy("tenant", false)])
      expect(sharingChangeEffects(state("tenant"), next).confirm).toBe(false);
    expect(sharingChangeEffects(state("anyone"), policy("public")).confirm).toBe(false);
    expect(sharingChangeEffects(state("public"), policy("anyone")).confirm).toBe(false);
    expect(sharingChangeEffects(state("public"), policy("public", false)).confirm).toBe(false);
  });
  it("explains automatic unlisting when tightening listed access", () => {
    expect(sharingChangeEffects(state("public"), policy("tenant"))).toMatchObject({ unlist: true, confirm: true });
  });
  it("saves inherited settings directly unless access opens to anyone or removes a listing", () => {
    for (const source of ["folder", "all"] as const) {
      expect(sharingChangeEffects(state("tenant", source), policy("public"))).toMatchObject({ detach: true, publicAccess: true, listing: true, confirm: true });
      for (const next of [policy("tenant", false), policy("private"), policy("login"), policy("passcode")])
        expect(sharingChangeEffects(state("tenant", source), next)).toMatchObject({ detach: true, publicAccess: false, confirm: false });
      expect(sharingChangeEffects(state("anyone", source), policy("public")).confirm).toBe(false);
      expect(sharingChangeEffects(state("public", source), policy("private")).confirm).toBe(true);
    }
    expect(sharingChangeEffects(state("tenant", "default"), policy("login")).confirm).toBe(false);
  });
});

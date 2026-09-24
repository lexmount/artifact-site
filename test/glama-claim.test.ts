// /.well-known/glama.json: the Glama ownership challenge exists only where an operator configured it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/.well-known/glama.json/route";
import { __resetWarnedForTests } from "@/lib/config";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); __resetWarnedForTests(); });

describe("/.well-known/glama.json", () => {
  it("is absent unless ARTIFACT_GLAMA_CLAIM is set", async () => {
    vi.stubEnv("ARTIFACT_GLAMA_CLAIM", "");
    expect(GET().status).toBe(404);
  });

  it("serves exactly the JSON Glama asks for", async () => {
    vi.stubEnv("ARTIFACT_GLAMA_CLAIM", "  glama_claim_abc-DEF_09  ");
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ $schema: "https://glama.ai/mcp/schemas/connector.json", claim: "glama_claim_abc-DEF_09" });
  });

  it("refuses a malformed claim with one warning instead of echoing it", async () => {
    vi.stubEnv("ARTIFACT_GLAMA_CLAIM", 'glama_claim_x"}<script>');
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(GET().status).toBe(404);
    expect(GET().status).toBe(404);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

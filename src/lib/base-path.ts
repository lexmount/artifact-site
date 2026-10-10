import reserved from "../../config/reserved-base-paths.json";

/** Native URLs may already carry the mount. Reserve app roots to keep that distinction unambiguous. */
export function validateBasePath(value: string): void {
  if (!/^(?:\/[a-zA-Z0-9_-]+)*$/.test(value)) throw new Error("Invalid ARTIFACT_BASE_PATH");
  if (reserved.includes(value.split("/")[1])) {
    throw new Error("ARTIFACT_BASE_PATH starts with a reserved application route; use a distinct prefix such as /artifact-site");
  }
}

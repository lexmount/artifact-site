import "server-only";
import { safeRelativePath } from "@/lib/storage";
import { createCommentSchema } from "./contracts";

/** Does not authorize the scope or assert that the file/page exists; the service must do both. */
export function parseCreateComment(input: unknown) {
  const parsed = createCommentSchema.parse(input);
  parsed.anchor.filePath = safeRelativePath(parsed.anchor.filePath);
  return parsed;
}

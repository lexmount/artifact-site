import { rbacQuery } from "@/lib/db";
import { OperationError, readableOperationResult, operationId, operationOwner } from "@/lib/publish-operation";
import { errorResponse, json } from "@/app/api/_util";
export async function GET(request: Request, context: { params: Promise<{ key: string }> }) {
  try {
    const owner = await operationOwner(request);
    const { key } = await context.params;
    const [row] = await rbacQuery("SELECT * FROM publish_operations WHERE id=$1 AND owner_key=$2", [operationId(owner, key), owner]);
    if (!row) return json({ error: "Operation not found", code: "operation_not_found" }, 404);
    if (Number(row.expires_at) < Date.now()) return json({ error: "The seven-day recovery window has expired; inspect the artifact before starting a new operation with a new key", status: "expired", code: "operation_expired" }, 410);
    return json({ status: row.state === "completed" ? "completed" : Number(row.lease_until) > Date.now() ? "running" : "retryable", expiresAt: Number(row.expires_at), ...(row.state === "completed" ? { result: await readableOperationResult(request, row.result), httpStatus: Number(row.http_status) } : {}) });
  } catch (error) {
    if (error instanceof OperationError) return json({ error: error.message, code: error.code }, error.statusCode);
    return errorResponse(error);
  }
}

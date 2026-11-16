import { agentDocumentResponse } from "@/lib/agent-documents";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return agentDocumentResponse("index", request);
}

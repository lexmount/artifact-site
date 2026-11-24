// The global administrative catalog is retired for every credential, including operators.
// Keep the response explicit for clients upgrading from versions that exposed this endpoint.
import { json } from "../../_util";

export async function GET() {
  return json({ error: "Administrative site listing is no longer available" }, 410);
}

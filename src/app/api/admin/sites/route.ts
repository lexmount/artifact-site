// The global administrative catalog is retired for every credential, including operators.
// Keep the response explicit for clients upgrading from versions that exposed this endpoint.
import { json } from "../../_util";

export async function GET(request: Request) {
  void request; // Credentials and filters cannot re-enable the retired catalog.
  return json({ error: "Administrative site listing is no longer available" }, 410);
}

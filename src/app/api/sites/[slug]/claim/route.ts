// Retired open-claim endpoint. Do not inspect the slug or reveal whether a site exists.
// Ownership is assigned at publication or through the authorized ownership-transfer route.
export async function POST() {
  return Response.json({ error: "Site claiming is disabled. Ask an administrator to assign ownership.", code: "claim_disabled" }, { status: 410 });
}

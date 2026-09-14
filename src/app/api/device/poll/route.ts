// POST /api/device/poll — the agent's side of the handshake.
//
// The token is minted HERE, at redemption, not at approval: no plaintext credential ever sits in a
// table waiting. `consumeDeviceGrant` is atomic (approved → consumed exactly once), so a replayed
// or raced poll can never mint a second token. Deliberately not rate-limited: a poll is a
// side-effect-free lookup keyed by an unguessable 24-byte code, and the skill polls every 5s for
// up to 10 minutes — throttling it would only break the happy path.
import type { NextResponse } from "next/server";
import { getDeviceGrant, getUser, redeemDeviceGrant } from "@/lib/db";
import { createPublishTokenSecret, hashTokenSecret } from "@/lib/publish-token";
import { errorResponse, json } from "../../_util";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => ({}))) as { device_code?: unknown };
    const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
    if (!deviceCode) return json({ error: "device_code is required" }, 400);

    const hashed = hashTokenSecret(deviceCode);
    const grant = await getDeviceGrant(hashed);
    if (!grant) return json({ error: "Invalid device_code" }, 400);
    if (grant.status === "consumed") return json({ error: "This authorization has already been redeemed" }, 400);
    if (grant.expiresAt <= Date.now()) return json({ status: "expired" }, 200);
    if (grant.status === "pending") return json({ status: "pending" }, 200);

    // Consume + mint in ONE transaction (mirrors claimSiteAudited): if the token insert fails the
    // grant stays approved, so a retry after a DB hiccup still succeeds — a consumed grant with no
    // token would strand the user into redoing the whole device flow.
    const secret = createPublishTokenSecret();
    const now = Date.now();
    const userId = await redeemDeviceGrant(hashed, {
      id: hashTokenSecret(secret),
      name: `Device authorization · ${new Date(now).toISOString().slice(0, 10)}`,
    }, now);
    if (!userId) {
      // Lost the redeem either to a concurrent poll (already redeemed) or to the clock crossing
      // expires_at between the read above and the CAS — re-read so the error says which.
      const g = await getDeviceGrant(hashed);
      return g && g.status !== "consumed" && g.expiresAt <= Date.now()
        ? json({ status: "expired" }, 200)
        : json({ error: "This authorization has already been redeemed" }, 400);
    }

    const user = await getUser(userId);
    // The plaintext exists in this response and nowhere else — the agent must store it now.
    return json({ status: "approved", token: secret, user: { email: user?.email ?? null, displayName: user?.displayName ?? null } }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}

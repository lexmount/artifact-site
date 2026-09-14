// POST /api/device/start — begin a device authorization (RFC 8628 in spirit).
//
// An agent with no browser calls this, shows the user the verification link, and polls /poll.
// Open by design: starting a grant proves nothing and grants nothing — only a signed-in human
// on /activate can approve it. Rate-limited so the table can't be flooded.
import type { NextResponse } from "next/server";
import { insertDeviceGrant, UserCodeConflictError } from "@/lib/db";
import { config } from "@/lib/config";
import { checkRateLimit } from "@/lib/ratelimit";
import {
  createDeviceCode, createUserCode, DEVICE_GRANT_TTL_MS, DEVICE_POLL_INTERVAL_S, hashTokenSecret,
} from "@/lib/publish-token";
import { errorResponse, json } from "../../_util";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    const now = Date.now();
    const deviceCode = createDeviceCode();
    // The 8-char space is ~6.5e11; a UNIQUE collision is lottery-grade but costs nothing to retry.
    // ONLY that collision is retried: the store reports it as UserCodeConflictError, and anything
    // else (a connection failure, say) must surface as what it is instead of being re-attempted
    // twice and then reported as if the code space were exhausted.
    let userCode = createUserCode();
    for (let attempt = 0; ; attempt++) {
      try {
        await insertDeviceGrant({ deviceCode: hashTokenSecret(deviceCode), userCode, createdAt: now, expiresAt: now + DEVICE_GRANT_TTL_MS });
        break;
      } catch (e) {
        if (!(e instanceof UserCodeConflictError) || attempt >= 2) throw e;
        userCode = createUserCode();
      }
    }
    const base = (config.publicUrl || new URL(request.url).origin).replace(/\/$/, "");
    const verificationUrl = `${base}/activate?code=${userCode}`;
    return json({
      device_code: deviceCode,
      user_code: userCode,
      verification_url: verificationUrl,
      /** Where to type the code by hand — the fallback when a long URL does not survive the trip
       *  into the user's chat client (wrapped, truncated, or not clickable). */
      verification_url_manual: `${base}/activate`,
      interval: DEVICE_POLL_INTERVAL_S,
      expires_in: Math.floor(DEVICE_GRANT_TTL_MS / 1000),
      /**
       * The whole point of this field: an agent asked to "tell the user the verification_url" has
       * to compose a sentence, and composing is exactly what a model skips when it is busy running
       * the next command — so the link ends up buried in a tool log the user has to go spelunking
       * for. Relaying a ready-made block verbatim needs no composition, so it survives. Keep it
       * self-contained (both routes, the code, the deadline) and quotable as-is.
       */
      user_message:
        `Please open this link to authorize; sign in, then click "Allow":\n${verificationUrl}\n\n` +
        `If it does not open, go to ${base}/activate and enter the code: ${userCode}\n` +
        `(valid for ${Math.floor(DEVICE_GRANT_TTL_MS / 60000)} minutes; once authorized, sites I publish from this machine will be owned by you directly)`,
    }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}

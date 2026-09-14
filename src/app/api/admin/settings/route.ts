// GET  /api/admin/settings          the policy settings: effective value, where it comes from, what the environment says
// PUT  /api/admin/settings { values: { <key>: <value> | null } }   set (or clear back to the environment) any subset
//
// Console over environment over default, per key — lib/settings. A change is validated as a whole
// before anything is written, applied on this replica immediately and on the others within half a
// minute, and recorded in admin_log with the keys it touched.
import type { NextResponse } from "next/server";
import { z } from "zod";
import { recordAdminAction, requireAdmin, requireAdminWrite } from "@/lib/admin";
import { checkRateLimit } from "@/lib/ratelimit";
import { describeSettings, SETTING_KEYS, updateSettings, type SettingKey } from "@/lib/settings";
import { errorResponse, json } from "../../_util";

const body = z.object({ values: z.record(z.string(), z.union([z.string(), z.number(), z.null()])) });

export async function GET(request: Request): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    await requireAdmin(request);
    return json({ settings: await describeSettings() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    const actor = await requireAdminWrite(request);
    const input = body.parse(await request.json());
    const values: Partial<Record<SettingKey, unknown>> = {};
    for (const [k, v] of Object.entries(input.values)) {
      if (!(SETTING_KEYS as string[]).includes(k)) return json({ error: `Unknown setting: ${k}` }, 400);
      values[k as SettingKey] = v;
    }
    const changed = await updateSettings(values, actor.userId);
    if (changed.length) {
      const summary = changed.map((k) => `${k}=${values[k] === null || values[k] === "" ? "(environment)" : String(values[k])}`).join(", ");
      await recordAdminAction(request, actor, "settings.update", { kind: "system", id: "settings" }, summary.slice(0, 500));
    }
    return json({ settings: await describeSettings(), changed });
  } catch (error) {
    return errorResponse(error);
  }
}

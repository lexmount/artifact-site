// PATCH /api/admin/users/:id  { disabled: boolean, reason?: string }
//   disabled=true   refuses sign-in from now on and revokes every session and publish token;
//                   a reason is required and is shown to the person on their next sign-in attempt.
//   disabled=false  re-enables; the person signs in again as usual.
import type { NextResponse } from "next/server";
import { z } from "zod";
import { disableUser, enableUser, requireAdminWrite } from "@/lib/admin";
import { checkRateLimit } from "@/lib/ratelimit";
import { errorResponse, json } from "../../../_util";

const body = z.object({ disabled: z.boolean(), reason: z.string().max(500).optional() });

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    const actor = await requireAdminWrite(request);
    const { id } = await context.params;
    const input = body.parse(await request.json());
    const user = input.disabled ? await disableUser(request, actor, id, input.reason) : await enableUser(request, actor, id, input.reason);
    const { providerSubject: _subject, ...rest } = user;
    void _subject;
    return json({ user: rest });
  } catch (error) {
    return errorResponse(error);
  }
}

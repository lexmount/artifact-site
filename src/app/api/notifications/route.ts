import { z } from "zod";
import { commentResponse, commentBody } from "@/lib/comments/http";
import {
  listNotifications,
  hasUnreadNotifications,
  markNotificationsRead,
} from "@/lib/notifications/service";
const query = z
  .object({
    unread: z.enum(["1"]).optional(),
    badge: z.enum(["1"]).optional(),
    before: z.coerce.number().int().nonnegative().optional(),
    id: z.string().max(200).optional(),
  })
  .strict();
export function GET(request: Request) {
  return commentResponse(async () => {
    const input = query.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return input.badge
      ? hasUnreadNotifications(request)
      : listNotifications(
          request,
          Boolean(input.unread),
          input.before !== undefined && input.id
            ? { time: input.before, id: input.id }
            : undefined,
        );
  });
}
export function POST(request: Request) {
  return commentResponse(async () => {
    const input = z
      .object({
        id: z.string().max(200).optional(),
        through: z.number().int().nonnegative().optional(),
      })
      .strict()
      .parse(await commentBody(request));
    return markNotificationsRead(request, input.id, input.through);
  });
}

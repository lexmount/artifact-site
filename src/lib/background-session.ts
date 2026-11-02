import "server-only";
import type { Session } from "@/lib/types";
// Only server-created Request objects can carry a durable job identity. No header can set it.
const sessions = new WeakMap<Request, Session | null>();
export function bindBackgroundSession(request: Request, session: Session | null) { sessions.set(request, session); }
export function backgroundSession(request: Request) { return sessions.has(request) ? { session: sessions.get(request)! } : undefined; }

const shares = new WeakMap<Request, string>();
export function bindBackgroundShare(request: Request, hash: string) { shares.set(request, hash); }
export function backgroundShare(request: Request) { return shares.get(request); }

export interface PasscodeAdmission { shareId: string; binding: string; expiresAt: number }
const passcodes = new WeakMap<Request, PasscodeAdmission>();
export function bindBackgroundPasscode(request: Request, admission: PasscodeAdmission) { passcodes.set(request, admission); }
export function backgroundPasscode(request: Request) { return passcodes.get(request); }

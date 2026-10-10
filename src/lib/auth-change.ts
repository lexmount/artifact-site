import { appBasePath } from "@/lib/app-path";

// A short-lived notification hint, never a credential or evidence of an authenticated session.
export const AUTH_CHANGE_COOKIE = "artifact_auth_change";
export const authChangeCookiePath = () => appBasePath() || "/";

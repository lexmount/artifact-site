// The one-time device authorisation, shared by `artifact-site login` and the MCP login tools.
// start() hands back what to show the user; wait() polls until they click Allow, then stores
// the token where every other command (and the agent skill) will find it.
import { ArtifactSiteClient, type DeviceStart } from "./client.js";
import { writeStoredConfig, writeToken } from "./config.js";

export interface LoginWaitOptions {
  /** Poll interval in seconds; the server suggests one in the start response. */
  intervalSeconds?: number;
  /** Give up after this many seconds (the grant itself expires server-side, usually in 10 minutes). */
  timeoutSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
  onPoll?: () => void;
}

export async function loginStart(client: ArtifactSiteClient): Promise<DeviceStart> {
  return client.deviceStart();
}

export async function loginWait(client: ArtifactSiteClient, start: DeviceStart, opts: LoginWaitOptions = {}): Promise<{ token: string; email?: string }> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const interval = Math.max(1, opts.intervalSeconds ?? start.interval ?? 5) * 1000;
  const deadline = Date.now() + (opts.timeoutSeconds ?? start.expires_in ?? 600) * 1000;
  for (;;) {
    const poll = await client.devicePoll(start.device_code);
    if (poll.status === "approved") {
      writeToken(client.baseUrl, poll.token);
      writeStoredConfig({ baseUrl: client.baseUrl, email: poll.user?.email });
      return { token: poll.token, email: poll.user?.email };
    }
    if (poll.status === "expired") throw new Error("The authorisation expired before it was approved; run login again");
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the authorisation to be approved");
    opts.onPoll?.();
    await sleep(interval);
  }
}

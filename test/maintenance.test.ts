vi.mock("@/lib/notifications/service", () => ({pruneNotifications: vi.fn(async()=>{})}));
import { afterEach, expect, it, vi } from "vitest";
const jobs=vi.hoisted(()=>({expire:vi.fn(),purge:vi.fn(),sessions:vi.fn(),oauth:vi.fn(),views:vi.fn(),audit:vi.fn(),text:vi.fn(),images:vi.fn()}));
vi.mock("@/lib/admin",()=>({expireAnonymousSitesJob:jobs.expire,purgeDeletedSites:jobs.purge}));
vi.mock("@/lib/upload-session",()=>({sweepExpiredSessions:jobs.sessions}));
vi.mock("@/lib/db",()=>({pruneOauth:jobs.oauth}));
vi.mock("@/lib/view-retention",()=>({pruneViewDetails:jobs.views}));
vi.mock("@/lib/audit-retention",()=>({pruneAuditLogsJob:jobs.audit}));
vi.mock("@/lib/site-text",()=>({backfillSiteTexts:jobs.text}));
vi.mock("@/lib/comments/attachments",()=>({sweepCommentAttachments:jobs.images}));
import {flushAfterResponseForTests} from "@/lib/after-response";
import {maintenanceTick,__resetMaintenanceForTests} from "@/lib/maintenance";
afterEach(async()=>{await flushAfterResponseForTests();vi.restoreAllMocks();vi.resetAllMocks();__resetMaintenanceForTests();});
it("runs image cleanup in the background once per hour and retries partial storage failures",async()=>{
  let finish!: (result:{errors:number})=>void;
  jobs.images.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue({errors:0});
  const log=vi.spyOn(console,"error").mockImplementation(()=>{});
  const now=10*60*60*1000;
  expect(maintenanceTick(now)).toBeUndefined();
  expect(jobs.images).toHaveBeenCalledTimes(1);expect(jobs.text).toHaveBeenCalledTimes(1);
  maintenanceTick(now+1);expect(jobs.images).toHaveBeenCalledTimes(1);
  finish({errors:2});await vi.waitFor(()=>expect(log).toHaveBeenCalledWith(expect.stringContaining("image cleanup"),{errors:2}));
  maintenanceTick(now+60*60*1000);expect(jobs.images).toHaveBeenCalledTimes(2);
});
it("isolates cleanup rejection from other maintenance and permits a later retry",async()=>{
  const failure=new Error("storage unavailable");jobs.images.mockRejectedValueOnce(failure).mockResolvedValue({errors:0});
  const log=vi.spyOn(console,"error").mockImplementation(()=>{});
  maintenanceTick(60*60*1000);
  await vi.waitFor(()=>expect(log).toHaveBeenCalledWith("[maintenance]",failure));
  expect(jobs.audit).toHaveBeenCalledTimes(1);expect(jobs.purge).toHaveBeenCalledTimes(1);
  maintenanceTick(2*60*60*1000);expect(jobs.images).toHaveBeenCalledTimes(2);
});

it("keeps deferred cleanup tracked until database teardown can safely proceed",async()=>{
  let release!: ()=>void;
  jobs.images.mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve({errors:0});}));
  maintenanceTick(60*60*1000);
  let drained=false;
  const teardown=flushAfterResponseForTests().then(()=>{drained=true;});
  await Promise.resolve();expect(drained).toBe(false);
  release();await teardown;expect(drained).toBe(true);
});

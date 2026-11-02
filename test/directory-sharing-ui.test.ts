import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { DirectoryPage } from "@/lib/directory-query";
import type { SiteSummary } from "@/lib/types";

vi.mock("next/navigation", () => ({useRouter:()=>({refresh:vi.fn(),replace:vi.fn(),push:vi.fn()}),usePathname:()=>"/me",useSearchParams:()=>new URLSearchParams()}));
vi.mock("@/lib/use-directory-navigation", () => ({useDirectoryNavigation:()=>({search:"",view:"list",pending:false,change:vi.fn()})}));
vi.mock("@/lib/use-auth", () => ({useAuth:()=>({user:{id:"owner"},loading:false,oidcEnabled:false}),loginHref:()=>"/login"}));
vi.mock("@/lib/folder-shelf", () => ({useShelf:(_id:string,folders:unknown)=>({mode:"account",state:folders,loading:false})}));
vi.mock("@/lib/edit-token", () => ({useOwnedTokens:()=>({}),useStoredToken:()=>null}));
vi.mock("@/lib/site-permissions", () => ({usePermissionsForSites:(_slugs:unknown,_tokens:unknown,permissions:unknown)=>({permissions,failed:[],retry:vi.fn()})}));
import MySites from "@/components/my-sites";
import DirectoryLoading from "@/components/directory-loading";

const sites:SiteSummary[] = [
  {slug:"private-demo",title:"Product research draft",kind:"single",entry:"index.html",visibility:"private",versionCount:9,createdAt:0,updatedAt:Date.now(),totalViews:0,sharingStatus:{shared:false,audience:"private",members:false,links:false}},
  {slug:"shared-demo",title:"Browser evaluation report",kind:"single",entry:"index.html",visibility:"private",versionCount:3,createdAt:0,updatedAt:Date.now(),totalViews:45,sharingStatus:{shared:true,audience:"private",members:false,links:true}},
];
const directory:DirectoryPage = {sites,permissions:{},total:2,ownedTotal:2,query:{scope:"owned",sharing:"all",page:0,q:"",sort:"updated",folder:"all"},counts:{all:2,unfiled:2,byId:{}},sharingCounts:{all:2,private:1,shared:1},folders:{folders:[],assign:{}}};
const render=(value=directory)=>renderToStaticMarkup(createElement(MySites,{sites:value.sites,directory:value,userId:"owner"}));
it("keeps existing list fields and exposes owner sharing filters, labels and collection tooltip",()=>{
  const html=render();
  for(const label of ["Total opens","Who can open","Versions","Updated","Sharing status","Active independent links","Only me"]) expect(html).toContain(label);
  expect(html).toContain('title="Share all sites"');
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain("Shared means others currently have access");
  expect(html).toContain('data-slug="private-demo"');
  if(process.env.DIRECTORY_PREVIEW_DIR) {
    mkdirSync(process.env.DIRECTORY_PREVIEW_DIR,{recursive:true});
    writeFileSync(`${process.env.DIRECTORY_PREVIEW_DIR}/index.html`, `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${readFileSync("src/app/globals.css","utf8")}</style><body><main style="max-width:1200px;margin:auto;padding:24px"><div class="work-title"><h1>My sites</h1></div>${html}</main></body></html>`);
  }
});
it("offers a filter reset rather than an upload prompt for a filtered empty list",()=>{
  const html=render({...directory,sites:[],total:0,query:{...directory.query,sharing:"private"}});
  expect(html).toContain("No sites match this sharing filter");
  expect(html).toContain("Show all sharing states");
  expect(html).not.toContain("You have no sites of your own yet");
});
it("announces loading with a centered spinner rather than placeholder blocks",()=>{
  const html=renderToStaticMarkup(createElement(DirectoryLoading));
  expect(html).toContain('role="status"');
  expect(html).toContain('aria-label="Loading…"');
  expect(html).toContain("lucide-loader-circle");
  expect(html).not.toContain("page-skeleton");
});

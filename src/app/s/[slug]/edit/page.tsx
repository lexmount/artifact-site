import { canReadSite, canReadVersion, requestShareAccess } from "@/lib/share";
// Editor route /s/[slug]/edit — reads a version's source off disk (there is no raw-file API; the
// server component reads the immutable version tree directly) and hands it to the client Editor.
// Single sites edit the whole entry doc; folder sites pick one text file to edit.
//
// [Base version] When a site has several versions, an extra selection step comes first (whenever
// ?version= is not given) so the user decides whether to edit the current version, start from some
// historical version, or make a copy first — what users asked for is "tell me which versions exist
// before I enter the editor". The decision lives entirely in planEditEntry in lib/edit-base (a pure,
// testable function); with a single version this step never appears. Once a historical version is
// chosen, the file tree read here is THAT version's, so the source editor and the visual editor see
// the same content.
//
// [Who may edit] This page MUST compute the capability once on the server (lib/authz), because edit
// rights have long stopped coming only from the per-site token: with ARTIFACT_ENFORCE_OWNERSHIP on,
// owners and collaborators are authorized by session, while the token only exists in the
// localStorage of the browser that created the site or received a share link. Looking at the token
// alone, anyone on another device, anyone who cleared site data once, or anyone who owns the site by
// virtue of being signed in would be judged "no edit permission" by the frontend and shown the lock
// screen — even though the server would happily let them write. The computed canEdit is passed to
// <Editor>, which opens the door on "server capability OR local token".
import path from "node:path";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import Editor from "@/components/editor";
import VersionPicker from "@/components/version-picker";
import { describePermissions, requestFromHeaders } from "@/lib/authz";
import { getSiteView, listVersions } from "@/lib/sites";
import { getStorage } from "@/lib/storage";
import { firstParam, planEditEntry, versionLabel } from "@/lib/edit-base";
import { getT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

const TEXT_EXT = new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".svg", ".txt", ".md", ".xml", ".csv"]);
const MAX_TEXT_BYTES = 2 * 1024 * 1024; // don't inline huge files into the client payload

async function readText(siteId: string, versionId: string, relpath: string): Promise<Uint8Array | null> {
  return getStorage().read(siteId, versionId, relpath).catch(() => null);
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const [view, t] = await Promise.all([getSiteView(slug), getT()]);
  const readable = view && await canReadSite(requestFromHeaders(await headers(), `/s/${slug}/edit`), view.site);
  return { title: readable ? t("Edit {title} — artifact-site", { title: view.site.title }) : t("Site not found — artifact-site"), description: null };
}

export default async function EditorPage({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ version?: string | string[]; pick?: string | string[]; share?: string; t?: string | string[] }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const view = await getSiteView(slug);
  if (!view) notFound();
  // Document sites have no edit page: the entry is a generated wrapper page, the original is a
  // binary, and an update means re-uploading. Go straight back to the site page.
  if (view.site.kind === "document") redirect(`/s/${slug}`);

  // The capability is computed on the server through the same resolveAuthority the write routes
  // use (requirePermission(…, "site.content.edit")), so this UI gate can never be wider than the server's.
  // `?t=` is handed to it as well, so a visitor arriving via an editable link gets an unlocked first
  // paint without waiting for hydration to fish the token out of the URL.
  const request = requestFromHeaders(await headers(), `/s/${slug}/edit`, firstParam(sp?.t));
  if(sp.share)request.headers.set("x-artifact-share",sp.share);
  const permissions = await describePermissions(request,view.site);
  if(!permissions.canEditContent) notFound();
  const canEdit = permissions.canEditContent;

  const { id: siteId } = view.site;
  const allVersions = (await listVersions(slug)) ?? [];
  const link = await requestShareAccess(request,view.site);
  const versions = link ? allVersions.filter(v=>link.versionId ? v.id === link.versionId : v.current || v.official) : allVersions;
  const plan = planEditEntry({
    versions,
    currentVersionId: view.version.id,
    currentEntry: view.version.entry,
    requestedVersion: firstParam(sp?.version),
    forcePicker: firstParam(sp?.pick) === "1",
  });

  if (plan.step === "picker") {
    return (
      <VersionPicker
        slug={slug}
        title={view.site.title}
        kind={view.site.kind}
        versions={versions}
        currentVersionId={view.version.id}
        currentEntry={view.version.entry}
        notice={plan.notice}
      />
    );
  }

  // The base version is settled. planEditEntry guarantees it belongs to this site and that its entry
  // has the same name as the current version's, so reading files through it from here on is safe;
  // entry is therefore equal to view.version.entry.
  const base = versions.find((v) => v.id === plan.baseVersionId) ?? view.version;
  const versionId = base.id;
  if(!(await canReadVersion(request,view.site,versionId)))notFound();
  const entry = base.entry;
  // Only when it is not the current version do we hand "you are editing from an older version" to
  // the editor to display, and make the editing surface fetch its source from that version.
  const baseInfo = plan.baseIsCurrent && base.id !== view.site.officialVersionId
    ? undefined
    : { id: base.id, label: versionLabel(versions, base.id), createdAt: base.createdAt };

  if (view.site.kind === "single") {
    const bytes = await readText(siteId, versionId, entry);
    const content = bytes ? Buffer.from(bytes).toString("utf8") : "";
    return (
      <Editor
        slug={slug}
        title={view.site.title}
        kind="single"
        entry={entry}
        versionId={versionId}
        latestVersionId={view.site.currentVersionId}
        officialBase={base.id === view.site.officialVersionId}
        baseVersion={baseInfo}
        canEdit={canEdit}
        canPickVersion={versions.length > 1}
        files={[{ path: entry, content, editable: true }]}
      />
    );
  }

  // Folder: inline every reasonably-sized text file; mark the rest read-only.
  const paths = await getStorage().list(siteId, versionId).catch(() => []);
  const files = await Promise.all(
    paths.map(async (p) => {
      const editable = TEXT_EXT.has(path.extname(p).toLowerCase());
      if (!editable) return { path: p, content: "", editable: false };
      const bytes = await readText(siteId, versionId, p);
      if (bytes && bytes.byteLength > MAX_TEXT_BYTES) return { path: p, content: "", editable: false };
      return { path: p, content: bytes ? Buffer.from(bytes).toString("utf8") : "", editable: true };
    })
  );

  return (
    <Editor
      slug={slug}
      title={view.site.title}
      kind="folder"
      entry={entry}
      versionId={versionId}
        latestVersionId={view.site.currentVersionId}
        officialBase={base.id === view.site.officialVersionId}
      baseVersion={baseInfo}
      canEdit={canEdit}
      canPickVersion={versions.length > 1}
      files={files}
    />
  );
}

import { packageDirectoryStyle } from "@/lib/package-directory-style";
import { limits } from "@/lib/config";
import { safeRelativePath, getStorage } from "@/lib/storage";
import { BadRequestError } from "@/lib/errors";
import { PACKAGE_ENTRY, type PackageFile, type PackageMeta } from "@/lib/package-contract";
import { translatorFor, type Translator } from "@/lib/i18n";

export function packagePath(input: string): string {
  const path = safeRelativePath(input, "package");
  if (/^[a-z]:/i.test(path) || path.split("/").some(part => part.toLowerCase() === ".artifact-package")) throw new BadRequestError(`Package path is reserved or unsupported; rename this entry and upload again: ${input}`);
  return path;
}
export function validatePackageEntries(files: PackageFile[], directories: string[]) {
  if (files.length > limits.maxFiles || files.length + directories.length > limits.maxFiles * 2) throw new BadRequestError("Too many package entries");
  const seen = new Set<string>();
  let size = 0;
  for (const file of files) {
    const path = packagePath(file.path);
    if (seen.has(path)) throw new BadRequestError(`Duplicate package path: ${path}`);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > limits.maxFileBytes) throw new BadRequestError(`Invalid or oversized package file: ${path}`);
    seen.add(path); size += file.size;
  }
  if (size > limits.maxBytes) throw new BadRequestError("Package is too large after decompression");
  const dirs = new Set<string>();
  for (const directory of directories) {
    const path = packagePath(directory);
    if (dirs.has(path)) throw new BadRequestError(`Duplicate directory: ${path}`);
    dirs.add(path);
  }
  for (const path of [...seen, ...dirs]) {
    if (dirs.has(path) && seen.has(path)) throw new BadRequestError(`File/directory collision: ${path}`);
    const parts = path.split("/");
    for (let n = 1; n < parts.length; n++) if (seen.has(parts.slice(0, n).join("/"))) throw new BadRequestError(`File/directory collision: ${path}`);
  }
}
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Monochrome outline icons share the host's icon size and stroke weight. */
function icon(type: string): string {
  const paths: Record<string, string> = {
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    code: '<path d="m9 13-3 3 3 3m6-6 3 3-3 3"/>',
    image: '<circle cx="8" cy="11" r="1"/><path d="m5 19 4-4 3 3 3-4 4 5"/>',
    media: '<path d="m10 11 6 4-6 4Z"/>',
    archive: '<path d="M10 3v3h3v3h-3v3h3v3h-3v3h3"/>',
    sheet: '<path d="M6 12h12M6 16h12M10 9v11M14 9v11"/>',
    text: '<path d="M7 12h10M7 16h10"/>',
    file: '',
  };
  const outline = type === "folder" ? "" : '<path d="M14 2H5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9Zm0 0v7h7"/>';
  return `<svg class="icon" data-file-type="${type}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${outline}${paths[type]}</svg>`;
}
function fileType(path: string): string {
  if (/\.(html?|css|m?js|json|xml|tsx?|jsx|py|sh)$/i.test(path)) return "code";
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico)$/i.test(path)) return "image";
  if (/\.(mp[34]|mov|m4a|webm|ogg|wav)$/i.test(path)) return "media";
  if (/\.(zip|rar|7z|gz|tar|tgz)$/i.test(path)) return "archive";
  if (/\.(csv|xlsx?|ods)$/i.test(path)) return "sheet";
  if (/\.(txt|md|pdf|docx?|pptx?)$/i.test(path)) return "text";
  return "file";
}
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes < 1024 * 1024 ? "KiB" : "MiB";
  return `${(bytes / (unit === "KiB" ? 1024 : 1024 * 1024)).toLocaleString("en", { maximumFractionDigits: 1 })} ${unit}`;
}
export function buildPackageDirectory(files: PackageFile[], directories: string[], title: string, t: Translator = translatorFor("en")): string {
  validatePackageEntries(files, directories);
  type Node = { children: Map<string, Node>; file?: PackageFile };
  const root: Node = { children: new Map() };
  for (const item of [...directories.map(path => ({ path })), ...files]) {
    let node = root;
    for (const part of item.path.split("/")) { if (!node.children.has(part)) node.children.set(part, { children: new Map() }); node = node.children.get(part)!; }
    if ("size" in item) node.file = item as PackageFile;
  }
  const chevron = '<svg class="chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 2 4 4-4 4"/></svg>';
  const render = (node: Node): string => [...node.children].sort(([a, an], [b, bn]) => Number(!!an.file) - Number(!!bn.file) || a.localeCompare(b, "en")).map(([name, child]) => {
    if (!child.file) return `<li><details><summary>${chevron}${icon("folder")}<span class="name">${escape(name)}</span></summary><ul>${render(child) || `<li class="empty">${escape(t("Empty folder"))}</li>`}</ul></details></li>`;
    const file = child.file, label = escape(name), href = file.path.split("/").map(encodeURIComponent).join("/");
    const row = `${icon(fileType(file.path))}<span class="name">${label}</span><small>${fileSize(file.size)}</small>`;
    return `<li data-path="${escape(file.path)}">${/\.html?$/i.test(file.path) ? `<a class="file-row" href="${escape(href)}">${row}</a>` : `<div class="file-row">${row}</div>`}</li>`;
  }).join("");
  const hasFolders = directories.length > 0 || files.some(file => file.path.includes("/"));
  const actions = hasFolders ? `<div class="actions"><button type="button" data-expand="true" aria-controls="file-tree">${escape(t("Expand all"))}</button><button type="button" data-expand="false" aria-controls="file-tree">${escape(t("Collapse all"))}</button></div>` : "";
  const controls = `<script>document.querySelectorAll('[data-expand]').forEach(function(button){button.addEventListener('click',function(){document.querySelectorAll('#file-tree details').forEach(function(folder){folder.open=button.dataset.expand==='true';});});});</script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${packageDirectoryStyle}</style></head><body><main><header class="toolbar"><div><h1>${escape(title)}</h1><p>${escape(t("File directory"))} · ${files.length}</p></div>${actions}</header><div class="tree" id="file-tree"><ul>${render(root)}</ul></div></main>${controls}</body></html>`;
}
export async function writePackageDirectory(siteId: string, versionId: string, meta: PackageMeta, title: string, t: Translator = translatorFor("en")) {
  const html = buildPackageDirectory(meta.files, meta.directories, title, t);
  if (Buffer.byteLength(html) > 4 * 1024 * 1024) throw new BadRequestError("Generated directory exceeds its size budget");
  await getStorage().writeFileToVersion(siteId, versionId, PACKAGE_ENTRY, Buffer.from(html));
}

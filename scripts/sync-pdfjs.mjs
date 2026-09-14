// Sync the vendored PDF.js viewer runtime from node_modules into public/vendor/pdfjs.
//
// Why a build-time copy instead of committed files: the library + cmaps + fonts run to ~15MB,
// which would bloat every clone forever; and why not import from the app bundle: the consumer is
// the DOCUMENT WRAPPER PAGE, which runs inside the sandboxed (opaque-origin) preview iframe, not
// in the Next app — it can only load plain static URLs from the platform origin (served with the
// ACAO header, see next.config.ts). Runs as `prebuild`/`predev`, so both `next build` (Docker
// stage included — it COPYies /app/public into the runtime image) and local dev stay in sync.
//
// cmaps + standard_fonts are NOT optional decoration: CJK PDFs with non-embedded CID fonts render
// as blanks without the cmaps, and that is exactly the document population this platform hosts.
//
// PATH STABILITY CONTRACT: /vendor/pdfjs/… is hard-coded inside the wrapper page of every
// PUBLISHED document version, and versions are immutable — this directory may be upgraded in
// place (lib+cmaps+wasm swap together, atomically, with the image) but must NEVER move or gain a
// version segment, or every historical document site 404s. pdfjs-dist is pinned exact in
// package.json for the same reason: a caret drift would silently change the runtime under all
// existing documents. Served with max-age=3600 + ETag (no immutable) — see next.config.ts.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "node_modules", "pdfjs-dist");
const target = join(root, "public", "vendor", "pdfjs");

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
// The license text ships next to the code it covers (NOTICE points here); the fonts and cmaps
// directories carry their own.
cpSync(join(source, "LICENSE"), join(target, "LICENSE"));
cpSync(join(source, "build", "pdf.min.mjs"), join(target, "pdf.min.mjs"));
cpSync(join(source, "build", "pdf.worker.min.mjs"), join(target, "pdf.worker.min.mjs"));
cpSync(join(source, "cmaps"), join(target, "cmaps"), { recursive: true });
cpSync(join(source, "standard_fonts"), join(target, "standard_fonts"), { recursive: true });
// v6 moved color management (qcms), JPEG2000 and JBIG2 decoding into wasm modules with their own
// wasmUrl/iccUrl options. Omit these and rendering an ICC-tagged PDF — which is what LibreOffice
// (our office converter) emits — stalls forever with no error. Found the hard way.
cpSync(join(source, "wasm"), join(target, "wasm"), { recursive: true });
cpSync(join(source, "iccs"), join(target, "iccs"), { recursive: true });

// Pin every vendored mtime to a constant DERIVED FROM THE PACKAGE VERSION. This is a cache
// keystone, not cosmetics: Next's public-file ETag is weak (size+mtime), and node_modules mtimes
// are whatever moment npm happened to install them — stable only while the Docker deps layer is
// cache-hit. A cold builder or any unrelated dependency bump re-stamps everything, and one deploy
// that never touched pdfjs busts every client's cached ~MBs of lib + cmaps. Deriving the stamp
// from the pinned version makes the ETag a pure function of content identity: same version ⇒ same
// ETag on every builder forever; version bump ⇒ new ETag exactly when the bytes change.
const version = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
const [major, minor, patch] = version.split(".").map(Number);
const stamp = new Date(Date.UTC(2020, 0, 1) + ((major * 1_000_000 + minor * 10_000 + patch) * 1000));
function stampTree(path) {
  utimesSync(path, stamp, stamp);
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) stampTree(join(path, entry));
  }
}
stampTree(target);
console.log(`[sync-pdfjs] vendored pdfjs-dist@${version} into ${target} (mtimes pinned to ${stamp.toISOString()})`);

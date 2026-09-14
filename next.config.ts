import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone/server.js) so the
  // Docker runtime image can drop node_modules and the source tree entirely.
  output: "standalone",

  // PDF.js resolves its Node worker beside pdf.mjs. Bundling relocates that import into
  // .next/server/chunks, where no worker exists; keep the package's native module layout.
  serverExternalPackages: ["pdfjs-dist"],

  // Pin the trace root to the project dir. Otherwise Next infers it by walking up for lockfiles and
  // (on a dev box nested under ~/projects) lands a level too high, so included files get placed at
  // standalone/<nested>/src/content/… instead of standalone/src/content/…, which the cwd-relative
  // read below would miss. Docker (WORKDIR /app) already roots here; this makes local match.
  outputFileTracingRoot: process.cwd(),

  // The publish guide is read from disk at runtime (see lib/publish-skill.ts). Standalone tracing
  // can't see through fs.readFileSync, so force the source markdown into the bundle for both routes
  // that serve it — otherwise /for-agents and /for-agents.md would 500 in the Docker image.
  outputFileTracingIncludes: {
    "/*": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    "/for-agents": ["./src/content/publish-skill.md"],
    "/for-agents.md": ["./src/content/publish-skill.md"],
  },

  async headers() {
    return [
      {
        // The vendored PDF.js runtime, loaded BY the document wrapper page — which runs in the
        // sandboxed preview iframe, i.e. an OPAQUE origin. Its module import and cmap/font fetches
        // are therefore cross-origin and dead without CORS. `*` grants nothing: these are public
        // static library files, and an opaque origin sends no credentials anyway.
        source: "/vendor/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          // NOT immutable, deliberately: these URLs carry no content fingerprint, yet they are
          // referenced by the wrapper pages of every IMMUTABLE historical document version — the
          // path must stay stable across upgrades, so the only honest cache story is a short TTL
          // plus ETag revalidation. Next's public-file ETag is WEAK (size+mtime), so
          // sync-pdfjs.mjs pins every vendored mtime to a constant derived from the pinned
          // package version — the ETag becomes a function of content identity, immune to cold
          // builders and unrelated dependency bumps. Versioned paths would be worse here: the
          // Docker image ships exactly one pdfjs version, so an upgrade would 404 every
          // historical wrapper pointing at the old directory.
          { key: "Cache-Control", value: "public, max-age=3600" },
        ],
      },
      {
        source: "/:path*",
        headers: [
          // We host untrusted artifacts and render them in iframes. The editor's preview iframe
          // starts loading while the parent URL may still carry ?t=<edit token> (the client strips
          // it in an effect, which runs after the DOM commit), and the referring URL is readable
          // from inside the frame as document.referrer. Suppressing the referrer entirely closes
          // that read regardless of the ordering, and costs nothing here: nothing in the product
          // depends on sending a Referer.
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;

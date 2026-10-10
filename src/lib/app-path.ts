/** Next embeds this value in each build. Root and subpath bundles use identical source. */
export function appBasePath(): string { return process.env.NEXT_PUBLIC_ARTIFACT_BASE_PATH || ""; }

/** For native URLs (fetch, iframe, form, plain anchors). Next Link/router prefix themselves.
 * Build/boot validation reserves application route roots so mounted and local URLs cannot collide. */
export function appPath<T extends string | undefined>(value: T): T {
  const prefix = appBasePath();
  if (!value || !prefix || !value.startsWith("/") || value.startsWith("//") ||
      value === prefix || value.startsWith(`${prefix}/`) || value.startsWith(`${prefix}?`) || value.startsWith(`${prefix}#`)) return value;
  return `${prefix}${value}` as T;
}

/** Convert a browser pathname to an application-local path before passing it to Next's router. */
export function localPath(value: string): string {
  const prefix = appBasePath();
  return prefix && (value === prefix || value.startsWith(`${prefix}/`) || value.startsWith(`${prefix}?`))
    ? value.slice(prefix.length) || "/" : value;
}

/** Do not rewrite absolute URLs: they may identify an external service or a signed download. */
export const appFetch: typeof fetch = (input, init) => globalThis.fetch(typeof input === "string" ? appPath(input) : input, init);

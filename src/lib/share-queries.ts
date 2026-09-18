/** Keep public and management share listings in the same stable order across stores. */
export function listSharesQuery(siteIdParameter: "$1" | "?"): string {
  return `SELECT * FROM site_shares WHERE site_id=${siteIdParameter} ORDER BY created_at DESC, id DESC`;
}

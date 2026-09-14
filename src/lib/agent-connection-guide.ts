// Shell examples and client configuration share one deployment address. Never interpolate
// request-derived values into shell syntax or JSON without encoding them for that format.
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function guideCommands(base: string, token = "YOUR_TOKEN") {
  const address = shell(base);
  return {
    install: "npm --prefix cli ci\nnpm --prefix cli run build\n(cd cli && npm link)",
    login: `artifact-site login --base ${address}`,
    token: `export ARTIFACT_SITE_URL=${address}\nprintf 'Token: '; read -r -s ARTIFACT_SITE_TOKEN; printf '\\n'\nexport ARTIFACT_SITE_TOKEN`,
    verify: `artifact-site whoami --base ${address}`,
    publish: `artifact-site publish dist/ --base ${address} --share none`,
    more: `artifact-site find --base ${address}\nartifact-site find "report" --base ${address}\nartifact-site read YOUR_SITE_SLUG --base ${address}\nartifact-site update YOUR_SITE_SLUG dist/ --base ${address}`,
    endpoint: `${base.replace(/\/$/, "")}/mcp`,
    cursor: JSON.stringify({ mcpServers: { "artifact-site": { url: `${base.replace(/\/$/, "")}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
  };
}

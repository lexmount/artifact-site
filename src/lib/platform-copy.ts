// Platform-level copy, aimed at whoever is about to publish something. Every page that a READER
// can be sent to must override the description — otherwise Next merges this one down and the
// share card for someone's report ends up advertising the uploader. See /s/[slug]'s
// generateMetadata, which is the page that mistake actually reached.
//
// Names what people publish (reports, dashboards) instead of what they drag (.zip), because the
// formats are an implementation detail and the reader-facing value is "it is already online".
/** The platform's own copy (English source; translated at render time). Exported so the pages a
 *  READER lands on can assert they never inherit it. */
export const platformCopy = {
  title: "artifact-site — manage your agent’s work and collaborate",
  description: "Manage your agent’s pages, reports and documents. Share a link, discuss with your collaborators, and let an agent keep improving the work.",
} as const;

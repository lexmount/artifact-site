// Compatibility entry point. Internal readers import sharing-read directly.
export { sharingSession } from "@/lib/sharing-common";
export {
  effectiveSharingDefault, getSiteSharing, activeSource, mainSharingActive,
  forkVisibilityCeiling, mainSharingRole, getScope, sharingCollection,
  assertUnsharedFolderMutation,
} from "@/lib/sharing-read";
export { getSharingPreference, setSharingPreference } from "@/lib/sharing-preferences";
export {
  applyMainSharing, initializeSharing, markSharingManual, siteSharingChange,
} from "@/lib/sharing-mutations";
export { scopeChange, moveSharing } from "@/lib/sharing-scopes";

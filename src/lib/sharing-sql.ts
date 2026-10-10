/** Correlated against sites alias s. Invalidation revokes only scope-derived main access. */
export const mainSharingActiveSql = `NOT EXISTS (
  SELECT 1 FROM site_sharing_state scoped
  WHERE scoped.site_id=s.id AND scoped.source IN ('folder','all') AND (
    scoped.owner_id IS NULL OR scoped.owner_id<>s.owner_id OR s.owner_id IS NULL OR
    NOT EXISTS (SELECT 1 FROM sharing_scopes scope WHERE scope.id=scoped.source_id AND scope.enabled=1 AND scope.owner_id=scoped.owner_id)
  )
)`;

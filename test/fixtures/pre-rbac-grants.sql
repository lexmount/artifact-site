-- Seed both the frozen-schema regression and the old-image upgrade exercise.
INSERT INTO tenants(id,name) VALUES ('upgrade-workspace','Existing workspace');
INSERT INTO users(id,tenant_id,auth_provider,provider_subject,created_at,updated_at)
SELECT name,'upgrade-workspace','upgrade-test',name,100,100
FROM (VALUES ('upgrade-owner'),('upgrade-admin'),('upgrade-editor'),('upgrade-manager'),('upgrade-disabled'),('upgrade-left')) AS people(name);
UPDATE users SET disabled_at=200 WHERE id='upgrade-disabled';
INSERT INTO tenant_members(tenant_id,user_id,role)
SELECT 'upgrade-workspace',id,CASE WHEN id='upgrade-admin' THEN 'admin' ELSE 'member' END
FROM users WHERE auth_provider='upgrade-test' AND id<>'upgrade-left';
INSERT INTO sites(id,slug,title,kind,created_at,updated_at,tenant_id,owner_id,edit_token)
VALUES ('upgrade-site','upgrade-site','Existing workspace artifact','single',100,100,'upgrade-workspace','upgrade-owner',''),
('upgrade-anon','upgrade-anon','Anonymous artifact','single',100,100,'anonymous',NULL,'preserved-anonymous-token');
INSERT INTO site_members(site_id,user_id,role,granted_by,granted_at)
SELECT 'upgrade-site',id,CASE WHEN id='upgrade-manager' THEN 'admin' ELSE 'editor' END,'upgrade-owner',12345
FROM users WHERE id IN ('upgrade-editor','upgrade-manager','upgrade-disabled','upgrade-left');
-- A stale collaborator row is not authoritative once the old initial import completed.
INSERT INTO site_collaborators(site_id,user_id,granted_by,granted_at)
VALUES ('upgrade-site','upgrade-left','upgrade-owner',100);

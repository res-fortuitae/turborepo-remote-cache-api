-- OFFLINE OPERATOR MAINTENANCE ONLY. Backup and quiesce writes first.
-- Old device sessions have no provenance. Invalidate every session at upgrade.
DELETE FROM session;
DELETE FROM project_grant
WHERE NOT EXISTS (SELECT 1 FROM project p WHERE p.id = project_grant.project_id)
   OR (principal_type = 'user' AND NOT EXISTS (
     SELECT 1 FROM member m JOIN project p ON p.org_id = m.organization_id
     WHERE p.id = project_grant.project_id AND m.user_id = project_grant.principal_id
   ))
   OR (principal_type = 'team' AND NOT EXISTS (
     SELECT 1 FROM team t JOIN project p ON p.org_id = t.organization_id
     WHERE p.id = project_grant.project_id AND t.id = project_grant.principal_id
   ));

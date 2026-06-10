-- ============================================================
--  0002_helpers — controlled RLS-bypass lookups
--
--  Admin API routes receive an election_id but need its org_id to
--  open the right RLS scope (withOrg). Reading elections directly
--  would be denied by RLS (no org context yet), so this SECURITY
--  DEFINER function runs as the owner to return just the org_id —
--  a narrow, safe bypass. EXECUTE granted only to the app role.
-- ============================================================

CREATE FUNCTION election_org(p_election uuid)
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT org_id FROM elections WHERE id = p_election
$$;

REVOKE ALL ON FUNCTION election_org(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION election_org(uuid) TO app;

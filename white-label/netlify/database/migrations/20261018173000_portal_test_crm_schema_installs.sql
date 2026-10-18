-- Staging portal control plane ONLY. Never run on a customer Supabase project.
-- Keep the existing one-project reservation if a user disconnects OAuth,
-- even if their portal user is later deleted. This prevents repeat project
-- creation by disconnecting and reconnecting after the one-shot pilot.
ALTER TABLE portal_test_project_creations
  DROP CONSTRAINT IF EXISTS portal_test_project_creations_connection_id_fkey;
ALTER TABLE portal_test_project_creations
  DROP CONSTRAINT IF EXISTS portal_test_project_creations_user_id_fkey;

-- One irreversible installation attempt for the already-created staging pilot.
-- No cascading foreign keys: OAuth disconnect must never delete the audit lock.
CREATE TABLE portal_test_crm_schema_installs (
  request_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 128),
  organization_id TEXT NOT NULL CHECK (length(organization_id) BETWEEN 1 AND 128),
  project_ref TEXT NOT NULL CHECK (project_ref ~ '^[A-Za-z0-9]{20}$'),
  project_name TEXT NOT NULL DEFAULT 'Kleanly Business Staging CRM Pilot'
    CHECK (project_name = 'Kleanly Business Staging CRM Pilot'),
  blueprint_version INTEGER NOT NULL DEFAULT 1 CHECK (blueprint_version = 1),
  blueprint_sha256 TEXT NOT NULL CHECK (blueprint_sha256 ~ '^[0-9a-f]{64}$'),
  install_key TEXT NOT NULL DEFAULT 'pilot-crm-v1' CHECK (install_key = 'pilot-crm-v1'),
  status TEXT NOT NULL CHECK (status IN ('reserved','submitted','applied','rejected','unknown')),
  failure_code TEXT,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (install_key),
  UNIQUE (user_id, organization_id, project_ref)
);
CREATE INDEX portal_test_crm_schema_installs_status_idx
  ON portal_test_crm_schema_installs (status, approved_at DESC);

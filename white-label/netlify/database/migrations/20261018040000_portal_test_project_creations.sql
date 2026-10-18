-- Staging installer control-plane ledger for ONE explicitly approved test
-- Supabase project. Not run against any customer Supabase database.
-- A unique constraint prevents concurrent/repeated submissions from allocating
-- more than one project for the same verified Supabase owner+organisation.
CREATE TABLE portal_test_project_creations (
  request_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES portal_users(user_id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES portal_connections(connection_id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL CHECK (length(organization_id) BETWEEN 1 AND 128),
  organization_slug TEXT NOT NULL CHECK (length(organization_slug) BETWEEN 1 AND 128),
  project_name TEXT NOT NULL CHECK (length(project_name) BETWEEN 1 AND 160),
  region_group TEXT NOT NULL DEFAULT 'emea' CHECK (region_group = 'emea'),
  encrypted_db_password TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('reserved', 'submitted', 'created', 'unknown', 'rejected')
  ),
  project_ref TEXT CHECK (project_ref IS NULL OR project_ref ~ '^[A-Za-z0-9]{20}$'),
  failure_code TEXT,
  approval_version TEXT NOT NULL DEFAULT 'pilot-v1',
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,
  provisioned_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id)
);
CREATE INDEX portal_test_project_creations_status_idx
  ON portal_test_project_creations (status, approved_at DESC);

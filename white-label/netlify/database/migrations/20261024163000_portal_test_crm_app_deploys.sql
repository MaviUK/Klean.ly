-- Klean.ly Business STAGING INSTALLER control-plane database ONLY.
-- NEVER apply to the customer/test Supabase CRM or the live Klean.ly directory.
-- An irreversible one-deployment key ensures the POST is never retried after
-- a timeout, bad response, logout or OAuth reconnection.
CREATE TABLE portal_test_crm_app_deploys (
  request_id UUID PRIMARY KEY,
  deploy_key TEXT NOT NULL DEFAULT 'pilot-first-crm-app-deploy-v1'
    CHECK (deploy_key = 'pilot-first-crm-app-deploy-v1'),
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 128),
  organization_id TEXT NOT NULL CHECK (length(organization_id) BETWEEN 1 AND 128),
  supabase_project_ref TEXT NOT NULL
    CHECK (supabase_project_ref = 'nlupgjwcyivepzggffss'),
  netlify_site_id TEXT NOT NULL
    CHECK (netlify_site_id = 'c4632a28-a4b0-4e77-a54e-7a8bf05a8882'),
  netlify_team_id TEXT NOT NULL CHECK (length(netlify_team_id) BETWEEN 1 AND 128),
  netlify_user_id TEXT NOT NULL CHECK (length(netlify_user_id) BETWEEN 1 AND 128),
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  archive_hash TEXT NOT NULL CHECK (archive_hash ~ '^[0-9a-f]{64}$'),
  deploy_id TEXT CHECK (deploy_id IS NULL OR length(deploy_id) BETWEEN 8 AND 128),
  status TEXT NOT NULL CHECK (status IN ('reserved','submitted','ready','unknown')),
  failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) <= 64),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,
  ready_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (deploy_key),
  UNIQUE (netlify_site_id)
);

CREATE INDEX portal_test_crm_app_deploys_status_idx
  ON portal_test_crm_app_deploys(status, approved_at DESC);

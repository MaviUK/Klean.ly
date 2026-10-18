-- Staging installer control plane only; never run this on the customer CRM.
-- Immutable one-site creation reservation, survives OAuth disconnect and any
-- later portal account deletion. Only the exact test team and site are allowed.
CREATE TABLE portal_test_crm_site_creations (
  request_id UUID PRIMARY KEY,
  site_key TEXT NOT NULL DEFAULT 'pilot-crm-site-v1'
    CHECK (site_key = 'pilot-crm-site-v1'),
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 128),
  organization_id TEXT NOT NULL CHECK (length(organization_id) BETWEEN 1 AND 128),
  supabase_project_ref TEXT NOT NULL
    CHECK (supabase_project_ref ~ '^[a-zA-Z0-9]{20}$'),
  netlify_user_id TEXT NOT NULL CHECK (length(netlify_user_id) BETWEEN 1 AND 128),
  netlify_team_id TEXT NOT NULL CHECK (length(netlify_team_id) BETWEEN 1 AND 128),
  netlify_team_slug TEXT NOT NULL DEFAULT 'kleanlytest'
    CHECK (netlify_team_slug = 'kleanlytest'),
  site_name TEXT NOT NULL DEFAULT 'kleanly-business-crm-pilot'
    CHECK (site_name = 'kleanly-business-crm-pilot'),
  site_id TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('reserved', 'submitted', 'created', 'rejected', 'unknown')),
  failure_code TEXT,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_key),
  UNIQUE (user_id, organization_id, supabase_project_ref)
);
CREATE INDEX portal_test_crm_site_creations_status_idx
  ON portal_test_crm_site_creations (status, approved_at DESC);

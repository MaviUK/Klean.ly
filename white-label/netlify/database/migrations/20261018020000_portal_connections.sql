-- Isolated control-plane records for the white-label installer staging site.
-- This migration runs ONLY on the installer's separate Netlify Database.
-- No SQL in this file targets a customer's Supabase project or klean.ly directory.
CREATE TABLE portal_users (
  user_id TEXT PRIMARY KEY CHECK (length(user_id) BETWEEN 1 AND 128),
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE portal_connections (
  connection_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES portal_users(user_id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL CHECK (length(organization_id) BETWEEN 1 AND 128),
  organization_slug TEXT,
  organization_name TEXT NOT NULL,
  -- AES-256-GCM encrypted envelope, authenticated against this row's IDs.
  encrypted_tokens TEXT NOT NULL,
  access_expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected', 'reauthorisation_required')),
  health_checked_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id)
);

CREATE INDEX portal_connections_owner_idx
  ON portal_connections (user_id, connected_at DESC);

CREATE TABLE portal_sessions (
  -- Only a SHA-256 digest of the random session cookie is persisted.
  session_hash CHAR(64) PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES portal_users(user_id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES portal_connections(connection_id) ON DELETE CASCADE,
  csrf_token CHAR(43) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX portal_sessions_owner_idx
  ON portal_sessions (user_id, connection_id);
CREATE INDEX portal_sessions_expiry_idx
  ON portal_sessions (expires_at);

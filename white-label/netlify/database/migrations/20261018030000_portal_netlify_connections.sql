-- Staging installer control plane only.
CREATE TABLE portal_netlify_connections (
  user_id TEXT PRIMARY KEY REFERENCES portal_users(user_id) ON DELETE CASCADE,
  netlify_user_id TEXT NOT NULL,
  netlify_email TEXT,
  encrypted_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  health_checked_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

import {
  decryptTokens, encryptTokens, newPortalSession, sessionHash, tokenBinding,
  vaultKey, newConnectionId, SESSION_COOKIE, SESSION_SECONDS,
} from "./connection-vault.mjs";
import { readCookie, cookieHeader, clearCookie } from "./supabase-oauth.mjs";

// The portal uses its own Netlify-managed Postgres, NOT any customer Supabase DB.
// This module is imported lazily by feature-gated functions so the pre-existing
// proof-only connection continues to work until Netlify Database is enabled.
export async function getPortalDatabase() {
  const { getDatabase } = await import("@netlify/database");
  return getDatabase();
}

export async function persistAuthorization({ profile, organization, tokens }, db = null, key = vaultKey()) {
  if (!key) throw new Error("Credential encryption key unavailable");
  const session = newPortalSession();
  const database = db ?? await getPortalDatabase();
  const connection = await database.pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      `INSERT INTO portal_users (user_id, email) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET email = excluded.email, updated_at = now()`,
      [profile.userId, profile.email]
    );
    // Lock the owner's row to serialize concurrent first-time grants for the
    // same owner+organisation; encryption AAD must use the final row ID.
    await connection.query("SELECT user_id FROM portal_users WHERE user_id = $1 FOR UPDATE", [profile.userId]);
    const previous = await connection.query(
      `SELECT connection_id FROM portal_connections
       WHERE user_id = $1 AND organization_id = $2 FOR UPDATE`,
      [profile.userId, organization.organizationId]
    );
    const connectionId = previous.rows[0]?.connection_id ?? newConnectionId();
    const ciphertext = encryptTokens(
      tokens, tokenBinding(connectionId, profile.userId, organization.organizationId), key
    );
    await connection.query(
      `INSERT INTO portal_connections
       (connection_id, user_id, organization_id, organization_slug,
        organization_name, encrypted_tokens, access_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, organization_id)
       DO UPDATE SET
         organization_slug = excluded.organization_slug,
         organization_name = excluded.organization_name,
         encrypted_tokens = excluded.encrypted_tokens,
         access_expires_at = excluded.access_expires_at,
         status = 'connected', health_checked_at = NULL, updated_at = now()`,
      [
        connectionId, profile.userId, organization.organizationId,
        organization.organizationSlug, organization.organizationName,
        ciphertext, new Date(tokens.expiresAt),
      ]
    );
    await connection.query(
      `INSERT INTO portal_sessions
       (session_hash, user_id, connection_id, csrf_token, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [session.sessionHash, profile.userId, connectionId, session.csrfToken, session.expiresAt]
    );
    // Expired sessions don't grant any access even before being pruned.
    await connection.query(
      "DELETE FROM portal_sessions WHERE expires_at < now() - interval '1 day'"
    );
    await connection.query("COMMIT");
    return { ...session, connectionId, userId: profile.userId };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

export async function currentPortalSession(request, db = null) {
  const cookie = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  const hash = sessionHash(cookie);
  if (!hash) return null;
  const database = db ?? await getPortalDatabase();
  const rows = await database.sql`
    SELECT s.session_hash, s.user_id, s.connection_id, s.csrf_token, s.expires_at,
           c.organization_id, c.organization_slug, c.organization_name,
           c.status AS connection_status, c.access_expires_at, c.connected_at,
           c.health_checked_at, u.email
    FROM portal_sessions s
    INNER JOIN portal_connections c
      ON c.connection_id = s.connection_id AND c.user_id = s.user_id
    INNER JOIN portal_users u ON u.user_id = s.user_id
    WHERE s.session_hash = ${hash} AND s.expires_at > now()
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function forgetPortalSession(current, db = null) {
  if (!current) return;
  const database = db ?? await getPortalDatabase();
  await database.sql`DELETE FROM portal_sessions WHERE session_hash = ${current.session_hash}`;
}

export function portalSessionCookie(session) {
  return cookieHeader(SESSION_COOKIE, session.cookieValue, SESSION_SECONDS);
}

export function erasePortalSessionCookie() {
  return clearCookie(SESSION_COOKIE);
}

export async function deletePortalConnection(current, db = null) {
  if (!current) throw new Error("No current portal connection");
  const database = db ?? await getPortalDatabase();
  const connection = await database.pool.connect();
  try {
    await connection.query("BEGIN");
    // All sessions for this connection are invalidated by ON DELETE CASCADE.
    // This deletes only the selected user-owned org grant, not other users'
    // grants to the same Supabase organisation.
    const result = await connection.query(
      "DELETE FROM portal_connections WHERE connection_id = $1 AND user_id = $2",
      [current.connection_id, current.user_id]
    );
    await connection.query("COMMIT");
    return result.rowCount === 1;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

// Atomic refresh/update while holding a connection row lock avoids losing
// newly rotated Supabase refresh tokens under concurrent requests.
export async function inspectConnectedGrant(
  current,
  { db = null, key = vaultKey(), oauthConfig, tokenUrl, providerJson, fetchFn = fetch } = {}
) {
  if (!current || !key) throw new Error("Authenticated portal session and encryption key required");
  const database = db ?? await getPortalDatabase();
  const connection = await database.pool.connect();
  try {
    await connection.query("BEGIN");
    const locked = await connection.query(
      `SELECT connection_id, user_id, organization_id, encrypted_tokens,
              access_expires_at, status, health_checked_at
       FROM portal_connections
       WHERE connection_id = $1 AND user_id = $2 FOR UPDATE`,
      [current.connection_id, current.user_id]
    );
    const row = locked.rows[0];
    if (!row) throw new Error("Connection no longer exists");
    if (row.health_checked_at && Date.now() - new Date(row.health_checked_at).getTime() < 30000) {
      await connection.query("COMMIT");
      return { state: row.status, checkedAt: new Date(row.health_checked_at).toISOString(), cached: true };
    }
    if (row.status !== "connected") {
      await connection.query("COMMIT");
      return { state: "reauthorisation_required", cached: true };
    }

    let credentials = decryptTokens(row.encrypted_tokens,
      tokenBinding(row.connection_id, row.user_id, row.organization_id), key
    );
    let expiresAt = new Date(row.access_expires_at).getTime();
    if (expiresAt < Date.now() + 90000) {
      const { clientId, clientSecret } = oauthConfig();
      const response = await fetchFn(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          Authorization: "Basic " + Buffer.from(clientId + ":" + clientSecret).toString("base64"),
        },
        body: new URLSearchParams({
          grant_type: "refresh_token", refresh_token: credentials.refreshToken,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if ([400, 401, 403].includes(response.status)) {
        await connection.query(
          `UPDATE portal_connections
           SET status = 'reauthorisation_required', health_checked_at = now(), updated_at = now()
           WHERE connection_id = $1`, [row.connection_id]
        );
        await connection.query("COMMIT");
        return { state: "reauthorisation_required", cached: false };
      }
      if (!response.ok) throw new Error("Supabase temporarily unavailable for token refresh");
      const { validateProviderTokens } = await import("./connection-vault.mjs");
      credentials = validateProviderTokens(await response.json(), credentials);
      expiresAt = credentials.expiresAt;
      // Update rotated credentials immediately, even if the later profile
      // validation fails transiently, so we never lose the refresh token.
      await connection.query(
        `UPDATE portal_connections
         SET encrypted_tokens = $1, access_expires_at = $2, updated_at = now()
         WHERE connection_id = $3`,
        [
          encryptTokens(credentials, tokenBinding(row.connection_id, row.user_id, row.organization_id), key),
          new Date(credentials.expiresAt), row.connection_id,
        ]
      );
    }

    // Confirm the refreshed grant still covers the originally connected org.
    // Management API errors other than auth rejection are transient, not
    // evidence of revocation. Keep credentials intact.
    let organization;
    try {
      organization = await providerJson("/organizations", credentials.accessToken, fetchFn);
    } catch {
      // A rotated refresh token has already been UPDATEd in this transaction.
      // Commit it before reporting a transient verification problem, otherwise
      // a consumed refresh token could be lost forever on ROLLBACK.
      await connection.query("COMMIT");
      return { state: "temporarily_unavailable", cached: false };
    }
    if (organization.organizationId !== row.organization_id) {
      await connection.query(
        `UPDATE portal_connections
         SET status = 'reauthorisation_required', health_checked_at = now(), updated_at = now()
         WHERE connection_id = $1`, [row.connection_id]
      );
      await connection.query("COMMIT");
      return { state: "reauthorisation_required", cached: false };
    }
    await connection.query(
      `UPDATE portal_connections
       SET status = 'connected', health_checked_at = now(), updated_at = now()
       WHERE connection_id = $1`, [row.connection_id]
    );
    await connection.query("COMMIT");
    return { state: "connected", cached: false, checkedAt: new Date().toISOString() };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

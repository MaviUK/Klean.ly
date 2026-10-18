import { encryptTokens, decryptTokens, vaultKey } from "./connection-vault.mjs";
import { getPortalDatabase } from "./connection-store.mjs";

export function netlifyTokenBinding(portalUserId, netlifyUserId) {
  return JSON.stringify(["kleanly:netlify:connection:v1", portalUserId, netlifyUserId]);
}

// This is the only Netlify grant writer. The independent staging portal DB
// is the sole persistence target; no customer infrastructure is modified.
export async function saveNetlifyGrant(current, profile, accessToken, db = null, key = vaultKey()) {
  if (!current?.user_id || !key || !profile?.netlifyUserId) throw new Error("Authenticated session required");
  const database = db ?? await getPortalDatabase();
  const connection = await database.pool.connect();
  try {
    await connection.query("BEGIN");
    const owner = await connection.query("SELECT user_id FROM portal_users WHERE user_id = $1 FOR UPDATE", [current.user_id]);
    if (owner.rowCount !== 1) throw new Error("Portal user no longer exists");
    const existing = await connection.query(
      "SELECT netlify_user_id FROM portal_netlify_connections WHERE user_id = $1 FOR UPDATE",
      [current.user_id]
    );
    if (existing.rows.length && existing.rows[0].netlify_user_id !== profile.netlifyUserId) {
      throw new Error("Different Netlify account must be disconnected first");
    }
    const ciphertext = encryptTokens(
      { accessToken }, netlifyTokenBinding(current.user_id, profile.netlifyUserId), key
    );
    await connection.query(
      "INSERT INTO portal_netlify_connections " +
      "(user_id, netlify_user_id, netlify_email, encrypted_token) VALUES ($1, $2, $3, $4) " +
      "ON CONFLICT (user_id) DO UPDATE SET netlify_email = excluded.netlify_email, " +
      "encrypted_token = excluded.encrypted_token, status = 'connected', " +
      "health_checked_at = NULL, updated_at = now()",
      [current.user_id, profile.netlifyUserId, profile.email, ciphertext]
    );
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

export async function getNetlifyConnection(current, db = null) {
  if (!current?.user_id) return null;
  const database = db ?? await getPortalDatabase();
  const result = await database.pool.query(
    "SELECT user_id, netlify_user_id, netlify_email, encrypted_token, " +
    "status, connected_at, health_checked_at FROM portal_netlify_connections " +
    "WHERE user_id = $1 LIMIT 1",
    [current.user_id]
  );
  return result.rows[0] ?? null;
}
export async function disconnectNetlifyConnection(current, db = null) {
  if (!current?.user_id) return false;
  const database = db ?? await getPortalDatabase();
  const result = await database.pool.query(
    "DELETE FROM portal_netlify_connections WHERE user_id = $1", [current.user_id]
  );
  return result.rowCount === 1;
}
export async function inspectNetlifyConnection(current,
  { db = null, key = vaultKey(), fetchProfile } = {}
) {
  if (!current?.user_id || !key || typeof fetchProfile !== "function") throw new Error("Secure session required");
  const database = db ?? await getPortalDatabase();
  const record = await getNetlifyConnection(current, database);
  if (!record) return { state: "not_connected" };
  if (record.health_checked_at && Date.now() - new Date(record.health_checked_at).getTime() < 30000) {
    return { state: record.status, cached: true };
  }
  const { accessToken } = decryptTokens(
    record.encrypted_token,
    netlifyTokenBinding(current.user_id, record.netlify_user_id), key
  );
  let state;
  try {
    const profile = await fetchProfile(accessToken);
    state = profile.netlifyUserId === record.netlify_user_id ? "connected" : "reauthorisation_required";
  } catch (error) {
    if (error?.name !== "NetlifyAccessDenied") return { state: "temporarily_unavailable" };
    state = "reauthorisation_required";
  }
  // The prior credential must still match. Never overwrite a new grant.
  const result = await database.pool.query(
    "UPDATE portal_netlify_connections SET status = $1, " +
    "health_checked_at = now(), updated_at = now() " +
    "WHERE user_id = $2 AND netlify_user_id = $3 AND encrypted_token = $4",
    [state, current.user_id, record.netlify_user_id, record.encrypted_token]
  );
  return result.rowCount === 1 ? { state, cached: false } : { state: "temporarily_unavailable" };
}

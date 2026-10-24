import { providerJson } from "./connection-vault.mjs";
import { inspectConnectedGrant } from "./connection-store.mjs";
import { oauthConfig, TOKEN_URL } from "./supabase-oauth.mjs";
import { loadVerifiedGrant } from "./test-project-pilot.mjs";

// Read-only pilot reviews must not use stale Management API access tokens.
// Reuse the existing serialized connection health check, which atomically
// rotates encrypted OAuth credentials in the *installer* database when due.
// This never edits customer CRM records, Supabase Auth or the Netlify site.
export async function loadFreshPilotGrant(current, {
  checkHealth = inspectConnectedGrant,
  readGrant = loadVerifiedGrant,
} = {}) {
  if (!current || current.connection_status !== "connected" ||
      typeof current.user_id !== "string" ||
      typeof current.organization_id !== "string" ||
      typeof current.connection_id !== "string") {
    throw new Error("pilot_connection_unavailable");
  }
  const result = await checkHealth(current, {
    oauthConfig, tokenUrl: TOKEN_URL, providerJson,
  });
  if (result?.state !== "connected") {
    throw new Error(result?.state === "reauthorisation_required"
      ? "pilot_reauthorisation_required" : "pilot_connection_unavailable");
  }
  // Critically, read AFTER the refresh transaction has committed.
  const token = await readGrant(current);
  if (typeof token !== "string" || token.length < 8 || token.length > 8192) {
    throw new Error("pilot_connection_unavailable");
  }
  return token;
}

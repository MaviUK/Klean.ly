import {
  constantTimeEqual, requireSameOrigin, safeStatusResponse,
  permanentMode, vaultKey, decryptTokens, tokenBinding, providerJson,
} from "./_lib/connection-vault.mjs";
import {
  currentPortalSession, inspectConnectedGrant, getPortalDatabase,
} from "./_lib/connection-store.mjs";
import {
  inspectNetlifyConnection,
} from "./_lib/netlify-connection-store.mjs";
import { fetchNetlifyProfile } from "./_lib/netlify-oauth.mjs";
import { oauthConfig, TOKEN_URL } from "./_lib/supabase-oauth.mjs";

// This endpoint is strictly a read-only infrastructure preview.
// It never creates Supabase projects, Netlify sites, secrets or billing charges.
// All project discovery is scoped to the organisation verified in the
// existing server-side Supabase session. No user-provided slug is accepted.
export function parseProjectPage(body) {
  const projects = Array.isArray(body) ? body
    : Array.isArray(body?.projects) ? body.projects
    : Array.isArray(body?.data) ? body.data : null;
  if (!projects || projects.length > 100 || projects.some(
    (item) => !item || typeof item !== "object" || Array.isArray(item)
  )) throw new Error("Supabase project listing format could not be verified");
  // 100 is the maximum number requested. A full page may have more projects.
  return { observedProjectCount: projects.length, mayHaveMore: projects.length === 100 };
}

export async function readOrganizationProjectInventory(
  current, { db = null, key = vaultKey(), fetchFn = fetch } = {}
) {
  if (!current?.user_id || !current.connection_id || !current.organization_id || !key) {
    throw new Error("Authenticated and encrypted organisation grant required");
  }
  const slug = current.organization_slug;
  if (typeof slug !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) {
    throw new Error("Verified organisation slug unavailable");
  }
  const database = db ?? await getPortalDatabase();
  const result = await database.pool.query(
    "SELECT encrypted_tokens FROM portal_connections " +
    "WHERE connection_id = $1 AND user_id = $2 AND organization_id = $3 " +
    "AND status = 'connected' LIMIT 1",
    [current.connection_id, current.user_id, current.organization_id]
  );
  if (result.rows.length !== 1) throw new Error("Supabase connection missing or invalid");
  const credentials = decryptTokens(result.rows[0].encrypted_tokens,
    tokenBinding(current.connection_id, current.user_id, current.organization_id), key
  );
  const url = "https://api.supabase.com/v1/organizations/" +
    encodeURIComponent(slug) + "/projects?limit=100&offset=0";
  const response = await fetchFn(url, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + credentials.accessToken, Accept: "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("Supabase did not confirm its project listing");
  return parseProjectPage(await response.json());
}

async function verifySupabase(current) {
  return inspectConnectedGrant(current, {
    oauthConfig, tokenUrl: TOKEN_URL, providerJson,
  });
}
async function verifyNetlify(current) {
  return inspectNetlifyConnection(current, { fetchProfile: fetchNetlifyProfile });
}

export function createProvisioningPreflight({
  getSession = currentPortalSession,
  checkSupabase = verifySupabase,
  checkNetlify = verifyNetlify,
  getProjects = readOrganizationProjectInventory,
} = {}) {
  return async function handler(request) {
    if (request.method !== "POST") {
      return safeStatusResponse({ error: "Method not allowed" }, 405);
    }
    if (!requireSameOrigin(request)) {
      return safeStatusResponse({ error: "Cross-origin request denied" }, 403);
    }
    if (permanentMode() !== "permanent") {
      return safeStatusResponse({ error: "Secure portal not configured" }, 503);
    }
    try {
      const current = await getSession(request);
      if (!current) {
        return safeStatusResponse({ error: "Connect Supabase first" }, 401);
      }
      if (!constantTimeEqual(request.headers.get("x-csrf-token"), current.csrf_token)) {
        return safeStatusResponse({ error: "Session verification failed" }, 403);
      }
      if (current.connection_status !== "connected") {
        return safeStatusResponse({ error: "Reconnect Supabase before checking installation readiness" }, 409);
      }
      const [supabase, netlify] = await Promise.all([
        checkSupabase(current), checkNetlify(current),
      ]);
      if (supabase?.state !== "connected" || netlify?.state !== "connected") {
        return safeStatusResponse({
          error: "Check or reconnect both infrastructure accounts before continuing",
          connected: false,
        }, 409);
      }
      const inventory = await getProjects(current);
      return safeStatusResponse({
        readyForCostReview: true,
        readyToInstall: false,
        installationsCreated: false,
        billingVerified: false,
        explicitCostApprovalRequired: true,
        supabaseVerified: true,
        netlifyVerified: true,
        organizationName: current.organization_name,
        observedProjectCount: inventory.observedProjectCount,
        mayHaveMoreProjects: inventory.mayHaveMore,
        note: "Provider access and project inventory checked; no projects or sites were created.",
      });
    } catch {
      return safeStatusResponse({
        readyForCostReview: false, readyToInstall: false,
        installationsCreated: false,
        error: "Read-only prerequisite check could not be completed. No resources were created.",
      }, 503);
    }
  };
}

export default createProvisioningPreflight();
export const config = {
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 15 },
};

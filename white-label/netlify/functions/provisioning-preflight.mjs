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
export class ProvisioningPreflightError extends Error {
  constructor(code) {
    super("Read-only readiness check cannot be verified");
    this.name = "ProvisioningPreflightError";
    this.code = code;
  }
}

const safeDiagnosticMessages = Object.freeze({
  session_lookup_failed: "Your secure portal session could not be checked. Please retry.",
  supabase_validation_failed: "The Supabase connection could not be verified right now.",
  netlify_validation_failed: "The Netlify connection could not be verified right now.",
  stored_grant_unavailable: "The linked Supabase authorisation could not be read securely.",
  organization_identifier_unavailable: "The connected Supabase organisation has no usable identifier.",
  projects_permission_denied: "Supabase denied project-list access. Check that the OAuth app has Projects Read permission.",
  projects_auth_expired: "Supabase declined this authorisation for listing projects. Please reconnect Supabase on Step 2.",
  projects_rate_limited: "Supabase temporarily limited project-listing requests.",
  projects_upstream_unavailable: "Supabase could not provide the project list right now.",
  projects_response_invalid: "Supabase returned a project list in an unexpected format.",
  projects_lookup_failed: "The connected Supabase project list could not be checked right now.",
});

function safePreflightFailure(code) {
  // Never log provider payloads, tokens, account IDs, URLs or session cookies.
  console.warn("[Klean.ly Business readiness] " + code);
  return safeStatusResponse({
    readyForCostReview: false, readyToInstall: false, installationsCreated: false,
    code,
    error: safeDiagnosticMessages[code] || "Read-only prerequisites could not be checked.",
  }, 503);
}

// GET /v1/projects is the account-wide endpoint allowed by projects:read.
// The returned array includes a provider-issued organization_id per project.
// Count ONLY projects assigned to the organization verified in the portal
// session, never an organization provided by the browser or a query string.
// Fail closed on invalid/truncated-looking results instead of undercounting.
export function parseProjectPage(body, organizationId) {
  if (!Array.isArray(body) || !organizationId ||
      typeof organizationId !== "string" || organizationId.length > 128 ||
      body.length > 5000 ||
      body.some((item) => !item || typeof item !== "object" || Array.isArray(item) ||
        typeof item.organization_id !== "string" ||
        item.organization_id.length < 1 || item.organization_id.length > 128)) {
    throw new ProvisioningPreflightError("projects_response_invalid");
  }
  return {
    observedProjectCount: body.filter((item) => item.organization_id === organizationId).length,
    mayHaveMore: false,
  };
}

export async function readOrganizationProjectInventory(
  current, { db = null, key = vaultKey(), fetchFn = fetch } = {}
) {
  if (!current?.user_id || !current.connection_id || !current.organization_id || !key) {
    throw new ProvisioningPreflightError("stored_grant_unavailable");
  }
  const slug = current.organization_slug;
  if (typeof slug !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) {
    throw new ProvisioningPreflightError("organization_identifier_unavailable");
  }
  const database = db ?? await getPortalDatabase();
  const result = await database.pool.query(
    "SELECT encrypted_tokens FROM portal_connections " +
    "WHERE connection_id = $1 AND user_id = $2 AND organization_id = $3 " +
    "AND status = 'connected' LIMIT 1",
    [current.connection_id, current.user_id, current.organization_id]
  );
  if (result.rows.length !== 1) throw new ProvisioningPreflightError("stored_grant_unavailable");
  const credentials = decryptTokens(result.rows[0].encrypted_tokens,
    tokenBinding(current.connection_id, current.user_id, current.organization_id), key
  );
  // Organization-specific /v1/organizations/{slug}/projects returned 403
  // for the verified staging OAuth grant despite Projects Read. The
  // documented account-wide listing accepts projects:read and includes an
  // organization_id so we can filter against the verified session securely.
  const url = "https://api.supabase.com/v1/projects";
  const response = await fetchFn(url, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + credentials.accessToken, Accept: "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 401) {
    throw new ProvisioningPreflightError("projects_auth_expired");
  }
  if (response.status === 403) {
    throw new ProvisioningPreflightError("projects_permission_denied");
  }
  if (response.status === 429) throw new ProvisioningPreflightError("projects_rate_limited");
  if (!response.ok) throw new ProvisioningPreflightError("projects_upstream_unavailable");
  return parseProjectPage(await response.json(), current.organization_id);
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
    let stage = "session_lookup_failed";
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
      const checked = await Promise.allSettled([
        checkSupabase(current), checkNetlify(current),
      ]);
      if (checked[0].status === "rejected") {
        return safePreflightFailure("supabase_validation_failed");
      }
      if (checked[1].status === "rejected") {
        return safePreflightFailure("netlify_validation_failed");
      }
      const [supabase, netlify] = checked.map(entry => entry.value);
      if (supabase?.state !== "connected" || netlify?.state !== "connected") {
        return safeStatusResponse({
          error: supabase?.state !== "connected"
            ? "Supabase could not confirm your grant. Use Check connection on Step 2."
            : "Netlify could not confirm your grant. Use Check connection on Step 2.",
          code: supabase?.state !== "connected" ? "supabase_not_verified" : "netlify_not_verified",
          connected: false, readyToInstall: false, installationsCreated: false,
        }, 409);
      }
      stage = "projects_lookup_failed";
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
    } catch (error) {
      return safePreflightFailure(error instanceof ProvisioningPreflightError
        ? error.code : stage);
    }
  };
}

export default createProvisioningPreflight();
export const config = {
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 15 },
};

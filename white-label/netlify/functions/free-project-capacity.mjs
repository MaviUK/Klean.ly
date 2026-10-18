import {
  constantTimeEqual, requireSameOrigin, safeStatusResponse,
  permanentMode, vaultKey, decryptTokens, tokenBinding,
} from "./_lib/connection-vault.mjs";
import { currentPortalSession, getPortalDatabase } from "./_lib/connection-store.mjs";
import { createProvisioningPreflight } from "./provisioning-preflight.mjs";

// Staging-only billing safety gate. This function makes GET requests only.
// Project creation is intentionally NOT exposed; no project, deployment,
// paid plan, API key, password or permission is changed by this endpoint.
const API = "https://api.supabase.com/v1";
const PROJECT_LIMIT = 5000;
const MAX_SCOPE = 128;

export class CapacityCheckError extends Error {
  constructor(code) {
    super("The free project check could not be completed.");
    this.name = "CapacityCheckError";
    this.code = code;
  }
}

const messages = Object.freeze({
  invalid_organization: "The connected Supabase organisation could not be verified.",
  connection_unavailable: "Your saved Supabase organisation grant is temporarily unavailable.",
  organization_denied: "Supabase denied access to the organisation plan. Reconnect if this continues.",
  projects_denied: "Supabase denied access to the project list. Check Projects Read permissions.",
  provider_unavailable: "Supabase's Management API could not finish the free-project check.",
  response_invalid: "Supabase returned an unexpected organisation or project response.",
  capacity_unavailable: "Free project capacity could not be verified right now.",
});

function validateCurrent(current) {
  return !!(
    current &&
    typeof current.user_id === "string" && current.user_id.length <= MAX_SCOPE &&
    typeof current.connection_id === "string" &&
    typeof current.organization_id === "string" && current.organization_id.length <= MAX_SCOPE &&
    typeof current.organization_slug === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,127}$/.test(current.organization_slug)
  );
}

function providerError(status, target) {
  if ([401, 403].includes(status)) {
    return new CapacityCheckError(target === "organization" ? "organization_denied" : "projects_denied");
  }
  return new CapacityCheckError("provider_unavailable");
}

export function assessFreeProjectCapacity(organization, projects, current) {
  if (!validateCurrent(current) || !organization || typeof organization !== "object" ||
      Array.isArray(organization) ||
      organization.id !== current.organization_id ||
      typeof organization.plan !== "string" ||
      organization.plan.length > 40 || !Array.isArray(projects) ||
      projects.length > PROJECT_LIMIT ||
      projects.some((p) =>
        !p || typeof p !== "object" || Array.isArray(p) ||
        typeof p.organization_id !== "string" || p.organization_id.length < 1 ||
        p.organization_id.length > MAX_SCOPE
      )) {
    throw new CapacityCheckError("response_invalid");
  }

  // Count *all* visible projects rather than discounting paused projects:
  // deliberately conservative because Supabase's Free quota also depends
  // on other Owner/Admin memberships that may not be visible to this grant.
  const visibleAccountProjects = projects.length;
  const thisOrganizationProjects = projects.filter(
    (p) => p.organization_id === current.organization_id
  ).length;
  const freePlanConfirmed = organization.plan.toLowerCase() === "free";
  const appearsWithinFreeLimit = freePlanConfirmed && visibleAccountProjects < 2;

  return {
    organizationName: current.organization_name || "Connected organisation",
    freePlanConfirmed,
    visibleAccountProjects,
    thisOrganizationProjects,
    appearsWithinFreeLimit,
    freeCapacityGuaranteed: false,
    requiresExplicitApproval: true,
    allowedToCreateProject: false,
    projectCreated: false,
    chargesApproved: false,
    nextStage: appearsWithinFreeLimit
      ? "The organisation appears within the Free Plan limit. We can prepare a single test creation request after explicit approval."
      : "Free project availability is not confirmed. No project creation will be enabled.",
    note: "Read-only eligibility check: Supabase makes the final quota determination. All provider costs remain unapproved and creation is disabled.",
  };
}

export async function readFreeProjectCapacity(
  current, { db = null, key = vaultKey(), fetchFn = fetch } = {}
) {
  if (!validateCurrent(current) || !key || current.connection_status !== "connected") {
    throw new CapacityCheckError("invalid_organization");
  }
  const database = db ?? await getPortalDatabase();
  const results = await database.pool.query(
    "SELECT encrypted_tokens FROM portal_connections " +
      "WHERE connection_id = $1 AND user_id = $2 " +
      "AND organization_id = $3 AND status = 'connected' LIMIT 1",
    [current.connection_id, current.user_id, current.organization_id]
  );
  if (results.rows.length !== 1) throw new CapacityCheckError("connection_unavailable");
  let credentials;
  try {
    credentials = decryptTokens(
      results.rows[0].encrypted_tokens,
      tokenBinding(current.connection_id, current.user_id, current.organization_id), key
    );
  } catch {
    throw new CapacityCheckError("connection_unavailable");
  }
  if (typeof credentials?.accessToken !== "string" || credentials.accessToken.length < 8) {
    throw new CapacityCheckError("connection_unavailable");
  }

  const headers = {
    Authorization: "Bearer " + credentials.accessToken,
    Accept: "application/json",
  };
  const orgUrl = API + "/organizations/" + encodeURIComponent(current.organization_slug);
  const projectsUrl = API + "/projects";
  const options = () => ({
    method: "GET", headers, signal: AbortSignal.timeout(15000),
  });
  let responses;
  try {
    responses = await Promise.all([
      fetchFn(orgUrl, options()), fetchFn(projectsUrl, options()),
    ]);
  } catch {
    throw new CapacityCheckError("provider_unavailable");
  }
  if (!responses[0].ok) throw providerError(responses[0].status, "organization");
  if (!responses[1].ok) throw providerError(responses[1].status, "projects");

  try {
    const [organization, projects] = await Promise.all(
      responses.map((response) => response.json())
    );
    return assessFreeProjectCapacity(organization, projects, current);
  } catch (error) {
    if (error instanceof CapacityCheckError) throw error;
    throw new CapacityCheckError("response_invalid");
  }
}

export function createFreeProjectCapacityHandler({
  getSession = currentPortalSession,
  readCapacity = readFreeProjectCapacity,
  checkReadiness = createProvisioningPreflight(),
} = {}) {
  return async function handler(request) {
    if (request.method !== "POST") {
      return safeStatusResponse({ error: "Method not allowed" }, 405);
    }
    if (!requireSameOrigin(request)) {
      return safeStatusResponse({ error: "Cross-origin request denied" }, 403);
    }
    if (permanentMode() !== "permanent") {
      return safeStatusResponse({ error: "Secure portal is not enabled." }, 503);
    }

    let current;
    try {
      current = await getSession(request);
    } catch {
      return safeStatusResponse({ error: "Secure portal session unavailable." }, 503);
    }
    if (!current) return safeStatusResponse({ error: "Connect Supabase first." }, 401);
    if (!constantTimeEqual(request.headers.get("x-csrf-token"), current.csrf_token)) {
      return safeStatusResponse({ error: "Session verification failed" }, 403);
    }

    // Existing preflight checks *both* provider grants and refreshes Supabase's
    // OAuth token if needed, before reading its account-wide project inventory.
    try {
      const readiness = await checkReadiness(request);
      if (!readiness?.ok) return safeStatusResponse({
        error: "Check or reconnect both provider grants on Step 2 first.",
        code: "readiness_required",
        allowedToCreateProject: false, projectCreated: false,
      }, 409);
      const data = await readiness.json();
      if (!data || data.readyForCostReview !== true ||
          data.supabaseVerified !== true || data.netlifyVerified !== true ||
          data.installationsCreated !== false || data.readyToInstall !== false) {
        return safeStatusResponse({
          error: "Both providers must pass the secure readiness check.",
          allowedToCreateProject: false, projectCreated: false,
        }, 409);
      }
    } catch {
      return safeStatusResponse({
        error: "Secure readiness is temporarily unavailable.",
        allowedToCreateProject: false, projectCreated: false,
      }, 503);
    }

    try {
      const data = await readCapacity(current);
      return safeStatusResponse(data);
    } catch (error) {
      const code = error instanceof CapacityCheckError
        ? error.code : "capacity_unavailable";
      console.warn("[Klean.ly Business free project capacity] " + code);
      return safeStatusResponse({
        error: messages[code] || messages.capacity_unavailable,
        code, allowedToCreateProject: false, projectCreated: false,
      }, 503);
    }
  };
}

export default createFreeProjectCapacityHandler();
export const config = {
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 12 },
};

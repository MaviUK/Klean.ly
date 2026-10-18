import {
  constantTimeEqual, decryptTokens, permanentMode, requireSameOrigin,
  safeStatusResponse, vaultKey,
} from "./_lib/connection-vault.mjs";
import { currentPortalSession } from "./_lib/connection-store.mjs";
import {
  getNetlifyConnection, netlifyTokenBinding,
} from "./_lib/netlify-connection-store.mjs";
import { fetchNetlifyProfile } from "./_lib/netlify-oauth.mjs";
import {
  isPilotTarget, isStagingHost, pilotSettings, PILOT_PROJECT_NAME,
} from "./_lib/test-project-pilot.mjs";
import { createOwnerLoginReadinessHandler } from "./owner-login-readiness.mjs";

// Separate white-label CRM test website, NOT the live Klean.ly directory.
// This function performs only GETs on the Netlify OAuth account connected
// INSIDE the staging installer. The ChatGPT Netlify account is not used.
export const PILOT_CRM_SITE_NAME = "kleanly-business-crm-pilot";
export const PILOT_CRM_SITE_URL = "https://" + PILOT_CRM_SITE_NAME + ".netlify.app";
export const NETLIFY_API = "https://api.netlify.com/api/v1";
const MAX_ACCOUNT_COUNT = 30;
const MAX_LISTED_SITES = 100;

function validId(value) {
  return typeof value === "string" && /^[\w:-]{1,128}$/.test(value);
}

export function parseNetlifyTeams(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ACCOUNT_COUNT) {
    throw new Error("netlify_team_list_invalid");
  }
  const teams = raw.map((entry) => {
    if (!entry || !validId(entry.id) ||
        typeof entry.slug !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,127}$/.test(entry.slug) ||
        typeof entry.name !== "string" || entry.name.length < 1 ||
        entry.name.length > 160) {
      throw new Error("netlify_team_list_invalid");
    }
    return {
      id: entry.id, slug: entry.slug, name: entry.name,
      plan: typeof entry.type_name === "string" &&
        /^[A-Za-z0-9 _-]{1,80}$/.test(entry.type_name)
          ? entry.type_name : "Not confirmed",
    };
  });
  if (new Set(teams.map((team) => team.id)).size !== teams.length ||
      new Set(teams.map((team) => team.slug)).size !== teams.length) {
    throw new Error("netlify_team_list_invalid");
  }
  return teams;
}

export function parseNetlifyMatchingSites(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_LISTED_SITES) {
    throw new Error("netlify_site_list_invalid");
  }
  const found = raw.filter((site) => {
    if (!site || typeof site !== "object" || Array.isArray(site) ||
        !validId(site.id) ||
        typeof site.name !== "string" || site.name.length > 160) {
      throw new Error("netlify_site_list_invalid");
    }
    return site.name === PILOT_CRM_SITE_NAME;
  });
  return found.map((site) => ({
    id: site.id,
    siteName: site.name,
    accountId: validId(site.account_id) ? site.account_id : null,
  }));
}

async function readNetlifyJson(url, accessToken, fetchFn = fetch) {
  const response = await fetchFn(url, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + accessToken,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(
    response.status === 401 || response.status === 403
      ? "netlify_permissions_required" : "netlify_lookup_unavailable"
  );
  return response.json();
}

export async function inspectCrmNetlifySite(accessToken, fetchFn = fetch) {
  if (typeof accessToken !== "string" || accessToken.length < 8 ||
      accessToken.length > 8192) throw new Error("netlify_grant_invalid");
  const accounts = parseNetlifyTeams(await readNetlifyJson(
    NETLIFY_API + "/accounts", accessToken, fetchFn
  ));
  // A user-visible list is NOT proof of global site-name availability.
  const found = parseNetlifyMatchingSites(await readNetlifyJson(
    NETLIFY_API + "/sites?name=" + encodeURIComponent(PILOT_CRM_SITE_NAME) +
    "&per_page=" + MAX_LISTED_SITES,
    accessToken, fetchFn
  ));
  return { accounts, existingSitesVisibleToUser: found };
}

export async function loadVerifiedNetlifyPilotGrant(current, {
  getConnection = getNetlifyConnection,
  getKey = vaultKey,
  getProfile = fetchNetlifyProfile,
} = {}) {
  const key = getKey();
  if (!key || !current?.user_id) throw new Error("netlify_grant_unavailable");
  const record = await getConnection(current);
  if (record?.status !== "connected" ||
      !validId(record.netlify_user_id)) {
    throw new Error("netlify_grant_unavailable");
  }
  const secret = decryptTokens(
    record.encrypted_token,
    netlifyTokenBinding(current.user_id, record.netlify_user_id),
    key
  );
  const accessToken = secret?.accessToken;
  if (typeof accessToken !== "string" || accessToken.length < 8 ||
      accessToken.length > 8192) throw new Error("netlify_grant_unavailable");
  const profile = await getProfile(accessToken);
  if (profile?.netlifyUserId !== record.netlify_user_id) {
    throw new Error("netlify_identity_mismatch");
  }
  return { accessToken, netlifyAccountEmail: profile.email };
}

function failure(message, status = 409) {
  return safeStatusResponse({
    mode: "read_only_crm_site_proposal",
    error: message, siteCreated: false, deploymentCreated: false,
    invitationSent: false, readyToCreateSite: false, writeAttempted: false,
  }, status);
}

export function createCrmSiteProposalHandler({
  getSession = currentPortalSession,
  getMode = permanentMode,
  getSettings = pilotSettings,
  reviewOwner = createOwnerLoginReadinessHandler(),
  getNetlifyGrant = loadVerifiedNetlifyPilotGrant,
  inspectSite = inspectCrmNetlifySite,
} = {}) {
  return async function handler(request) {
    if (request.method !== "POST") return failure("Method not allowed", 405);
    if (!requireSameOrigin(request) || !isStagingHost(request)) {
      return failure("Staging only", 403);
    }
    if (getMode() !== "permanent") return failure("Secure staging login unavailable", 503);
    let current;
    try { current = await getSession(request); }
    catch { return failure("Unable to check the secure portal session", 503); }
    if (!current) return failure("Reconnect your test Supabase account", 401);
    if (!constantTimeEqual(request.headers.get("x-csrf-token"), current.csrf_token)) {
      return failure("Session verification failed", 403);
    }
    if (!isPilotTarget(current, getSettings())) {
      return failure("The staging test owner was not verified", 403);
    }

    // Recheck all eight RLS-enabled tables, empty owner and original pilot
    // before querying the distinct, connected customer Netlify account.
    let readiness;
    try {
      const response = await reviewOwner(request);
      if (!response?.ok) return failure("Run the owner login readiness check first");
      readiness = await response.json();
    } catch {
      return failure("CRM owner readiness could not be confirmed", 503);
    }
    if (readiness.mode !== "staging_owner_login_readiness" ||
        readiness.state !== "owner_setup_can_be_prepared" ||
        readiness.projectVerified !== true ||
        readiness.schemaVerified !== true ||
        readiness.readyForInvitationDevelopment !== true ||
        readiness.eightTablesConfirmed !== true ||
        readiness.eightRlsConfirmed !== true ||
        readiness.ownerInvitationEnabled !== false ||
        readiness.projectName !== PILOT_PROJECT_NAME ||
        readiness.ownerConfigured !== false ||
        readiness.staffConfigured !== false ||
        readiness.writeAttempted !== false) {
      return failure("Complete and verify the CRM schema before setting up its website");
    }

    let grant, checked;
    try {
      grant = await getNetlifyGrant(current);
      checked = await inspectSite(grant.accessToken);
    } catch {
      return failure("The connected test Netlify account could not be inspected", 503);
    }
    if (typeof grant?.netlifyAccountEmail !== "string" ||
        !Array.isArray(checked?.accounts) || checked.accounts.length < 1 ||
        !Array.isArray(checked?.existingSitesVisibleToUser)) {
      return failure("The Netlify account check returned incomplete information", 503);
    }
    const existing = checked.existingSitesVisibleToUser.length > 0;
    return safeStatusResponse({
      mode: "read_only_crm_site_proposal",
      projectName: PILOT_PROJECT_NAME,
      supabaseProjectRef: readiness.projectRef,
      ownerEmail: getSettings().ownerEmail,
      connectedNetlifyEmail: grant.netlifyAccountEmail,
      proposedSiteName: PILOT_CRM_SITE_NAME,
      proposedSiteUrl: PILOT_CRM_SITE_URL,
      testNetlifyTeams: checked.accounts,
      teamSelectionRequired: true,
      matchingSitesInConnectedAccount: checked.existingSitesVisibleToUser.length,
      existingSiteReviewRequired: existing,
      globalNameAvailabilityConfirmed: false,
      providerBillingApproved: false,
      siteCreated: false,
      deploymentCreated: false,
      invitationSent: false,
      readyToCreateSite: false,
      writeAttempted: false,
      note: existing
        ? "A matching site is already visible to this Netlify account. Review it before any installer creation attempt."
        : "No matching site is visible in the connected account. Global name availability, team ownership and billing remain unverified. No site was created.",
    });
  };
}

export default createCrmSiteProposalHandler();
export const config = {
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 10 },
};

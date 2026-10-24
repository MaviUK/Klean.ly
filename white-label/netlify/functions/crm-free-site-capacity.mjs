import {
  constantTimeEqual, permanentMode, requireSameOrigin, safeStatusResponse,
} from "./_lib/connection-vault.mjs";
import { currentPortalSession } from "./_lib/connection-store.mjs";
import {
  isPilotTarget, isStagingHost, pilotSettings,
} from "./_lib/test-project-pilot.mjs";
import {
  createCrmSiteProposalHandler, loadVerifiedNetlifyPilotGrant,
  PILOT_CRM_SITE_NAME, PILOT_CRM_SITE_URL, NETLIFY_API,
} from "./crm-site-proposal.mjs";

// READ-ONLY final capacity review for the explicitly selected TEST Netlify
// account. The approved test team is never selected from browser input.
// No Netlify site, domain, deploy, billable add-on or invitation is created.
export const PILOT_NETLIFY_SLUG = "kleanlytest";
export const PILOT_NETLIFY_EMAIL = "kleanlytest@gerball.co.uk";
export const NETLIFY_FREE_PROJECT_LIMIT = 500;
const PAGE_SIZE = 100;
const MAX_PAGES = 6;

function validId(value) {
  return typeof value === "string" && /^[\w:-]{1,128}$/.test(value);
}

export function validateFreeTestTeam(raw, previouslyVerifiedTeam) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      !validId(raw.id) || raw.id !== previouslyVerifiedTeam?.id ||
      raw.slug !== PILOT_NETLIFY_SLUG ||
      raw.name !== previouslyVerifiedTeam.name ||
      raw.type_name !== "Free" || previouslyVerifiedTeam.plan !== "Free") {
    throw new Error("free_test_team_not_verified");
  }
  const counter = raw.capabilities?.sites;
  // Older plans may not expose meaningful site-count capabilities.
  // Never treat an absent/zero value as confirmation of free capacity.
  let providerLimit = null, providerUsed = null;
  if (counter !== undefined && counter !== null) {
    if (!Number.isSafeInteger(counter.included) ||
        !Number.isSafeInteger(counter.used) ||
        counter.included < 0 || counter.used < 0) {
      throw new Error("netlify_capacity_response_invalid");
    }
    if (counter.included > 0) {
      providerLimit = counter.included;
      providerUsed = counter.used;
    }
  }
  return { id: raw.id, slug: raw.slug, name: raw.name,
    plan: "Free", providerLimit, providerUsed };
}

export function validateFreeTeamSitePage(rows, team) {
  if (!Array.isArray(rows) || rows.length > PAGE_SIZE) {
    throw new Error("netlify_site_page_invalid");
  }
  return rows.map((site) => {
    if (!site || typeof site !== "object" || Array.isArray(site) ||
        !validId(site.id) || typeof site.name !== "string" ||
        !/^[a-z0-9-]{1,80}$/.test(site.name) ||
        site.account_id !== team.id ||
        (site.account_slug !== undefined && site.account_slug !== team.slug)) {
      throw new Error("netlify_site_page_invalid");
    }
    return { id: site.id, name: site.name };
  });
}

async function netlifyGet(url, token, fetchFn = fetch) {
  const response = await fetchFn(url, {
    method: "GET",
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error([401,403].includes(response.status)
      ? "netlify_permissions_missing" : "netlify_provider_unavailable");
  }
  return response.json();
}

export async function checkNetlifyFreeTeamCapacity(token, expectedTeam, {
  fetchFn = fetch,
} = {}) {
  if (typeof token !== "string" || token.length < 8 || token.length > 8192 ||
      expectedTeam?.slug !== PILOT_NETLIFY_SLUG ||
      !validId(expectedTeam?.id)) {
    throw new Error("unexpected_netlify_target");
  }
  // Freshly verify provider-issued identity and active Free Plan, including
  // the account ID. Never trust a team slug sent in the request body.
  const detail = validateFreeTestTeam(
    await netlifyGet(NETLIFY_API + "/accounts/" +
      encodeURIComponent(expectedTeam.id), token, fetchFn),
    expectedTeam
  );

  const seen = new Set();
  let count = 0, matchingSite = false, exactCount = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = NETLIFY_API + "/" + encodeURIComponent(PILOT_NETLIFY_SLUG) +
      "/sites?per_page=" + PAGE_SIZE + "&page=" + page;
    const rows = validateFreeTeamSitePage(
      await netlifyGet(url, token, fetchFn), detail
    );
    for (const site of rows) {
      if (seen.has(site.id)) throw new Error("netlify_site_page_duplicate");
      seen.add(site.id);
      count++;
      if (site.name === PILOT_CRM_SITE_NAME) matchingSite = true;
    }
    if (rows.length < PAGE_SIZE) { exactCount = true; break; }
  }
  if (!exactCount || count > NETLIFY_FREE_PROJECT_LIMIT) {
    throw new Error("netlify_site_limit_not_verifiable");
  }
  // The provider's own capability counter, if meaningful, is an additional
  // upper bound. It may not exist for every generation of Free Plan.
  const providerHasSpace = detail.providerLimit === null ||
    detail.providerUsed < detail.providerLimit;
  return {
    team: { name: detail.name, slug: detail.slug, plan: detail.plan },
    currentSites: count,
    documentedProjectLimit: NETLIFY_FREE_PROJECT_LIMIT,
    matchingNameInChosenTeam: matchingSite,
    underDocumentedProjectLimit: count < NETLIFY_FREE_PROJECT_LIMIT,
    providerCapabilityAllowsNewSite: providerHasSpace,
    accountIsFree: true,
    teamCapacityAppearsAvailable:
      !matchingSite && count < NETLIFY_FREE_PROJECT_LIMIT && providerHasSpace,
  };
}

function failure(message, status = 409) {
  return safeStatusResponse({
    mode: "read_only_crm_free_site_capacity",
    error: message,
    siteCreated: false, deploymentCreated: false, emailSent: false,
    creationEnabled: false, writeAttempted: false,
  }, status);
}

export function createCrmFreeSiteCapacityHandler({
  getMode = permanentMode,
  getSession = currentPortalSession,
  getSettings = pilotSettings,
  checkSiteProposal = createCrmSiteProposalHandler(),
  getNetlifyGrant = loadVerifiedNetlifyPilotGrant,
  checkCapacity = checkNetlifyFreeTeamCapacity,
} = {}) {
  return async function handler(request) {
    if (request.method !== "POST") return failure("Method not allowed", 405);
    if (!requireSameOrigin(request) || !isStagingHost(request)) {
      return failure("Staging access only", 403);
    }
    if (getMode() !== "permanent") return failure("Secure test portal unavailable", 503);
    let current;
    try { current = await getSession(request); }
    catch { return failure("Unable to verify the test session", 503); }
    if (!current) return failure("Reconnect the test Supabase account", 401);
    if (!constantTimeEqual(request.headers.get("x-csrf-token"), current.csrf_token)) {
      return failure("Session verification failed", 403);
    }
    const settings = getSettings();
    if (!isPilotTarget(current, settings) ||
        settings.ownerEmail !== PILOT_NETLIFY_EMAIL) {
      return failure("This review is restricted to the approved test owner", 403);
    }

    let proposal;
    try {
      const result = await checkSiteProposal(request);
      if (!result?.ok) return failure("Run the CRM website review first");
      proposal = await result.json();
    } catch { return failure("CRM website readiness could not be checked", 503); }

    if (proposal?.mode !== "read_only_crm_site_proposal" ||
        proposal.ownerEmail !== PILOT_NETLIFY_EMAIL ||
        proposal.connectedNetlifyEmail !== PILOT_NETLIFY_EMAIL ||
        proposal.proposedSiteName !== PILOT_CRM_SITE_NAME ||
        proposal.proposedSiteUrl !== PILOT_CRM_SITE_URL ||
        proposal.existingSiteReviewRequired !== false ||
        proposal.matchingSitesInConnectedAccount !== 0 ||
        !Array.isArray(proposal.testNetlifyTeams) ||
        proposal.siteCreated !== false || proposal.writeAttempted !== false) {
      return failure("The selected Netlify account or site is not verified");
    }
    const teams = proposal.testNetlifyTeams.filter(t => t.slug === PILOT_NETLIFY_SLUG);
    if (teams.length !== 1 || teams[0].plan !== "Free" ||
        !validId(teams[0].id)) {
      return failure("The chosen test team must remain on the Free Plan");
    }

    let access, capacity;
    try {
      access = await getNetlifyGrant(current);
      if (access?.netlifyAccountEmail !== PILOT_NETLIFY_EMAIL) {
        return failure("The connected Netlify owner does not match the approved test account");
      }
      capacity = await checkCapacity(access.accessToken, teams[0]);
    } catch {
      return failure("Netlify Free Plan capacity could not be verified", 503);
    }
    if (capacity?.accountIsFree !== true ||
        capacity.team?.slug !== PILOT_NETLIFY_SLUG ||
        !Number.isSafeInteger(capacity.currentSites) ||
        typeof capacity.teamCapacityAppearsAvailable !== "boolean" ||
        typeof capacity.matchingNameInChosenTeam !== "boolean") {
      return failure("The connected Netlify capacity check was incomplete", 503);
    }

    return safeStatusResponse({
      mode: "read_only_crm_free_site_capacity",
      proposedSiteUrl: PILOT_CRM_SITE_URL,
      ownerEmail: PILOT_NETLIFY_EMAIL,
      connectedNetlifyAccount: PILOT_NETLIFY_EMAIL,
      teamName: capacity.team.name,
      teamSlug: PILOT_NETLIFY_SLUG,
      confirmedFreePlan: true,
      sitesInTeam: capacity.currentSites,
      documentedFreeProjectLimit: NETLIFY_FREE_PROJECT_LIMIT,
      matchingNameInChosenTeam: capacity.matchingNameInChosenTeam,
      capacityAppearsAvailable: capacity.teamCapacityAppearsAvailable,
      globalNameAvailabilityConfirmed: false,
      remainingMonthlyCreditsVerified: false,
      priceQuoteProvided: false,
      providerCostApprovalRequired: true,
      siteCreated: false,
      deploymentCreated: false,
      emailSent: false,
      creationEnabled: false,
      writeAttempted: false,
      note: "Read-only Free Plan site-count check. Current credit balance was not retrieved. " +
        "Free Plan projects share a monthly usage allowance and can pause when the allowance is exhausted. " +
        "No paid upgrade, add-on, registration, deployment or Netlify project was requested. " +
        "Site name availability will only be final when the owner separately approves a real creation request.",
    });
  };
}

export default createCrmFreeSiteCapacityHandler();
export const config = {
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 10 },
};

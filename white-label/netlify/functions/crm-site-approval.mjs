import {
  constantTimeEqual, permanentMode, requireSameOrigin, safeStatusResponse,
} from "./_lib/connection-vault.mjs";
import { currentPortalSession } from "./_lib/connection-store.mjs";
import { isPilotTarget, isStagingHost, pilotSettings } from "./_lib/test-project-pilot.mjs";
import {
  CRM_SITE_CONFIRMATION, crmSiteCreationEnabled,
  readCrmSiteAttempt, publicCrmSiteAttempt, CRM_SITE_OWNER_EMAIL,
  CRM_SITE_TEAM_SLUG,
} from "./_lib/crm-site-pilot.mjs";
import { createCrmFreeSiteCapacityHandler } from "./crm-free-site-capacity.mjs";
import { PILOT_CRM_SITE_NAME, PILOT_CRM_SITE_URL } from "./crm-site-proposal.mjs";

// Read-only server gate for staging CRM site creation: no provider writes.
// OFF by default even after the owner confirms team selection and Free Plan.
export function verifiedCrmSiteCapacity(data) {
  return data?.mode === "read_only_crm_free_site_capacity" &&
    data?.ownerEmail === CRM_SITE_OWNER_EMAIL &&
    data?.connectedNetlifyAccount === CRM_SITE_OWNER_EMAIL &&
    data?.teamSlug === CRM_SITE_TEAM_SLUG &&
    data?.proposedSiteUrl === PILOT_CRM_SITE_URL &&
    data?.confirmedFreePlan === true &&
    Number.isSafeInteger(data?.sitesInTeam) &&
    data.sitesInTeam >= 0 &&
    data.sitesInTeam < 500 &&
    data?.capacityAppearsAvailable === true &&
    data?.matchingNameInChosenTeam === false &&
    data?.globalNameAvailabilityConfirmed === false &&
    data?.remainingMonthlyCreditsVerified === false &&
    data?.providerCostApprovalRequired === true &&
    data?.siteCreated === false &&
    data?.deploymentCreated === false &&
    data?.creationEnabled === false &&
    data?.writeAttempted === false;
}

function failed(message, status = 409) {
  return safeStatusResponse({
    mode: "staging_one_crm_site_pilot", error: message,
    creationUnlocked: false, creationLocked: true,
    siteCreated: false, writeAttempted: false,
  }, status);
}

export function createCrmSiteApprovalHandler({
  getSession = currentPortalSession,
  getMode = permanentMode,
  getSettings = pilotSettings,
  isEnabled = crmSiteCreationEnabled,
  checkCapacity = createCrmFreeSiteCapacityHandler(),
  readAttempt = readCrmSiteAttempt,
} = {}) {
  return async function handler(request) {
    if (request.method !== "POST") return failed("Method not allowed", 405);
    if (!isStagingHost(request) || !requireSameOrigin(request)) {
      return failed("Staging only", 403);
    }
    if (getMode() !== "permanent") return failed("Secure staging portal unavailable", 503);
    let current;
    try { current = await getSession(request); }
    catch { return failed("Unable to check the account session", 503); }
    if (!current) return failed("Reconnect the staging Supabase account", 401);
    if (!constantTimeEqual(request.headers.get("x-csrf-token"), current.csrf_token)) {
      return failed("Session verification failed", 403);
    }
    if (!isPilotTarget(current, getSettings()) ||
        getSettings().ownerEmail !== CRM_SITE_OWNER_EMAIL) {
      return failed("The test owner is not authorized", 403);
    }
    let prior;
    try { prior = await readAttempt(current); }
    catch { return failed("The one-site ledger is not available", 503); }
    if (prior) {
      return safeStatusResponse({
        mode: "staging_one_crm_site_pilot",
        proposedSiteUrl: PILOT_CRM_SITE_URL,
        existingAttempt: publicCrmSiteAttempt(prior),
        creationUnlocked: false, creationLocked: true,
        siteCreated: prior.status === "created",
        writeAttempted: false, noSecondAttemptAllowed: true,
        note: "A site creation attempt is recorded. Automatic retries are permanently blocked.",
      });
    }
    let check;
    try {
      const response = await checkCapacity(request);
      if (!response?.ok) return failed("Recheck the test Free Plan and owner account");
      check = await response.json();
    } catch { return failed("The hosting limits could not be checked", 503); }
    if (!verifiedCrmSiteCapacity(check)) {
      return failed("The test team must remain on Free Plan with spare hosting capacity");
    }
    const unlocked = isEnabled();
    return safeStatusResponse({
      mode: "staging_one_crm_site_pilot",
      proposedSiteName: PILOT_CRM_SITE_NAME,
      proposedSiteUrl: PILOT_CRM_SITE_URL,
      netlifyAccount: CRM_SITE_OWNER_EMAIL,
      teamSlug: CRM_SITE_TEAM_SLUG,
      confirmedFreePlan: true, existingSites: check.sitesInTeam,
      ownerEmail: CRM_SITE_OWNER_EMAIL,
      existingAttempt: null,
      creditBalanceVerifiedByProvider: false,
      remainingCreditsOwnerReviewed: false,
      noPaidAddonsRequested: true,
      siteIsEmptyUntilDeployment: true,
      needsFinalConfirmation: true,
      confirmationPhrase: CRM_SITE_CONFIRMATION,
      creationUnlocked: unlocked,
      creationLocked: !unlocked,
      siteCreated: false, deployed: false,
      invitationSent: false, writeAttempted: false,
      note: unlocked
        ? "Creation is enabled only for one empty site in the verified test Free Plan team. Final typed consent and browser confirmation are still required."
        : "Real site creation is LOCKED until you separately approve enabling the staging feature. No website or login has been created.",
    });
  };
}
export default createCrmSiteApprovalHandler();
export const config = {
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 10 },
};

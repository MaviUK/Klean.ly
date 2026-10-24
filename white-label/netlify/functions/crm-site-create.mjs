import {
  constantTimeEqual, permanentMode, requireSameOrigin, safeStatusResponse,
} from "./_lib/connection-vault.mjs";
import { currentPortalSession } from "./_lib/connection-store.mjs";
import { isPilotTarget, isStagingHost, pilotSettings, readPilotRecord, PILOT_PROJECT_NAME, REF_PATTERN } from "./_lib/test-project-pilot.mjs";
import { readCrmSchemaAttempt } from "./_lib/crm-schema-pilot.mjs";
import {
  CRM_SITE_CONFIRMATION, CRM_SITE_OWNER_EMAIL, CRM_SITE_TEAM_SLUG,
  crmSiteCreationEnabled, readCrmSiteAttempt, reserveCrmSiteAttempt,
  markCrmSiteSubmitted, finishCrmSiteAttempt,
  createOneCrmNetlifySite, verifyCreatedCrmSite, CrmSitePilotError,
} from "./_lib/crm-site-pilot.mjs";
import {
  loadVerifiedNetlifyPilotGrant, inspectCrmNetlifySite,
  PILOT_CRM_SITE_NAME, PILOT_CRM_SITE_URL,
} from "./crm-site-proposal.mjs";
import { createCrmFreeSiteCapacityHandler } from "./crm-free-site-capacity.mjs";
import { verifiedCrmSiteCapacity } from "./crm-site-approval.mjs";

// This is the ONLY Netlify site-creation endpoint. OFF BY DEFAULT.
// The user must separately approve enabling the staging feature, then type
// the exact confirmation phrase and click through the browser's final alert.
// One audit ledger reservation BEFORE one external POST; NEVER retry.
const messages = Object.freeze({
  locked: "Website creation remains locked pending separate authorization.",
  denied: "This request is restricted to the approved staging test account.",
  disconnected: "Reconnect the approved Supabase and test Netlify accounts.",
  invalid_consent: "Confirm the Free Plan credits and type the exact website creation phrase.",
  not_ready: "The Free Plan, existing CRM database or test website name is not verified.",
  already_attempted: "A CRM website creation attempt is already recorded. Never retry automatically.",
  reservation_failed: "The permanent one-site reservation could not be recorded.",
  submission_not_locked: "The request was reserved but cannot be safely submitted. Do not retry.",
  permission_denied: "Netlify denied site creation. Do not retry automatically.",
  site_name_unavailable: "Netlify could not reserve that hostname. No automatic retry is allowed.",
  unknown: "Netlify's site creation result is uncertain. Do not retry. Check the test account.",
  verification_failed: "The created site could not be verified. Do not retry. Check Netlify.",
  manual_review: "The site creation status needs manual review. Do not send another request.",
});

function failed(code, status = 409, details = {}) {
  return safeStatusResponse({
    code, error: messages[code] || messages.manual_review,
    automaticRetryAllowed: false,
    siteCreationOutcome: code === "locked" || code === "invalid_consent"
      ? "not_started" : "unverified",
    ...details,
  }, status);
}

export async function validSiteConsent(request) {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
        !== "application/json") return false;
  let raw;
  try { raw = await request.text(); } catch { return false; }
  if (raw.length > 500) return false;
  let data;
  try { data = JSON.parse(raw); } catch { return false; }
  return data && typeof data === "object" && !Array.isArray(data) &&
    Object.keys(data).length === 3 &&
    Object.keys(data).every(key => [
      "confirmation", "acknowledgeFreeCredits", "acknowledgeSingleEmptySite"
    ].includes(key)) &&
    data.confirmation === CRM_SITE_CONFIRMATION &&
    data.acknowledgeFreeCredits === true &&
    data.acknowledgeSingleEmptySite === true;
}

export function createOneCrmSiteHandler({
  isEnabled = crmSiteCreationEnabled,
  getMode = permanentMode,
  getSession = currentPortalSession,
  getSettings = pilotSettings,
  checkCapacity = createCrmFreeSiteCapacityHandler(),
  getGrant = loadVerifiedNetlifyPilotGrant,
  inspectNetlify = inspectCrmNetlifySite,
  readAttempt = readCrmSiteAttempt,
  getProjectRecord = readPilotRecord,
  getSchemaAttempt = readCrmSchemaAttempt,
  reserve = reserveCrmSiteAttempt,
  lockSubmitted = markCrmSiteSubmitted,
  createSite = createOneCrmNetlifySite,
  verifySite = verifyCreatedCrmSite,
  finish = finishCrmSiteAttempt,
} = {}) {
  return async function handler(request) {
    if (request.method !== "POST") return failed("denied", 405);
    if (!isStagingHost(request) || !requireSameOrigin(request)) {
      return failed("denied", 403);
    }
    // Absolutely no provider access if the one-time site pilot is disabled.
    if (!isEnabled()) return failed("locked", 423);
    if (getMode() !== "permanent") return failed("disconnected", 503);
    let current;
    try { current = await getSession(request); }
    catch { return failed("disconnected", 503); }
    if (!current) return failed("disconnected", 401);
    if (!constantTimeEqual(request.headers.get("x-csrf-token"), current.csrf_token)) {
      return failed("denied", 403);
    }
    const settings = getSettings();
    if (!isPilotTarget(current, settings) ||
        settings.ownerEmail !== CRM_SITE_OWNER_EMAIL) {
      return failed("denied", 403);
    }

    if (!(await validSiteConsent(request))) return failed("invalid_consent", 400);

    // Authoritative readiness is reconstructed server-side from current
    // Supabase schema, Netlify account + Free Plan limits. No browser-supplied
    // site name, account slug, plan, user ID or cost data can select a target.
    let availability;
    try {
      const response = await checkCapacity(request);
      if (!response?.ok) return failed("not_ready");
      availability = await response.json();
    } catch { return failed("not_ready", 503); }
    if (!verifiedCrmSiteCapacity(availability)) return failed("not_ready");

    let prior, grant, inspected, team, projectRecord, schemaRecord;
    try {
      projectRecord = await getProjectRecord(current);
      schemaRecord = await getSchemaAttempt(current);
      if (projectRecord?.status !== "created" ||
          projectRecord?.project_name !== PILOT_PROJECT_NAME ||
          !REF_PATTERN.test(projectRecord.project_ref || "") ||
          schemaRecord?.status !== "applied" ||
          schemaRecord?.project_ref !== projectRecord.project_ref ||
          schemaRecord?.blueprint_version !== 1) return failed("not_ready");
      prior = await readAttempt(current);
      if (prior) return failed("already_attempted", 409, {
        existingAttempt: {status:prior.status},
      });
      grant = await getGrant(current);
      if (grant.netlifyAccountEmail !== CRM_SITE_OWNER_EMAIL ||
          typeof grant.netlifyUserId !== "string" ||
          !/^[\w:-]{1,128}$/.test(grant.netlifyUserId)) {
        return failed("denied", 403);
      }
      inspected = await inspectNetlify(grant.accessToken);
      team = inspected?.accounts?.filter(x =>
        x.slug === CRM_SITE_TEAM_SLUG && x.plan === "Free")[0];
      if (inspected.accounts.filter(x => x.slug === CRM_SITE_TEAM_SLUG).length !== 1 ||
          typeof team?.id !== "string" || !/^[\w:-]{1,128}$/.test(team.id) ||
          inspected.existingSitesVisibleToUser.length > 0) {
        return failed("not_ready");
      }
    } catch { return failed("disconnected", 503); }

    let reservation;
    try {
      reservation = await reserve(current, projectRecord.project_ref,
        grant.netlifyUserId, team.id);
    } catch { return failed("reservation_failed", 503); }
    if (!reservation?.reserved || !reservation.requestId) {
      return failed("already_attempted", 409);
    }

    let locked;
    try { locked = await lockSubmitted(current, reservation.requestId); }
    catch { return failed("submission_not_locked", 503); }
    if (!locked) return failed("submission_not_locked", 503);

    let site;
    try { site = await createSite(grant.accessToken, team.id); }
    catch (err) {
      const code = err instanceof CrmSitePilotError ? err.code : "provider_outcome_unknown";
      const status = code === "provider_permission_denied" ||
          code === "site_name_unavailable" ? "rejected" : "unknown";
      try {
        const saved = await finish(current, reservation.requestId, status, null, code);
        if (!saved) return failed("manual_review", 503);
      } catch { return failed("manual_review", 503); }
      return failed(code === "provider_permission_denied" ? "permission_denied" :
        code === "site_name_unavailable" ? "site_name_unavailable" : "unknown", 503);
    }

    let verified = false;
    try { verified = await verifySite(grant.accessToken, site.id, team.id); }
    catch { verified = false; }
    try {
      const saved = await finish(current, reservation.requestId,
        verified ? "created" : "unknown", verified ? site.id : null,
        verified ? null : "verification_unconfirmed");
      if (!saved) return failed("manual_review", 503);
    } catch { return failed("manual_review", 503); }
    if (!verified) return failed("verification_failed", 503);

    return safeStatusResponse({
      mode: "staging_one_crm_site_pilot",
      state: "crm_empty_site_created",
      siteCreated: true,
      siteId: site.id,
      siteName: PILOT_CRM_SITE_NAME,
      siteUrl: PILOT_CRM_SITE_URL,
      teamSlug: CRM_SITE_TEAM_SLUG,
      confirmedFreePlan: true,
      deployed: false, ownerCreated: false, invitationSent: false,
      noPaidAddonsRequested: true, automaticRetryAllowed: false,
      note: "One EMPTY site was created and verified in the test Netlify Free Plan team. No deploy, login, CRM app or paid add-on was requested.",
    }, 201);
  };
}
export default createOneCrmSiteHandler();
export const config = {
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 5 },
};

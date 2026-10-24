import {
  constantTimeEqual, permanentMode, requireSameOrigin, safeStatusResponse,
} from "./_lib/connection-vault.mjs";
import { currentPortalSession } from "./_lib/connection-store.mjs";
import { loadFreshPilotGrant } from "./_lib/fresh-pilot-grant.mjs";
import {
  isPilotTarget, isStagingHost, pilotSettings,
  REF_PATTERN, PILOT_PROJECT_NAME,
} from "./_lib/test-project-pilot.mjs";
import { CRM_SITE_OWNER_EMAIL } from "./_lib/crm-site-pilot.mjs";
import { PILOT_CRM_SITE_URL } from "./crm-site-proposal.mjs";
import { createOwnerLoginReadinessHandler } from "./owner-login-readiness.mjs";
import { createCrmDeploymentReadinessHandler } from "./crm-deployment-readiness.mjs";

// Staging-only, read-only inspection before any owner invitation is developed.
// Only the existing test project/site may be checked. This endpoint never
// calls Supabase Auth Admin, sends invitations or modifies a redirect URL.
// Supabase GET /v1/projects/{ref}/config/auth may include server secrets:
// intentionally discard EVERYTHING except 4 public configuration indicators.
export const OWNER_AUTH_REDIRECT = PILOT_CRM_SITE_URL + "/auth/callback";
export const AUTH_MANAGEMENT_API = "https://api.supabase.com/v1/projects/";

function exactTargetUrl(value, target) {
  if (typeof value !== "string" || value.length > 500) return false;
  // No wildcards, alternate hosts, schemes, query strings, URL fragments or
  // lookalike hostnames. A trailing slash on the SITE URL is acceptable.
  return value.trim() === target || value.trim() === target + "/";
}

export function summariseOwnerAuthConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      typeof config.site_url !== "string" ||
      typeof config.disable_signup !== "boolean" ||
      typeof config.external_email_enabled !== "boolean" ||
      (config.uri_allow_list !== undefined &&
       config.uri_allow_list !== null &&
       typeof config.uri_allow_list !== "string")) {
    throw new Error("invalid_auth_settings");
  }
  const redirects = (config.uri_allow_list || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const callbackAllowlisted = redirects.some(item =>
    item === OWNER_AUTH_REDIRECT
  );
  const siteUrlCorrect = exactTargetUrl(config.site_url, PILOT_CRM_SITE_URL);
  const emailProviderEnabled = config.external_email_enabled;
  const publicSignupsDisabled = config.disable_signup;
  return {
    // No raw provider settings, secrets, SMTP credentials, or other URLs leave
    // the function. In particular, never expose the full Management API body.
    siteUrlCorrect,
    callbackAllowlisted,
    emailProviderEnabled,
    publicSignupsDisabled,
    authSettingsReadyForLaterReview:
      siteUrlCorrect && callbackAllowlisted && emailProviderEnabled &&
      publicSignupsDisabled,
  };
}

export async function inspectOwnerAuthConfig(ref, token, fetchFn = fetch) {
  if (!REF_PATTERN.test(ref || "") ||
      typeof token !== "string" || token.length < 8 || token.length > 8192) {
    throw new Error("invalid_test_auth_target");
  }
  const response = await fetchFn(AUTH_MANAGEMENT_API + ref + "/config/auth", {
    method: "GET",
    headers: {
      Authorization: "Bearer " + token, Accept: "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 401 || response.status === 403) {
    return { permitted: false, reason: "auth_read_permission_required" };
  }
  if (!response.ok) throw new Error("auth_settings_unavailable");
  return { permitted: true, ...summariseOwnerAuthConfig(await response.json()) };
}

function failure(message, status = 409) {
  return safeStatusResponse({
    mode: "read_only_crm_owner_auth_setup",
    error: message,
    invitationEnabled: false,
    ownerCreated: false,
    emailSent: false,
    databaseModified: false,
    websiteModified: false,
    writeAttempted: false,
  }, status);
}

export function createOwnerAuthSetupReviewHandler({
  getMode = permanentMode,
  getSession = currentPortalSession,
  getSettings = pilotSettings,
  reviewOwner = createOwnerLoginReadinessHandler(),
  reviewDeployment = createCrmDeploymentReadinessHandler(),
  getGrant = loadFreshPilotGrant,
  checkAuthConfig = inspectOwnerAuthConfig,
} = {}) {
  return async function handler(request) {
    if (request.method !== "POST") return failure("Method not allowed", 405);
    if (!requireSameOrigin(request) || !isStagingHost(request)) {
      return failure("Staging access only", 403);
    }
    if (getMode() !== "permanent") {
      return failure("Secure staging portal unavailable", 503);
    }
    let current;
    try { current = await getSession(request); }
    catch { return failure("Unable to verify the staging session", 503); }
    if (!current) return failure("Reconnect the test account", 401);
    if (!constantTimeEqual(request.headers.get("x-csrf-token"), current.csrf_token)) {
      return failure("Session verification failed", 403);
    }
    const settings = getSettings();
    if (!isPilotTarget(current, settings) ||
        settings.ownerEmail !== CRM_SITE_OWNER_EMAIL) {
      return failure("Only the approved test owner may review this login", 403);
    }

    // Each independent, already tested handler verifies the same session,
    // Supabase project ledger/CRM schema or Netlify site creation ledger.
    // Both are read-only and both must agree on the test installation.
    let owner, deployment;
    try {
      const results = await Promise.all([
        reviewOwner(request), reviewDeployment(request),
      ]);
      if (results.some(r => !r?.ok)) {
        return failure("Recheck the owner records and deployment readiness first");
      }
      [owner, deployment] = await Promise.all(results.map(r => r.json()));
    } catch {
      return failure("The existing CRM owner or website review was unavailable", 503);
    }
    if (owner?.mode !== "staging_owner_login_readiness" ||
        owner?.projectVerified !== true ||
        owner?.projectName !== PILOT_PROJECT_NAME ||
        !REF_PATTERN.test(owner?.projectRef || "") ||
        owner?.region !== "eu-central-1" ||
        owner?.schemaVerified !== true ||
        owner?.eightTablesConfirmed !== true ||
        owner?.eightRlsConfirmed !== true ||
        owner?.ownerCreated !== false ||
        owner?.emailSent !== false ||
        owner?.ownerInvitationEnabled !== false ||
        owner?.writeAttempted !== false ||
        deployment?.mode !== "read_only_crm_deployment_readiness" ||
        deployment?.siteVerified !== true ||
        deployment?.siteUrl !== PILOT_CRM_SITE_URL ||
        deployment?.installedCrmSchema !== true ||
        deployment?.teamSlug !== "kleanlytest" ||
        deployment?.deploymentAttempted !== false ||
        deployment?.appDeployed !== false ||
        deployment?.websiteModified !== false ||
        deployment?.ownerCreated !== false ||
        deployment?.emailSent !== false) {
      return failure("The dedicated CRM database or website does not match the pilot");
    }
    // No initial owner may be invited over the top of existing staff.
    if (owner.ownerConfigured !== false || owner.staffConfigured !== false ||
        owner.state !== "owner_setup_can_be_prepared" ||
        owner.readyForInvitationDevelopment !== true) {
      return safeStatusResponse({
        mode: "read_only_crm_owner_auth_setup",
        state: "existing_owner_review_required",
        projectVerified: true, websiteVerified: true,
        ownerEmail: CRM_SITE_OWNER_EMAIL, proposedLoginUrl: PILOT_CRM_SITE_URL,
        requiredCallbackUrl: OWNER_AUTH_REDIRECT,
        invitationEnabled: false, ownerCreated: false, emailSent: false,
        databaseModified: false, websiteModified: false, writeAttempted: false,
        note: "An owner or staff record already exists. Do not send a new first-owner invitation.",
      });
    }
    if (deployment.state !== "empty_site_verified" ||
        deployment.siteHasExistingDeployment !== false ||
        deployment.gitRepositoryLinked !== false ||
        deployment.confirmedFreePlan !== true ||
        deployment.readyToPrepareCrmPackage !== true) {
      return safeStatusResponse({
        mode: "read_only_crm_owner_auth_setup",
        state: "website_needs_review",
        projectVerified: true, websiteVerified: true,
        ownerEmail: CRM_SITE_OWNER_EMAIL, proposedLoginUrl: PILOT_CRM_SITE_URL,
        requiredCallbackUrl: OWNER_AUTH_REDIRECT,
        invitationEnabled: false, ownerCreated: false, emailSent: false,
        databaseModified: false, websiteModified: false, writeAttempted: false,
        note: "The Netlify website has changed; review its deployment before configuring owner login.",
      });
    }

    let auth;
    try {
      const token = await getGrant(current);
      auth = await checkAuthConfig(owner.projectRef, token);
    } catch {
      return failure("Supabase Auth configuration could not be checked", 503);
    }
    if (auth?.permitted === false) {
      return safeStatusResponse({
        mode: "read_only_crm_owner_auth_setup",
        state: "auth_read_permission_required",
        projectVerified: true, websiteVerified: true,
        ownerEmail: CRM_SITE_OWNER_EMAIL, proposedLoginUrl: PILOT_CRM_SITE_URL,
        requiredCallbackUrl: OWNER_AUTH_REDIRECT,
        authSettingsRead: false,
        invitationEnabled: false, ownerCreated: false, emailSent: false,
        databaseModified: false, websiteModified: false, writeAttempted: false,
        note: "The test OAuth grant needs Supabase auth:read access before its Auth settings can be reviewed. No changes were made.",
      });
    }
    if (!auth || auth.permitted !== true ||
        typeof auth.siteUrlCorrect !== "boolean" ||
        typeof auth.callbackAllowlisted !== "boolean" ||
        typeof auth.emailProviderEnabled !== "boolean" ||
        typeof auth.publicSignupsDisabled !== "boolean" ||
        typeof auth.authSettingsReadyForLaterReview !== "boolean" ||
        auth.authSettingsReadyForLaterReview !== (
          auth.siteUrlCorrect && auth.callbackAllowlisted &&
          auth.emailProviderEnabled && auth.publicSignupsDisabled
        )) {
      return failure("Supabase Auth settings returned incomplete verification");
    }
    return safeStatusResponse({
      mode: "read_only_crm_owner_auth_setup",
      state: auth.authSettingsReadyForLaterReview
        ? "auth_settings_checked_waiting_for_crm_deploy"
        : "auth_url_configuration_needed",
      ownerEmail: CRM_SITE_OWNER_EMAIL,
      proposedLoginUrl: PILOT_CRM_SITE_URL,
      requiredCallbackUrl: OWNER_AUTH_REDIRECT,
      projectName: PILOT_PROJECT_NAME,
      projectVerified: true,
      websiteVerified: true,
      authSettingsRead: true,
      siteUrlCorrect: auth.siteUrlCorrect,
      callbackAllowlisted: auth.callbackAllowlisted,
      emailProviderEnabled: auth.emailProviderEnabled,
      publicSignupsDisabled: auth.publicSignupsDisabled,
      crmAppDeployed: false,
      invitationEnabled: false,
      ownerCreated: false, emailSent: false,
      databaseModified: false, websiteModified: false, writeAttempted: false,
      note: auth.authSettingsReadyForLaterReview
        ? "Read-only: Auth URL settings are aligned, but the CRM app and callback are not deployed yet. Do not send an invitation until they are installed and security-tested."
        : "Read-only: review the dedicated Supabase Auth Site URL, exact callback allowlist, email provider and signup restrictions before any first-owner invitation. The CRM app is also not deployed.",
    });
  };
}
export default createOwnerAuthSetupReviewHandler();
export const config = {
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 10 },
};

import {
  constantTimeEqual, permanentMode, requireSameOrigin, safeStatusResponse,
} from "./_lib/connection-vault.mjs";
import { currentPortalSession } from "./_lib/connection-store.mjs";
import {
  isPilotTarget, isStagingHost, pilotSettings,
  readPilotRecord, PILOT_PROJECT_NAME, REF_PATTERN,
} from "./_lib/test-project-pilot.mjs";
import { readCrmSchemaAttempt } from "./_lib/crm-schema-pilot.mjs";
import {
  readCrmSiteAttempt, NETLIFY_SITE_ID_PATTERN,
  CRM_SITE_OWNER_EMAIL, CRM_SITE_TEAM_SLUG,
} from "./_lib/crm-site-pilot.mjs";
import {
  NETLIFY_API, PILOT_CRM_SITE_NAME, PILOT_CRM_SITE_URL,
  loadVerifiedNetlifyPilotGrant,
} from "./crm-site-proposal.mjs";

// Step 191: staging-only, read-only inspection of the ONE previously created
// CRM hosting site. No upload, deployment, app files, or authentication setup
// is attempted. This must not use the operator's/live-directory Netlify account.

function validId(value) {
  return typeof value === "string" && /^[\w:-]{1,128}$/.test(value);
}

export function verifyCrmDeployLedgers(current, site, project, schema) {
  return !!(
    site?.status === "created" &&
    site?.site_name === PILOT_CRM_SITE_NAME &&
    NETLIFY_SITE_ID_PATTERN.test(site?.site_id || "") &&
    site?.netlify_team_slug === CRM_SITE_TEAM_SLUG &&
    validId(site?.netlify_team_id) &&
    validId(site?.netlify_user_id) &&
    site?.user_id === current?.user_id &&
    site?.organization_id === current?.organization_id &&
    REF_PATTERN.test(site?.supabase_project_ref || "") &&
    project?.status === "created" &&
    project?.project_name === PILOT_PROJECT_NAME &&
    project?.project_ref === site.supabase_project_ref &&
    schema?.status === "applied" &&
    schema?.project_ref === site.supabase_project_ref &&
    schema?.blueprint_version === 1
  );
}

async function netlifyRead(url, token, fetchFn) {
  const response = await fetchFn(url, {
    method: "GET",
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(response.status === 401 || response.status === 403
      ? "connected_netlify_permissions_required"
      : "netlify_read_only_check_unavailable");
  }
  return response.json();
}

export function interpretCrmDeploymentState(site, team, deploys, ledger) {
  if (!team || team.id !== ledger.netlify_team_id ||
      team.slug !== CRM_SITE_TEAM_SLUG ||
      typeof team.type_name !== "string") {
    throw new Error("wrong_netlify_team");
  }
  if (!site || site.id !== ledger.site_id ||
      site.name !== PILOT_CRM_SITE_NAME ||
      site.account_id !== ledger.netlify_team_id ||
      (site.account_slug !== undefined &&
       site.account_slug !== CRM_SITE_TEAM_SLUG) ||
      (site.custom_domain != null && site.custom_domain !== "")) {
    throw new Error("wrong_netlify_site");
  }
  if (!Array.isArray(deploys) || deploys.length > 1 ||
      deploys.some(d => !d || typeof d.id !== "string")) {
    throw new Error("unexpected_netlify_deploy_history");
  }
  const linkedRepo = Boolean(
    site.repo ||
    site.build_settings?.repo_url ||
    site.build_settings?.repo_path ||
    site.build_settings?.provider ||
    site.repo_url
  );
  const hasDeploy = deploys.length !== 0 ||
    Boolean(site.published_deploy || site.published_deploy_id ||
      site.deploy_id);
  const free = team.type_name === "Free";
  return {
    confirmedFreePlan: free,
    hasExistingDeploy: hasDeploy,
    linkedRepository: linkedRepo,
    siteEmpty: !hasDeploy,
    readyToPrepareCrmPackage: free && !hasDeploy && !linkedRepo,
    state: !free ? "plan_review_required" :
      linkedRepo ? "repository_review_required" :
      hasDeploy ? "existing_deployment_review_required" :
      "empty_site_verified",
  };
}

export async function inspectCrmDeploymentTarget(accessToken, siteLedger, fetchFn = fetch) {
  if (typeof accessToken !== "string" ||
      accessToken.length < 8 || accessToken.length > 8192 ||
      !NETLIFY_SITE_ID_PATTERN.test(siteLedger?.site_id || "") ||
      !validId(siteLedger?.netlify_team_id) ||
      siteLedger.netlify_team_slug !== CRM_SITE_TEAM_SLUG) {
    throw new Error("invalid_test_netlify_target");
  }
  const base = NETLIFY_API;
  // All requests are GETs with the separately connected customer grant.
  // A published or draft deploy stops the blank-site plan rather than being overwritten.
  const team = await netlifyRead(
    base + "/accounts/" + encodeURIComponent(siteLedger.netlify_team_id),
    accessToken, fetchFn
  );
  const site = await netlifyRead(
    base + "/sites/" + siteLedger.site_id,
    accessToken, fetchFn
  );
  const deploys = await netlifyRead(
    base + "/sites/" + siteLedger.site_id + "/deploys?per_page=1",
    accessToken, fetchFn
  );
  return interpretCrmDeploymentState(site, team, deploys, siteLedger);
}

function failure(message, status = 409) {
  return safeStatusResponse({
    mode: "read_only_crm_deployment_readiness",
    error: message, deploymentEnabled: false,
    deploymentAttempted: false, websiteModified: false,
    appDeployed: false, ownerCreated: false, emailSent: false,
  }, status);
}

export function createCrmDeploymentReadinessHandler({
  getMode = permanentMode,
  getSession = currentPortalSession,
  getSettings = pilotSettings,
  getSiteLedger = readCrmSiteAttempt,
  getProjectLedger = readPilotRecord,
  getSchemaLedger = readCrmSchemaAttempt,
  getNetlifyGrant = loadVerifiedNetlifyPilotGrant,
  inspectTarget = inspectCrmDeploymentTarget,
} = {}) {
  return async function handler(request) {
    if (request.method !== "POST") return failure("Method not allowed", 405);
    if (!isStagingHost(request) || !requireSameOrigin(request)) {
      return failure("Staging only", 403);
    }
    if (getMode() !== "permanent") {
      return failure("The staging installer is unavailable", 503);
    }
    let current;
    try { current = await getSession(request); }
    catch { return failure("Could not verify the secure session", 503); }
    if (!current) return failure("Reconnect your staging test account", 401);
    if (!constantTimeEqual(request.headers.get("x-csrf-token"), current.csrf_token)) {
      return failure("Session verification failed", 403);
    }
    const settings = getSettings();
    if (!isPilotTarget(current, settings) ||
        settings.ownerEmail !== CRM_SITE_OWNER_EMAIL) {
      return failure("Not authorised for the staging CRM pilot", 403);
    }

    let siteRecord, projectRecord, schemaRecord;
    try {
      siteRecord = await getSiteLedger(current);
      projectRecord = await getProjectLedger(current);
      schemaRecord = await getSchemaLedger(current);
    } catch {
      return failure("The original installation records could not be verified", 503);
    }
    if (!verifyCrmDeployLedgers(current, siteRecord, projectRecord, schemaRecord)) {
      return failure("A completed, matching test website and CRM database are required");
    }

    let grant, details;
    try {
      grant = await getNetlifyGrant(current);
      if (grant?.netlifyAccountEmail !== CRM_SITE_OWNER_EMAIL ||
          grant?.netlifyUserId !== siteRecord.netlify_user_id) {
        return failure("The connected Netlify test owner has changed", 403);
      }
      details = await inspectTarget(grant.accessToken, siteRecord);
    } catch {
      return failure("Netlify could not verify the dedicated test website", 503);
    }
    if (!details || typeof details.confirmedFreePlan !== "boolean" ||
        typeof details.hasExistingDeploy !== "boolean" ||
        typeof details.linkedRepository !== "boolean" ||
        typeof details.readyToPrepareCrmPackage !== "boolean" ||
        typeof details.state !== "string" ||
        details.readyToPrepareCrmPackage !== (
          details.confirmedFreePlan && !details.hasExistingDeploy &&
          !details.linkedRepository)) {
      return failure("Netlify returned incomplete deployment information", 503);
    }

    return safeStatusResponse({
      mode: "read_only_crm_deployment_readiness",
      state: details.state,
      siteVerified: true,
      siteName: PILOT_CRM_SITE_NAME,
      siteUrl: PILOT_CRM_SITE_URL,
      teamSlug: CRM_SITE_TEAM_SLUG,
      confirmedFreePlan: details.confirmedFreePlan,
      installedCrmSchema: true,
      siteHasExistingDeployment: details.hasExistingDeploy,
      gitRepositoryLinked: details.linkedRepository,
      readyToPrepareCrmPackage: details.readyToPrepareCrmPackage,
      crmAppPackageReady: false,
      deploymentEnabled: false,
      deploymentAttempted: false,
      websiteModified: false,
      appDeployed: false,
      ownerCreated: false, emailSent: false,
      note: details.readyToPrepareCrmPackage
        ? "The separate CRM test website is empty, has no Git repository and belongs to the connected Free Plan team. Next build the actual CRM application package, verify client/server credential separation, then request separate permission before deploying it."
        : "The test website requires manual review before any application files are deployed. No changes were made.",
    });
  };
}

export default createCrmDeploymentReadinessHandler();
export const config = {
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 10 },
};

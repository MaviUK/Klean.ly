import {
  constantTimeEqual, permanentMode, requireSameOrigin, safeStatusResponse,
} from "./_lib/connection-vault.mjs";
import { currentPortalSession } from "./_lib/connection-store.mjs";
import {
  PILOT_PROJECT_NAME, pilotSettings, isPilotTarget, isStagingHost, readPilotRecord,
} from "./_lib/test-project-pilot.mjs";
import {
  CRM_INSTALL_CONFIRMATION, schemaInstallEnabled,
  readCrmSchemaAttempt, publicCrmSchemaAttempt,
} from "./_lib/crm-schema-pilot.mjs";
import { createCrmDatabaseReviewHandler } from "./crm-database-review.mjs";
import { verifiedForSchemaProposal, CRM_BLUEPRINT_TABLES } from "./crm-schema-proposal.mjs";

// A separate proposal for a ONE-TIME staging schema installation.
// It never calls the Supabase write endpoint. The real operation requires
// a distinct typed confirmation, server-side feature flag and irreversible
// one-attempt ledger reservation.
function failure(message, status = 409) {
  return safeStatusResponse({
    mode: "staging_crm_schema_pilot",
    installationUnlocked: false,
    schemaInstalled: false, writeAttempted: false,
    error: message,
  }, status);
}

export function createCrmSchemaApprovalHandler({
  getSession = currentPortalSession,
  getMode = permanentMode,
  getSettings = pilotSettings,
  isEnabled = schemaInstallEnabled,
  getProjectRecord = readPilotRecord,
  getSchemaAttempt = readCrmSchemaAttempt,
  reviewDatabase = createCrmDatabaseReviewHandler(),
} = {}) {
  return async function handler(request) {
    if (request.method !== "POST") return failure("Method not allowed", 405);
    if (!requireSameOrigin(request) || !isStagingHost(request)) {
      return failure("Staging only", 403);
    }
    if (getMode() !== "permanent") return failure("Secure test portal unavailable", 503);

    let current;
    try { current = await getSession(request); }
    catch { return failure("Secure account session could not be checked", 503); }
    if (!current) return failure("Reconnect your test Supabase account", 401);
    if (!constantTimeEqual(request.headers.get("x-csrf-token"), current.csrf_token)) {
      return failure("Session verification failed", 403);
    }
    if (!isPilotTarget(current, getSettings())) {
      return failure("Only the verified staging pilot owner can review installation", 403);
    }

    let project, attempt;
    try {
      project = await getProjectRecord(current);
      attempt = await getSchemaAttempt(current);
    } catch {
      return failure("Secure one-time installation records are unavailable", 503);
    }
    if (project?.status !== "created" || project?.project_name !== PILOT_PROJECT_NAME ||
        typeof project?.project_ref !== "string" ||
        !/^[a-z0-9]{20}$/i.test(project.project_ref)) {
      return failure("The original approved staging project was not verified");
    }

    // An attempt survives account disconnection: never offer another apply.
    if (attempt) {
      return safeStatusResponse({
        mode: "staging_crm_schema_pilot",
        projectName: PILOT_PROJECT_NAME, projectRef: project.project_ref,
        existingAttempt: publicCrmSchemaAttempt(attempt),
        installationUnlocked: false, installationLocked: true,
        schemaInstalled: attempt.status === "applied",
        writeAttempted: false,
        noSecondAttemptAllowed: true,
        note: "A CRM schema installation attempt is already recorded. Never repeat an uncertain result.",
      });
    }

    let report;
    try {
      const response = await reviewDatabase(request);
      if (!response?.ok) return failure("Recheck the test CRM database before approval");
      report = await response.json();
    } catch {
      return failure("Database readiness could not be checked", 503);
    }
    if (!verifiedForSchemaProposal(report) ||
        report.projectRef !== project.project_ref ||
        report.region !== "eu-central-1") {
      return failure("The test project must be healthy, empty and verified in Frankfurt before approval");
    }

    const enabled = isEnabled();
    return safeStatusResponse({
      mode: "staging_crm_schema_pilot",
      projectName: PILOT_PROJECT_NAME,
      projectRef: project.project_ref,
      region: report.region,
      blueprintVersion: 1,
      publicTables: CRM_BLUEPRINT_TABLES,
      installedTables: 0,
      ownerAccountIncluded: false,
      paidAddonsRequested: false,
      existingAttempt: null,
      installationUnlocked: enabled,
      installationLocked: !enabled,
      needsSeparateConfirmation: true,
      confirmationPhrase: CRM_INSTALL_CONFIRMATION,
      schemaInstalled: false,
      writeAttempted: false,
      note: enabled
        ? "The one-shot staging schema pilot is unlocked. A typed acknowledgement and browser confirmation are still required."
        : "The one-shot CRM schema installation is LOCKED until you explicitly approve enabling this staging pilot.",
    });
  };
}

export default createCrmSchemaApprovalHandler();

export const config = {
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 10 },
};

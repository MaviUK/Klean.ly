import {
  constantTimeEqual, permanentMode, requireSameOrigin, safeStatusResponse,
} from "./_lib/connection-vault.mjs";
import { currentPortalSession } from "./_lib/connection-store.mjs";
import {
  pilotSettings, isPilotTarget, isStagingHost, readPilotRecord, loadVerifiedGrant,
  PILOT_PROJECT_NAME,
} from "./_lib/test-project-pilot.mjs";
import {
  CRM_INSTALL_CONFIRMATION, schemaInstallEnabled,
  readCrmSchemaAttempt, reserveCrmSchemaAttempt, markCrmSchemaSubmitted,
  finishCrmSchemaAttempt, applyCrmFoundationSql, verifyCrmSchemaApplied,
  CrmSchemaPilotError,
} from "./_lib/crm-schema-pilot.mjs";
import { createCrmDatabaseReviewHandler } from "./crm-database-review.mjs";
import { verifiedForSchemaProposal } from "./crm-schema-proposal.mjs";

// No write happens without a separate, explicit owner-confirmed browser POST.
// The env gate remains OFF by default, and MUST stay off until the user
// authorizes this particular real CRM schema installation.
const messages = Object.freeze({
  feature_locked: "CRM schema installation is locked pending your explicit approval.",
  not_allowed: "This test is restricted to the approved staging owner and project.",
  not_connected: "Reconnect the authorised test Supabase account.",
  invalid_approval: "Type the exact confirmation phrase and acknowledge the schema changes.",
  not_ready: "The test project must be healthy and empty before installation.",
  already_attempted: "One CRM schema install attempt already exists. No second request was sent.",
  reservation_failed: "The one-time installation reservation could not be stored.",
  submission_not_locked: "The installation attempt is reserved. Do not retry automatically.",
  permission_denied: "Supabase denied schema changes with the connected permissions. Do not retry automatically.",
  provider_unknown: "Supabase's response is uncertain. Do not retry. Review the project dashboard.",
  manual_review: "Installation status could not be verified safely. Do not retry automatically.",
  unexpected: "CRM installation stopped. No further request will be sent automatically.",
});

function failure(code, status = 409, extra = {}) {
  return safeStatusResponse({
    error: messages[code] || messages.unexpected, code,
    automaticRetryAllowed: false,
    schemaInstalled: false,
    ...extra,
  }, status);
}

async function validApproval(request) {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return false;
  }
  const raw = await request.text();
  if (raw.length > 500) return false;
  let data;
  try { data = JSON.parse(raw); } catch { return false; }
  return data && typeof data === "object" && !Array.isArray(data) &&
    Object.keys(data).length === 2 &&
    Object.keys(data).every(k => ["confirmation","acknowledgeSchemaChanges"].includes(k)) &&
    data.confirmation === CRM_INSTALL_CONFIRMATION &&
    data.acknowledgeSchemaChanges === true;
}

export function createCrmSchemaInstallHandler({
  getMode = permanentMode,
  isEnabled = schemaInstallEnabled,
  getSettings = pilotSettings,
  getSession = currentPortalSession,
  reviewDatabase = createCrmDatabaseReviewHandler(),
  getProjectRecord = readPilotRecord,
  getSchemaAttempt = readCrmSchemaAttempt,
  getGrant = loadVerifiedGrant,
  reserve = reserveCrmSchemaAttempt,
  lockSubmission = markCrmSchemaSubmitted,
  applySql = applyCrmFoundationSql,
  verifySql = verifyCrmSchemaApplied,
  finish = finishCrmSchemaAttempt,
} = {}) {
  return async function handler(request) {
    if (request.method !== "POST") return failure("not_allowed", 405);
    if (!requireSameOrigin(request) || !isStagingHost(request)) {
      return failure("not_allowed", 403);
    }
    // OFF by default, checked BEFORE reading provider grants or DB ledgers.
    if (!isEnabled()) return failure("feature_locked", 423);
    if (getMode() !== "permanent") return failure("not_connected", 503);

    let current;
    try { current = await getSession(request); }
    catch { return failure("not_connected", 503); }
    if (!current) return failure("not_connected", 401);
    if (!constantTimeEqual(request.headers.get("x-csrf-token"), current.csrf_token)) {
      return failure("not_connected", 403);
    }
    if (!isPilotTarget(current, getSettings())) return failure("not_allowed", 403);

    try {
      if (!(await validApproval(request))) return failure("invalid_approval", 400);
    } catch {
      return failure("invalid_approval", 400);
    }

    // Re-check provider permissions, project identity, regional location and
    // the absence of any directory or CRM tables IMMEDIATELY before reserving.
    let report;
    try {
      const response = await reviewDatabase(request);
      if (!response?.ok) return failure("not_ready");
      report = await response.json();
    } catch {
      return failure("not_ready", 503);
    }
    if (!verifiedForSchemaProposal(report) || report.region !== "eu-central-1") {
      return failure("not_ready");
    }

    let project, attempt, token;
    try {
      project = await getProjectRecord(current);
      if (project?.status !== "created" ||
          project?.project_name !== PILOT_PROJECT_NAME ||
          project?.project_ref !== report.projectRef) return failure("not_ready");
      attempt = await getSchemaAttempt(current);
      if (attempt) return failure("already_attempted", 409, {
        existingAttempt: { status: attempt.status, projectRef: attempt.project_ref },
      });
      token = await getGrant(current);
    } catch {
      return failure("not_connected", 503);
    }

    let reservation;
    try { reservation = await reserve(current, project.project_ref); }
    catch { return failure("reservation_failed", 503); }
    if (!reservation?.reserved || !reservation?.requestId) {
      return failure("already_attempted", 409);
    }

    let locked;
    try {
      locked = await lockSubmission(current, project.project_ref, reservation.requestId);
    } catch {
      return failure("submission_not_locked", 503);
    }
    if (!locked) return failure("submission_not_locked", 503);

    // Exactly ONE Supabase schema write request. A timeout or any uncertainty
    // permanently blocks automated retry even if tables appear incomplete.
    try {
      await applySql(project.project_ref, token);
    } catch (error) {
      const definitePermissionDenial =
        error instanceof CrmSchemaPilotError && error.code === "provider_permission_denied";
      try {
        const saved = await finish(current, project.project_ref, reservation.requestId,
          definitePermissionDenial ? "rejected" : "unknown",
          definitePermissionDenial ? "permission_denied" : "provider_unknown");
        if (!saved) return failure("manual_review", 503);
      } catch {
        return failure("manual_review", 503);
      }
      return failure(definitePermissionDenial ? "permission_denied" : "provider_unknown", 503);
    }

    // Successful HTTP response does NOT by itself prove all RLS is active.
    let verified = false;
    try { verified = await verifySql(project.project_ref, token); }
    catch { verified = false; }
    try {
      const saved = await finish(current, project.project_ref, reservation.requestId,
        verified ? "applied" : "unknown",
        verified ? null : "verification_inconclusive");
      if (!saved) return failure("manual_review", 503);
    } catch {
      return failure("manual_review", 503);
    }
    if (!verified) return failure("manual_review", 503, { outcome: "unverified" });

    return safeStatusResponse({
      state: "crm_schema_applied",
      schemaInstalled: true,
      projectName: PILOT_PROJECT_NAME, projectRef: project.project_ref,
      blueprintVersion: 1,
      publicTableCount: 8,
      rowLevelSecurityVerified: true,
      websiteCreated: false, ownerCreated: false,
      autoRepeatAllowed: false,
      note: "Only the schema was installed. Owner authentication and the CRM web application are separate future steps.",
    }, 201);
  };
}

export default createCrmSchemaInstallHandler();

export const config = {
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 5 },
};

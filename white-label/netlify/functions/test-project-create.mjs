import {
  constantTimeEqual, permanentMode, requireSameOrigin, safeStatusResponse,
  vaultKey,
} from "./_lib/connection-vault.mjs";
import { currentPortalSession, getPortalDatabase } from "./_lib/connection-store.mjs";
import { createFreeProjectCapacityHandler } from "./free-project-capacity.mjs";
import {
  PILOT_CONFIRMATION, pilotSettings, isPilotTarget, isStagingHost,
  eligibleForPilot, readPilotRecord, publicPilotRecord,
  loadVerifiedGrant, reservePilotProject, markPilotSubmitted,
  markPilotCompleted, submitPilotProject, TestProjectError,
} from "./_lib/test-project-pilot.mjs";

// This is a deliberately locked ONE-SHOT pilot. It has NO publicly usable
// write ability until staging Functions env includes
// KLEANLY_TEST_PROJECT_CREATION_ENABLED=true, and even then demands an
// allowlisted test owner, CSRF, validated Free Plan, exactly one observed
// existing project, an atomic reservation and explicit typed confirmation.
const errors = Object.freeze({
  pilot_locked: "Test project creation is locked until you explicitly approve the pilot.",
  pilot_owner_not_allowed: "Only the connected staging test owner may create the test project.",
  invalid_confirmation: "Type the exact confirmation phrase and acknowledge the provider limits.",
  no_free_capacity: "Supabase cannot confirm the required Free Plan conditions for this test.",
  already_reserved: "A test project attempt is already recorded. No second request was sent.",
  secure_storage_unavailable: "Secure staging credential storage is unavailable.",
  connection_unavailable: "Supabase authorisation needs to be checked or reconnected.",
  reservation_unavailable: "A unique project reservation could not be saved.",
  submission_not_locked: "The project reservation is locked for manual review.",
  provider_permission_denied: "Supabase refused project creation with the current permissions.",
  provider_quota_or_billing: "Supabase declined the test project because of quota or billing restrictions.",
  provider_result_unknown: "Supabase's response was inconclusive. Do NOT retry automatically; verify the project list manually.",
  provider_response_unverified: "Supabase may have created the project, but its reference was not confirmed. Manual verification is required.",
  manual_review: "Provider state could not be saved; do not retry. Inspect Supabase before proceeding.",
  unexpected_error: "Test project creation was stopped. No additional request will be sent.",
});

function failed(code, status = 409, extra = {}) {
  return safeStatusResponse({
    error: errors[code] || errors.unexpected_error,
    code, automaticRetryAllowed: false,
    ...extra,
  }, status);
}

async function parseApproval(request) {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") {
    throw new TestProjectError("invalid_confirmation", 400);
  }
  const body = await request.text();
  if (body.length > 500) throw new TestProjectError("invalid_confirmation", 400);
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new TestProjectError("invalid_confirmation", 400);
  }
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      Object.keys(data).length !== 2 ||
      !Object.keys(data).every((name) =>
        ["confirmation", "acknowledgeProviderCharges"].includes(name)) ||
      data.confirmation !== PILOT_CONFIRMATION ||
      data.acknowledgeProviderCharges !== true) {
    throw new TestProjectError("invalid_confirmation", 400);
  }
}

export function createOneTestProjectHandler({
  getSession = currentPortalSession,
  getSettings = pilotSettings,
  checkCapacity = createFreeProjectCapacityHandler(),
  getDb = getPortalDatabase,
  getKey = vaultKey,
  readRecord = readPilotRecord,
  getGrant = loadVerifiedGrant,
  reserve = reservePilotProject,
  lockSubmitted = markPilotSubmitted,
  updateStatus = markPilotCompleted,
  submitProject = submitPilotProject,
} = {}) {
  return async function handler(request) {
    if (request.method !== "POST") return failed("unexpected_error", 405);
    if (!requireSameOrigin(request) || !isStagingHost(request)) {
      return failed("pilot_owner_not_allowed", 403);
    }
    // Feature gate precedes all provider/database access. The gate is OFF by
    // default and should not be enabled without a fresh explicit user decision.
    const settings = getSettings();
    if (!settings.enabled) return failed("pilot_locked", 423);
    if (permanentMode() !== "permanent") return failed("secure_storage_unavailable", 503);

    let current;
    try {
      current = await getSession(request);
    } catch {
      return failed("connection_unavailable", 503);
    }
    if (!current) return failed("connection_unavailable", 401);
    if (!constantTimeEqual(request.headers.get("x-csrf-token"), current.csrf_token)) {
      return failed("connection_unavailable", 403);
    }
    if (!isPilotTarget(current, settings)) return failed("pilot_owner_not_allowed", 403);

    try {
      await parseApproval(request);
    } catch {
      return failed("invalid_confirmation", 400);
    }

    let capacity;
    try {
      const response = await checkCapacity(request);
      if (!response?.ok) return failed("no_free_capacity");
      capacity = await response.json();
    } catch {
      return failed("no_free_capacity", 503);
    }
    if (!eligibleForPilot(capacity)) return failed("no_free_capacity");

    let db, key, accessToken;
    try {
      db = await getDb();
      key = getKey();
      if (!key) return failed("secure_storage_unavailable", 503);
      const existing = await readRecord(current, db);
      if (existing) {
        return failed("already_reserved", 409, {
          existingAttempt: publicPilotRecord(existing),
        });
      }
      // Provider capacity has just been confirmed; decrypt *only* within
      // this server function and never send the token to the client.
      accessToken = await getGrant(current, db, key);
    } catch {
      return failed("connection_unavailable", 503);
    }

    let reservation;
    try {
      reservation = await reserve(current, { db, key });
    } catch {
      return failed("reservation_unavailable", 503);
    }
    if (!reservation.created) {
      return failed("already_reserved");
    }

    let submitted;
    try {
      submitted = await lockSubmitted(current, reservation.requestId, db);
    } catch {
      // A reserved row remains. Never blindly resubmit.
      return failed("submission_not_locked", 503);
    }
    if (!submitted) return failed("submission_not_locked", 503);

    let ref;
    try {
      ref = await submitProject(accessToken, current, reservation.password);
    } catch (error) {
      const code = error instanceof TestProjectError
        ? error.code : "provider_result_unknown";
      const definitelyRejected = [
        "provider_permission_denied", "provider_quota_or_billing",
      ].includes(code);
      try {
        await updateStatus(
          current, reservation.requestId,
          definitelyRejected ? "rejected" : "unknown",
          null, code, db
        );
      } catch {
        return failed("manual_review", 503);
      }
      // The provider may have created a resource even on a timeout or 5xx.
      return failed(code, 503, {
        projectCreated: false,
        creationOutcome: definitelyRejected ? "provider_rejected" : "unverified",
      });
    }

    try {
      const stored = await updateStatus(current, reservation.requestId,
        "created", ref, null, db);
      if (!stored) return failed("manual_review", 503);
    } catch {
      return failed("manual_review", 503);
    }
    return safeStatusResponse({
      state: "project_created",
      projectCreated: true,
      projectRef: ref,
      projectName: "Kleanly Business Staging CRM Pilot",
      organization: current.organization_name,
      autoRepeatAllowed: false,
      websiteCreated: false,
      crmSchemaInstalled: false,
      note: "Only the isolated test Supabase project was requested. CRM schema and Netlify site are not installed.",
    }, 201);
  };
}

export default createOneTestProjectHandler();
export const config = {
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 5 },
};

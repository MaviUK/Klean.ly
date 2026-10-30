import {
  constantTimeEqual, permanentMode, requireSameOrigin, safeStatusResponse,
} from "./_lib/connection-vault.mjs";
import { currentPortalSession } from "./_lib/connection-store.mjs";
import { createFreeProjectCapacityHandler } from "./free-project-capacity.mjs";
import {
  PILOT_PROJECT_NAME, PILOT_REGION_GROUP, PILOT_CONFIRMATION,
  pilotSettings, isPilotTarget, isStagingHost, eligibleForPilot,
  readPilotRecord, publicPilotRecord,
} from "./_lib/test-project-pilot.mjs";

// Read-only staging preview. Nothing here calls POST /v1/projects.
// It must remain useful even while the pilot creation switch is OFF.
export function createPilotProposalHandler({
  getSession = currentPortalSession,
  checkCapacity = createFreeProjectCapacityHandler(),
  readRecord = readPilotRecord,
  getSettings = pilotSettings,
} = {}) {
  return async function handler(request) {
    if (request.method !== "POST") {
      return safeStatusResponse({ error: "Method not allowed" }, 405);
    }
    if (!requireSameOrigin(request) || !isStagingHost(request)) {
      return safeStatusResponse({ error: "Staging access only" }, 403);
    }
    if (permanentMode() !== "permanent") {
      return safeStatusResponse({ error: "Secure portal unavailable" }, 503);
    }
    let current;
    try {
      current = await getSession(request);
    } catch {
      return safeStatusResponse({ error: "Unable to verify secure login" }, 503);
    }
    if (!current) {
      return safeStatusResponse({ error: "Connect your Supabase test account first" }, 401);
    }
    if (!constantTimeEqual(request.headers.get("x-csrf-token"), current.csrf_token)) {
      return safeStatusResponse({ error: "Session verification failed" }, 403);
    }

    const settings = getSettings();
    if (!isPilotTarget(current, settings)) {
      return safeStatusResponse({
        error: settings.allowlistConfigured
          ? "This pilot is restricted to the verified test organisation."
          : "Test-only owner allowlist has not been configured.",
        creationEnabled: false, projectCreated: false,
      }, settings.allowlistConfigured ? 403 : 503);
    }

    let capacity;
    try {
      const response = await checkCapacity(request);
      if (!response.ok) return safeStatusResponse({
        error: "Recheck both provider connections and Free Plan availability first.",
        creationEnabled: false, projectCreated: false,
      }, 409);
      capacity = await response.json();
    } catch {
      return safeStatusResponse({
        error: "Provider capacity could not be verified.",
        creationEnabled: false, projectCreated: false,
      }, 503);
    }
    let existing;
    try {
      existing = await readRecord(current);
    } catch {
      return safeStatusResponse({
        error: "The secure pilot reservation ledger is unavailable.",
        creationEnabled: false, projectCreated: false,
      }, 503);
    }

    const candidate = eligibleForPilot(capacity);
    return safeStatusResponse({
      mode: "staging_one_project_pilot",
      organization: current.organization_name,
      projectName: PILOT_PROJECT_NAME,
      regionSelection: "Europe / EMEA (Supabase chooses the precise region)",
      regionGroup: PILOT_REGION_GROUP,
      freePlanVerified: capacity?.freePlanConfirmed === true,
      visibleProjects: Number.isSafeInteger(capacity?.visibleAccountProjects)
        ? capacity.visibleAccountProjects : null,
      candidateForSingleFreeProject: candidate,
      creationEnabled: settings.enabled && candidate && !existing,
      creationLocked: !settings.enabled,
      existingAttempt: publicPilotRecord(existing),
      confirmationPhrase: PILOT_CONFIRMATION,
      needsExplicitConfirmation: true,
      freeProjectGuaranteed: false,
      noPaidAddonsRequested: true,
      projectCreated: existing?.status === "created",
      websiteCreated: false,
      crmSchemaInstalled: false,
      note: "Read-only proposal. A real create action requires fresh approval; provider pricing and region are not guaranteed.",
    });
  };
}
export default createPilotProposalHandler();

export const config = {
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 12 },
};

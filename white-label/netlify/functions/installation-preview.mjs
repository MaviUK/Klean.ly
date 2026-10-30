import { createProvisioningPreflight } from "./provisioning-preflight.mjs";
import { requireSameOrigin, safeStatusResponse } from "./_lib/connection-vault.mjs";
import { providers, requiredProviderIds } from "../../installer/catalog.mjs";
import { currentPortalSession } from "./_lib/connection-store.mjs";
import {
  PILOT_PROJECT_NAME, pilotSettings, isPilotTarget, isStagingHost,
  readPilotRecord, publicPilotRecord,
} from "./_lib/test-project-pilot.mjs";

// This service deliberately generates a PLAN, never an installation.
// The only provider access runs through the existing read-only readiness
// handler, which validates the portal session, CSRF, both OAuth grants and
// Supabase organisation ownership. It creates no external resources.
const MAX_BLUEPRINT_BYTES = 8192;
const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const SAFE_NAME = /^[^\x00-\x1f\x7f]{1,160}$/u;
const KEYS = new Set(["schemaVersion", "company", "desiredProviders", "generatedAt", "important"]);
const COMPANY_KEYS = new Set(["name", "domain", "logoUrl", "primaryColor"]);
const PROVIDER_IDS = new Set(providers.map((provider) => provider.id));

export class InstallationPlanError extends Error {
  constructor(message) {
    super(message);
    this.name = "InstallationPlanError";
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function allowedKeys(object, allowed) {
  return Object.keys(object).every((key) => allowed.has(key));
}

export function validateBlueprint(input) {
  if (!isObject(input) || !allowedKeys(input, KEYS) || input.schemaVersion !== 1 ||
      !isObject(input.company) || !allowedKeys(input.company, COMPANY_KEYS)) {
    throw new InstallationPlanError("The setup blueprint has an unsupported format.");
  }
  const inputName = input.company.name;
  if (typeof inputName !== "string") {
    throw new InstallationPlanError("Enter a business name before previewing installation.");
  }
  const name = inputName.trim();
  if (!SAFE_NAME.test(inputName) || !SAFE_NAME.test(name)) {
    throw new InstallationPlanError("Business name must contain 1–160 printable characters.");
  }

  const rawDomain = input.company.domain ?? "";
  if (typeof rawDomain !== "string") {
    throw new InstallationPlanError("The optional domain is invalid.");
  }
  const domain = rawDomain.trim().toLowerCase();
  if (domain && (!HOSTNAME.test(domain) || domain.split(".").some(
    (part) => part.length > 63 || part.startsWith("-") || part.endsWith("-")
  ))) {
    throw new InstallationPlanError("Enter a valid custom domain or leave it blank.");
  }

  const rawLogo = input.company.logoUrl ?? "";
  if (typeof rawLogo !== "string" || rawLogo.length > 500) {
    throw new InstallationPlanError("Logo URL is invalid.");
  }
  const logoUrl = rawLogo.trim();
  if (logoUrl) {
    let parsed;
    try {
      parsed = new URL(logoUrl);
    } catch {
      throw new InstallationPlanError("Logo URL must be an HTTPS URL.");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
        !parsed.hostname || parsed.hash || !/^https:\/\/\S+$/i.test(logoUrl)) {
      throw new InstallationPlanError("Logo URL must be an HTTPS URL without credentials or fragments.");
    }
  }

  const primaryColor = input.company.primaryColor ?? "#059669";
  if (typeof primaryColor !== "string" || !/^#[0-9a-fA-F]{6}$/.test(primaryColor)) {
    throw new InstallationPlanError("Choose a valid six-digit brand colour.");
  }

  if (!Array.isArray(input.desiredProviders) || input.desiredProviders.length > 20 ||
      input.desiredProviders.some((id) => typeof id !== "string" || !PROVIDER_IDS.has(id))) {
    throw new InstallationPlanError("One or more selected services are not supported.");
  }
  return {
    name, domain, logoUrl, primaryColor: primaryColor.toLowerCase(),
    desiredProviders: [...new Set([...requiredProviderIds, ...input.desiredProviders])],
  };
}

export function createInstallationPlan(input, readiness, now = new Date(), pilotRecord = null) {
  if (!isObject(readiness) ||
      readiness.readyForCostReview !== true ||
      readiness.supabaseVerified !== true ||
      readiness.netlifyVerified !== true ||
      readiness.readyToInstall !== false ||
      readiness.installationsCreated !== false ||
      !Number.isSafeInteger(readiness.observedProjectCount) ||
      readiness.observedProjectCount < 0 ||
      typeof readiness.organizationName !== "string" ||
      readiness.organizationName.length > 160) {
    throw new InstallationPlanError("The infrastructure readiness check is incomplete.");
  }
  const business = validateBlueprint(input);
  // This is the trusted, server-side reservation record from the separately
  // approved staging pilot, not an inference from project counts or blueprint.
  const pilotCreated = pilotRecord?.status === "created" &&
    pilotRecord?.projectName === PILOT_PROJECT_NAME &&
    typeof pilotRecord.projectRef === "string" &&
    /^[a-z0-9]{20}$/i.test(pilotRecord.projectRef) &&
    readiness.observedProjectCount > 0;
  return {
    planVersion: 1,
    mode: "preview_only",
    createdAt: now.toISOString(),
    business: {
      name: business.name, domain: business.domain || null,
      primaryColor: business.primaryColor,
      logoProvided: !!business.logoUrl,
    },
    supabase: {
      organization: readiness.organizationName,
      projectsObserved: readiness.observedProjectCount,
      mayHaveMoreProjects: readiness.mayHaveMoreProjects === true,
      dedicatedProjectRequired: true,
      region: "Select before installation",
      freeProjectAvailability: "Not verified",
      pilotProject: pilotCreated ? {
        name: PILOT_PROJECT_NAME,
        ref: pilotRecord.projectRef,
        status: "created_in_staging",
      } : null,
    },
    netlify: {
      connectionVerified: true,
      dedicatedSiteRequired: true,
      siteNameAvailable: "Not verified",
    },
    integrations: business.desiredProviders.map((id) => {
      const provider = providers.find((p) => p.id === id);
      return {
        id, name: provider.name, required: provider.required,
        state: id === "supabase" || id === "netlify"
          ? "connected" : "setup_required",
      };
    }),
    steps: [
      { id: "independent_login", title: "Create a dedicated Klean.ly Business owner login", state: "not_implemented" },
      { id: "billing_review", title: "Verify provider limits, costs and obtain explicit approval", state: "required" },
      { id: "project",
        title: pilotCreated
          ? "Create a company-owned Supabase project (staging pilot only)"
          : "Create a company-owned Supabase project",
        state: pilotCreated ? "pilot_created" : "not_implemented" },
      { id: "database", title: "Apply the dedicated CRM schema and verify row security", state: "not_implemented" },
      { id: "site", title: "Create a company-owned Netlify site", state: "not_implemented" },
      { id: "secrets", title: "Configure server-only credentials for the new installation", state: "not_implemented" },
      { id: "deploy", title: "Deploy and verify the white-label management application", state: "not_implemented" },
    ],
    costsVerified: false,
    consentToCharges: false,
    installationEnabled: false,
    readyToInstall: false,
    installationsCreated: false,
    note: pilotCreated
      ? "Preview only. The staging pilot previously created one Supabase project. No CRM schema, site or full customer installation has been created."
      : "Planning preview only. This check did not create any project, website, deployment or billing transaction.",
  };
}

// This query only runs after preflight has authenticated the request and
// checked both provider grants. It reads the allowlisted staging pilot ledger;
// no provider create action or installation is possible here.
export async function readStagingPilotProject(request, {
  getSession = currentPortalSession,
  getRecord = readPilotRecord,
  settings = pilotSettings(),
} = {}) {
  if (!isStagingHost(request)) return null;
  const current = await getSession(request);
  if (!current || !isPilotTarget(current, settings)) return null;
  return publicPilotRecord(await getRecord(current));
}

export function createInstallationPreviewHandler({
  checkReadiness = createProvisioningPreflight(),
  getPilotProject = readStagingPilotProject,
} = {}) {
  return async function handler(request) {
    if (request.method !== "POST") {
      return safeStatusResponse({ error: "Method not allowed" }, 405);
    }
    if (!requireSameOrigin(request)) {
      return safeStatusResponse({ error: "Cross-origin request denied" }, 403);
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return safeStatusResponse({ error: "Send a JSON blueprint." }, 415);
    }

    // Delegate login, CSRF and provider permission checks. Do not inspect or
    // expose the provider tokens, which never enter this function's response.
    let readinessResponse;
    try {
      readinessResponse = await checkReadiness(request);
      if (!readinessResponse.ok) {
        return safeStatusResponse({
          error: "Verify both infrastructure accounts before previewing the installation.",
          code: "readiness_required",
          installationEnabled: false, installationsCreated: false,
        }, readinessResponse.status === 401 || readinessResponse.status === 403
          ? readinessResponse.status : 409);
      }
    } catch {
      return safeStatusResponse({
        error: "The secure readiness service is temporarily unavailable.",
        installationEnabled: false, installationsCreated: false,
      }, 503);
    }

    try {
      const raw = await request.text();
      if (raw.length > MAX_BLUEPRINT_BYTES) {
        return safeStatusResponse({
          error: "Blueprint exceeds the supported size.", installationEnabled: false,
        }, 413);
      }
      const parsed = JSON.parse(raw);
      if (!isObject(parsed) || !allowedKeys(parsed, new Set(["blueprint"]))) {
        throw new InstallationPlanError("The setup blueprint has an unsupported format.");
      }
      // Validate untrusted browser input before any extra pilot-ledger lookup.
      validateBlueprint(parsed.blueprint);
      const readiness = await readinessResponse.json();
      const pilotRecord = await getPilotProject(request);
      const plan = createInstallationPlan(parsed.blueprint, readiness, new Date(), pilotRecord);
      return safeStatusResponse(plan);
    } catch (error) {
      if (error instanceof InstallationPlanError || error instanceof SyntaxError) {
        return safeStatusResponse({
          error: error instanceof InstallationPlanError
            ? error.message : "The setup blueprint is not valid JSON.",
          installationEnabled: false, installationsCreated: false,
        }, 400);
      }
      return safeStatusResponse({
        error: "Unable to prepare a safe installation preview.",
        installationEnabled: false, installationsCreated: false,
      }, 503);
    }
  };
}

export default createInstallationPreviewHandler();
export const config = {
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 15 },
};

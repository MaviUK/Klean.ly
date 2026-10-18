import test from "node:test";
import assert from "node:assert/strict";
import {
  validateBlueprint, createInstallationPlan, createInstallationPreviewHandler,
  readStagingPilotProject,
} from "../netlify/functions/installation-preview.mjs";

const origin = "https://kleanly-business-installer-staging.netlify.app";
const route = origin + "/.netlify/functions/installation-preview";
const blueprint = {
  schemaVersion: 1,
  company: {
    name: "Klean.ly Test Business",
    domain: "",
    logoUrl: "",
    primaryColor: "#059669",
  },
  desiredProviders: ["supabase", "netlify", "google_maps"],
  generatedAt: "2026-10-18T10:00:00Z",
  important: "Downloaded planning blueprint; credentials intentionally omitted.",
};
const readiness = {
  readyForCostReview: true,
  readyToInstall: false,
  installationsCreated: false,
  supabaseVerified: true,
  netlifyVerified: true,
  organizationName: "kleanly test database",
  observedProjectCount: 1,
  mayHaveMoreProjects: false,
};

function request(body = { blueprint }, headers = {}, method = "POST") {
  return new Request(route, {
    method,
    headers: {
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      "X-CSRF-Token": "fake-session-csrf",
      ...headers,
    },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

test("validates manifest but never trusts extra credentials, org or provider identifiers", () => {
  assert.deepEqual(validateBlueprint(blueprint), {
    name: "Klean.ly Test Business",
    domain: "",
    logoUrl: "",
    primaryColor: "#059669",
    desiredProviders: ["supabase", "netlify", "google_maps"],
  });
  assert.throws(() => validateBlueprint({
    ...blueprint, service_role: "sensitive"
  }), /unsupported format/);
  assert.throws(() => validateBlueprint({
    ...blueprint, organization_id: "attacker-org"
  }), /unsupported format/);
  assert.throws(() => validateBlueprint({
    ...blueprint, company: { ...blueprint.company, supabaseKey: "secret" }
  }), /unsupported format/);
  assert.throws(() => validateBlueprint({
    ...blueprint, desiredProviders: ["supabase", "netlify", "unknown_provider"]
  }), /not supported/);
  assert.throws(() => validateBlueprint({
    ...blueprint, company: { ...blueprint.company, domain: "evil.example/../../" }
  }), /valid custom domain/);
  assert.throws(() => validateBlueprint({
    ...blueprint, company: { ...blueprint.company, logoUrl: "https://user:secret@example.org/logo" }
  }), /without credentials/);
  assert.throws(() => validateBlueprint({
    ...blueprint, company: { ...blueprint.company, name: "\nusername" }
  }), /printable/);
  assert.throws(() => validateBlueprint({ ...blueprint, schemaVersion: 55 }), /unsupported/);
});

test("builds a reproducible non-executable preview without billing or allocation", () => {
  const plan = createInstallationPlan(blueprint, readiness, new Date("2026-10-18T13:00:00Z"));
  assert.equal(plan.mode, "preview_only");
  assert.equal(plan.createdAt, "2026-10-18T13:00:00.000Z");
  assert.equal(plan.business.name, blueprint.company.name);
  assert.equal(plan.supabase.organization, readiness.organizationName);
  assert.equal(plan.supabase.projectsObserved, 1);
  assert.equal(plan.netlify.connectionVerified, true);
  assert.equal(plan.integrations.some(x => x.id === "google_maps" && x.state === "setup_required"), true);
  assert.equal(plan.steps.some(x => x.id === "independent_login" && x.state === "not_implemented"), true);
  assert.equal(plan.steps.some(x => x.id === "billing_review" && x.state === "required"), true);
  assert.equal(plan.costsVerified, false);
  assert.equal(plan.consentToCharges, false);
  assert.equal(plan.installationEnabled, false);
  assert.equal(plan.readyToInstall, false);
  assert.equal(plan.installationsCreated, false);
  assert.equal(JSON.stringify(plan).includes("sensitive-user-supplied-private-key"), false);
});

test("the preview handler reuses the secure read-only readiness check and never installs", async () => {
  let checks = 0;
  const handler = createInstallationPreviewHandler({
    getPilotProject: async () => null,
    checkReadiness: async (r) => {
      checks++;
      assert.equal(r.method, "POST");
      assert.equal(r.headers.get("x-csrf-token"), "fake-session-csrf");
      return Response.json(readiness);
    },
  });
  const res = await handler(request());
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.mode, "preview_only");
  assert.equal(data.business.name, "Klean.ly Test Business");
  assert.equal(data.installationEnabled, false);
  assert.equal(data.installationsCreated, false);
  assert.equal(data.costsVerified, false);
  assert.equal(checks, 1);
  assert.doesNotMatch(JSON.stringify(data), /fake-session-csrf|service_role|access_token/);
});

test("invalid request origin, method and media type are rejected without checking providers", async () => {
  let checks = 0;
  const handler = createInstallationPreviewHandler({
    getPilotProject: async () => null,
    checkReadiness: async () => { checks++; return Response.json(readiness); },
  });
  assert.equal((await handler(request({ blueprint }, { Origin: "https://attacker.invalid" }))).status, 403);
  assert.equal((await handler(request(undefined, {}, "GET"))).status, 405);
  assert.equal((await handler(request({ blueprint }, { "Content-Type": "text/plain" }))).status, 415);
  assert.equal(checks, 0);
});

test("failed session readiness and missing permissions cannot show a plan", async () => {
  for (const status of [401, 403, 409, 503]) {
    const handler = createInstallationPreviewHandler({
    getPilotProject: async () => null,
      checkReadiness: async () => new Response(
        JSON.stringify({ error: "Do not expose sensitive provider details." }),
        {status, headers: {"Content-Type": "application/json"}}
      ),
    });
    const response = await handler(request());
    assert.equal(response.status, status === 401 || status === 403 ? status : 409);
    const data = await response.json();
    assert.equal(data.installationEnabled, false);
    assert.equal(data.installationsCreated, false);
    assert.doesNotMatch(JSON.stringify(data), /sensitive provider details/);
  }
});

test("malformed and oversized blueprints do not trigger installation or reflect secrets", async () => {
  const handler = createInstallationPreviewHandler({
    getPilotProject: async () => null,
    checkReadiness: async () => Response.json(readiness),
  });
  const credentials = "sensitive-user-supplied-private-key";
  const response = await handler(request({blueprint:{...blueprint, clientSecret: credentials}}));
  assert.equal(response.status, 400);
  assert.doesNotMatch(JSON.stringify(await response.json()), new RegExp(credentials));
  const oversized = await handler(request({blueprint:{
    ...blueprint, important:"x".repeat(9000)
  }}));
  assert.equal(oversized.status, 413);
});

test("server fails closed when readiness omits any provider or claims installation occurred", () => {
  for (const altered of [
    { netlifyVerified: false },
    { supabaseVerified: false },
    { readyForCostReview: false },
    { installationsCreated: true },
    { readyToInstall: true },
    { observedProjectCount: "1" },
  ]) {
    assert.throws(() => createInstallationPlan(blueprint, {...readiness, ...altered}));
  }
});

test("records a verified staging pilot without claiming the CRM is installed", () => {
  const validRecord = {
    status: "created", projectName: "Kleanly Business Staging CRM Pilot",
    projectRef: "abcdefghijklmnopqrst",
  };
  const current = { ...readiness, observedProjectCount: 2 };
  const plan = createInstallationPlan(blueprint, current,
    new Date("2026-10-18T14:00:00Z"), validRecord);
  assert.equal(plan.steps.find(x => x.id === "project").state, "pilot_created");
  assert.equal(plan.supabase.pilotProject.ref, validRecord.projectRef);
  assert.equal(plan.installationsCreated, false);
  assert.equal(plan.installationEnabled, false);
  assert.equal(plan.readyToInstall, false);
  assert.equal(plan.steps.find(x => x.id === "database").state, "not_implemented");

  for (const bad of [null,
    { ...validRecord, status: "unknown" },
    { ...validRecord, projectName: "Someone else's project" },
    { ...validRecord, projectRef: "wrong" },
  ]) {
    const other = createInstallationPlan(blueprint, current, new Date(), bad);
    assert.equal(other.steps.find(x => x.id === "project").state, "not_implemented");
    assert.equal(other.supabase.pilotProject, null);
  }
  const noInventory = createInstallationPlan(blueprint,
    {...current, observedProjectCount: 0}, new Date(), validRecord);
  assert.equal(noInventory.supabase.pilotProject, null);
});

test("a staging pilot record can only be looked up for the allowlisted connected owner", async () => {
  const owner = {
    user_id: "test-user", connection_id: "test-grant",
    organization_id: "test-org", organization_slug: "kleanly-test",
    connection_status: "connected",
    email: "kleanlytest@gerball.co.uk",
    organization_name: "kleanly test database",
  };
  const settings = {
    allowlistConfigured: true,
    ownerEmail: "kleanlytest@gerball.co.uk",
    organizationName: "kleanly test database",
  };
  let reads = 0;
  const getRecord = async () => {
    reads++;
    return {
      status: "created",
      project_name: "Kleanly Business Staging CRM Pilot",
      project_ref: "abcdefghijklmnopqrst",
    };
  };
  const options = { getSession: async () => owner, getRecord, settings };
  const found = await readStagingPilotProject(request(), options);
  assert.equal(found.status, "created");
  assert.equal(found.projectName, "Kleanly Business Staging CRM Pilot");
  assert.equal(reads, 1);
  assert.equal(await readStagingPilotProject(
    new Request("https://klean.ly/.netlify/functions/installation-preview"),
    options
  ), null);
  assert.equal(await readStagingPilotProject(request(), {
    ...options,
    getSession: async () => ({...owner, email: "unrelated@example.com"}),
  }), null);
  assert.equal(reads, 1);
});

test("pilot lookup occurs only after successful secure readiness and valid blueprint", async () => {
  let pilotReads = 0;
  const getPilotProject = async () => {
    pilotReads++;
    return {
      status: "created", projectName: "Kleanly Business Staging CRM Pilot",
      projectRef: "abcdefghijklmnopqrst",
    };
  };
  const handler = createInstallationPreviewHandler({
    checkReadiness: async () => Response.json({...readiness, observedProjectCount: 2}),
    getPilotProject,
  });
  const response = await handler(request());
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.steps.find(x => x.id === "project").state, "pilot_created");
  assert.equal(pilotReads, 1);
  assert.equal(data.installationEnabled, false);
  assert.equal((await handler(request({blueprint: { ...blueprint, schemaVersion: 999 } }))).status, 400);
  assert.equal(pilotReads, 1);
  const notReady = createInstallationPreviewHandler({
    checkReadiness: async () => new Response(null, {status: 403}),
    getPilotProject,
  });
  assert.equal((await notReady(request())).status, 403);
  assert.equal(pilotReads, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  createCrmDatabaseReviewHandler, inspectProjectDetails,
  interpretSchemaProbe, probePilotSchema, SCHEMA_PROBE,
} from "../netlify/functions/crm-database-review.mjs";
import { PILOT_PROJECT_NAME, pilotSettings } from
  "../netlify/functions/_lib/test-project-pilot.mjs";

const origin = "https://kleanly-business-installer-staging.netlify.app";
const ref = "abcdefghijklmnopqrst";
const session = {
  connection_status: "connected", email: "pilot-owner@example.test",
  user_id: "pilot-user", organization_name: "pilot company org",
  organization_slug: "pilot-org", organization_id: "pilot-org-id",
  connection_id: "uuid-test", csrf_token: "csrf-test",
};
const settings = pilotSettings({
  KLEANLY_PILOT_OWNER_EMAIL: session.email,
  KLEANLY_PILOT_ORGANIZATION_NAME: session.organization_name,
});
const record = { status: "created", project_name: PILOT_PROJECT_NAME, project_ref: ref };
const metadata = {
  id: ref, name: PILOT_PROJECT_NAME, organization_id: session.organization_id,
  status: "ACTIVE_HEALTHY", region: "eu-central-1",
};
const readiness = {
  supabaseVerified: true, netlifyVerified: true,
  organizationName: session.organization_name, observedProjectCount: 2,
};
function request(method = "POST", url = origin + "/.netlify/functions/crm-database-review", headers = {}) {
  return new Request(url, {
    method,
    headers: {
      Origin: origin, "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": session.csrf_token,
      ...headers,
    },
  });
}
function handler(overrides = {}) {
  return createCrmDatabaseReviewHandler({
    getMode: () => "permanent",
    getSession: async () => session,
    getSettings: () => settings,
    checkReadiness: async () => Response.json(readiness),
    readRecord: async () => record,
    getGrant: async () => "test-token",
    getProject: async () => metadata,
    checkSchema: async () => ({
      permitted: true,
      schema: { directoryTablesPresent: false, existingCrmTables: 0, emptyForCrm: true },
    }),
    ...overrides,
  });
}
function schemaRow(overrides = {}) {
  return Object.fromEntries([
    "directory_cleaners", "directory_business_customers", "business_profile",
    "team_members", "customers", "rounds", "customer_services", "jobs",
    "payments", "message_log", "schema_versions",
  ].map(k => [k, overrides[k] ?? false]));
}

test("SQL probe is purely SELECT and uses the provider's read_only mode", async () => {
  let fetches = 0;
  const probe = await probePilotSchema(ref, "token", async (url, options) => {
    fetches++;
    assert.equal(url, "https://api.supabase.com/v1/projects/" + ref + "/database/query");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer token");
    assert.equal(JSON.parse(options.body).read_only, true);
    assert.equal(JSON.parse(options.body).query, SCHEMA_PROBE);
    assert.match(SCHEMA_PROBE, /^select /);
    assert.doesNotMatch(SCHEMA_PROBE, /\b(insert|update|delete|create|alter|drop|grant)\b/i);
    return Response.json([schemaRow()], { status: 201 });
  });
  assert.equal(fetches, 1);
  assert.equal(probe.permitted, true);
  assert.equal(probe.schema.emptyForCrm, true);
});

test("schema probe fails closed on invalid results, directory and partial schemas", () => {
  assert.throws(() => interpretSchemaProbe([]));
  assert.throws(() => interpretSchemaProbe([{}]));
  assert.throws(() => interpretSchemaProbe([schemaRow({jobs: "false"})]));
  assert.deepEqual(interpretSchemaProbe([schemaRow({directory_cleaners: true})]), {
    directoryTablesPresent: true, existingCrmTables: 0, emptyForCrm: false,
  });
  assert.deepEqual(interpretSchemaProbe([schemaRow({customers: true, schema_versions: true})]), {
    directoryTablesPresent: false, existingCrmTables: 2, emptyForCrm: false,
  });
});

test("approved staging pilot with healthy, exact provider identity has read-only ready state", async () => {
  const response = await handler()(request());
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.state, "schema_ready_for_approval");
  assert.equal(result.projectRef, ref);
  assert.equal(result.region, "eu-central-1");
  assert.equal(result.projectVerified, true);
  assert.equal(result.schemaVerified, true);
  assert.equal(result.readyForSeparateApproval, true);
  assert.equal(result.schemaInstalled, false);
  assert.equal(result.installationEnabled, false);
  assert.equal(result.writeAttempted, false);
  assert.doesNotMatch(JSON.stringify(result), /csrf-test|test-token|uuid-test/);
});

test("no provider access for cross-origin requests, wrong owner, bad CSRF or wrong method", async () => {
  let calls = 0;
  const h = handler({
    checkReadiness: async () => { calls++; return Response.json(readiness); },
  });
  assert.equal((await h(request("GET"))).status, 405);
  assert.equal((await h(request("POST", "https://klean.ly/.netlify/functions/crm-database-review"))).status, 403);
  assert.equal((await h(request("POST", undefined, { "X-CSRF-Token": "invalid" }))).status, 403);
  assert.equal((await h(request("POST", undefined, { Origin: "https://fake.invalid" }))).status, 403);
  const bad = handler({
    getSession: async () => ({ ...session, email: "stranger@example.test" }),
    checkReadiness: async () => { calls++; return Response.json(readiness); },
  });
  assert.equal((await bad(request())).status, 403);
  assert.equal(calls, 0);
});

test("does not inspect a user-supplied project and never infers pilot from project count", async () => {
  let getGrant = 0, checkSchema = 0;
  const h = handler({
    readRecord: async () => ({...record, status: "unknown"}),
    getGrant: async () => { getGrant++; return "token"; },
    checkSchema: async () => { checkSchema++; throw Error("must not reach database"); },
  });
  const result = await h(request());
  assert.equal(result.status, 409);
  assert.equal(getGrant, 0);
  assert.equal(checkSchema, 0);
});

test("project identity must exactly match the stored single pilot and organisation", () => {
  assert.equal(inspectProjectDetails({...metadata, id: "different"}, record, session.organization_id), null);
  assert.equal(inspectProjectDetails({...metadata, organization_id: "other"}, record, session.organization_id), null);
  assert.equal(inspectProjectDetails({...metadata, name: "Klean.ly directory"}, record, session.organization_id), null);
  assert.equal(inspectProjectDetails(metadata, record, session.organization_id).healthy, true);
});

test("a missing SQL permission reports that action is locked, without trying writes", async () => {
  const h = handler({
    checkSchema: async () => ({permitted: false, unavailable: "permissions_required"}),
  });
  const response = await h(request());
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.state, "database_permission_required");
  assert.equal(data.projectVerified, true);
  assert.equal(data.schemaVerified, false);
  assert.equal(data.schemaInstalled, false);
  assert.equal(data.installationEnabled, false);
});

test("a directory table or incomplete CRM schema blocks installation readiness", async () => {
  for(const schema of [
    {directoryTablesPresent: true, existingCrmTables: 0, emptyForCrm: false},
    {directoryTablesPresent: false, existingCrmTables: 2, emptyForCrm: false},
  ]) {
    const response = await handler({checkSchema: async () => ({permitted: true, schema})})(request());
    const data = await response.json();
    assert.equal(data.readyForSeparateApproval, false);
    assert.notEqual(data.state, "schema_ready_for_approval");
  }
});

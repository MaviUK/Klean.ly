import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  OWNER_READINESS_SQL, parseOwnerReadiness, inspectOwnerTables,
  createOwnerLoginReadinessHandler,
} from "../netlify/functions/owner-login-readiness.mjs";
import { PILOT_PROJECT_NAME, pilotSettings } from
  "../netlify/functions/_lib/test-project-pilot.mjs";

const origin = "https://kleanly-business-installer-staging.netlify.app";
const ref = "abcdefghijklmnopqrst";
const current = {
  user_id: "test-owner", connection_id: "test-connection",
  connection_status: "connected", email: "pilot@example.test",
  organization_id: "pilot-org", organization_slug: "pilot-org",
  organization_name: "pilot organization", csrf_token: "test-csrf",
};
const settings = pilotSettings({
  KLEANLY_PILOT_OWNER_EMAIL: current.email,
  KLEANLY_PILOT_ORGANIZATION_NAME: current.organization_name,
});
const record = {
  status: "created", project_name: PILOT_PROJECT_NAME, project_ref: ref,
};
const schemaAttempt = {
  status: "applied", project_ref: ref, blueprint_version: 1,
};
const project = {
  id: ref, name: PILOT_PROJECT_NAME, organization_id: current.organization_id,
  status: "ACTIVE_HEALTHY", region: "eu-central-1",
};
const pristine = {
  permitted: true,
  ownerConfigured: false, staffConfigured: false,
  schemaVersionConfirmed: true,
  eightTablesConfirmed: true, eightRlsConfirmed: true,
};
function request(method = "POST",
  url = origin + "/.netlify/functions/owner-login-readiness", headers = {}) {
  return new Request(url, {
    method,
    headers: {
      Origin: origin, "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": current.csrf_token, ...headers,
    },
  });
}
function handler(overrides = {}) {
  return createOwnerLoginReadinessHandler({
    getSession: async () => current,
    getMode: () => "permanent",
    getSettings: () => settings,
    getProjectRecord: async () => record,
    getSchemaAttempt: async () => schemaAttempt,
    getGrant: async () => "test-secret-token",
    getProject: async () => project,
    checkTables: async () => pristine,
    ...overrides,
  });
}
function row(overrides = {}) {
  return {
    owner_profiles: "0", team_members: "0", schema_versions: "1",
    crm_tables: "8", rls_tables: "8", ...overrides,
  };
}

test("owner readiness SQL is read-only and returns no user identity", async () => {
  let calls = 0;
  const actual = await inspectOwnerTables(ref, "test-access-token", async (url, options) => {
    calls++;
    assert.equal(url, "https://api.supabase.com/v1/projects/" + ref + "/database/query");
    assert.equal(options.method, "POST");
    assert.equal(JSON.parse(options.body).read_only, true);
    assert.equal(JSON.parse(options.body).query, OWNER_READINESS_SQL);
    assert.match(OWNER_READINESS_SQL, /^select /);
    assert.doesNotMatch(OWNER_READINESS_SQL, /\b(insert|update|delete|create|alter|drop|grant|truncate)\b/i);
    assert.doesNotMatch(OWNER_READINESS_SQL, /\bauth\.users\b/i);
    return Response.json([row()], { status: 201 });
  });
  assert.equal(calls, 1);
  assert.deepEqual(actual, {
    permitted: true, ownerConfigured: false, staffConfigured: false,
    schemaVersionConfirmed: true, eightTablesConfirmed: true,
    eightRlsConfirmed: true, ownerRecordCount: 0, staffRecordCount: 0,
  });
});

test("probe rejects malformed SQL result values and identifies pre-existing owner", () => {
  assert.throws(() => parseOwnerReadiness([]), /invalid_owner_readiness/);
  assert.throws(() => parseOwnerReadiness([{}]), /invalid_owner_readiness/);
  assert.throws(() => parseOwnerReadiness([row({owner_profiles:-1})]));
  assert.throws(() => parseOwnerReadiness([row({owner_profiles:"maybe"})]));
  assert.throws(() => parseOwnerReadiness([row({rls_tables:"1.2"})]));
  const actual = parseOwnerReadiness([row({owner_profiles:1,team_members:"1"})]);
  assert.equal(actual.ownerConfigured, true);
  assert.equal(actual.staffConfigured, true);
  assert.equal(actual.ownerRecordCount, 1);
  assert.equal(actual.staffRecordCount, 1);
  assert.equal(JSON.stringify(actual).includes("test@example"), false);
});

test("installed and verified pilot is eligible for owner login DEVELOPMENT only", async () => {
  const r = await handler()(request());
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.mode, "staging_owner_login_readiness");
  assert.equal(data.state, "owner_setup_can_be_prepared");
  assert.equal(data.projectName, PILOT_PROJECT_NAME);
  assert.equal(data.projectRef, ref);
  assert.equal(data.region, "eu-central-1");
  assert.equal(data.schemaVerified, true);
  assert.equal(data.readyForInvitationDevelopment, true);
  assert.equal(data.needsBusinessSiteAndAuthRedirect, true);
  assert.equal(data.needsOwnerEmailSelection, true);
  assert.equal(data.ownerInvitationEnabled, false);
  assert.equal(data.ownerCreated, false);
  assert.equal(data.emailSent, false);
  assert.equal(data.writeAttempted, false);
  assert.doesNotMatch(JSON.stringify(data), /test-secret-token|test-csrf|test-connection/);
});

test("no provider requests for non-staging site, wrong origin, wrong owner or invalid CSRF", async () => {
  let calls = 0;
  const probe = handler({getProjectRecord:async () => {calls++;return record;}});
  assert.equal((await probe(request("GET"))).status, 405);
  assert.equal((await probe(request("POST", "https://klean.ly/.netlify/functions/owner-login-readiness"))).status, 403);
  assert.equal((await probe(request("POST", undefined, {Origin:"https://elsewhere.example"}))).status, 403);
  assert.equal((await probe(request("POST", undefined, {"X-CSRF-Token":"wrong"}))).status, 403);
  const other = handler({
    getSession: async () => ({...current,email:"wrong@example.test"}),
    getProjectRecord:async () => {calls++;return record;},
  });
  assert.equal((await other(request())).status, 403);
  assert.equal(calls, 0);
});

test("schema must be recorded as applied to the matching project before probing", async () => {
  for (const changed of [
    {getProjectRecord:async () => ({...record,status:"unknown"})},
    {getProjectRecord:async () => ({...record,project_ref:"00000000000000000000"})},
    {getProjectRecord:async () => ({...record,project_name:"Klean.ly directory"})},
    {getSchemaAttempt:async () => ({...schemaAttempt,status:"submitted"})},
    {getSchemaAttempt:async () => ({...schemaAttempt,project_ref:"00000000000000000000"})},
    {getSchemaAttempt:async () => ({...schemaAttempt,blueprint_version:2})},
  ]) {
    let invoked = 0;
    const r = await handler({
      ...changed,
      getGrant: async () => {invoked++;throw Error("no provider request allowed");},
    })(request());
    assert.equal(r.status, 409);
    assert.equal(invoked, 0);
    assert.equal((await r.json()).ownerInvitationEnabled, false);
  }
});

test("wrong project, wrong region and unhealthy project cannot proceed to owner check", async () => {
  for (const changed of [
    {id:"00000000000000000000"}, {organization_id:"unrelated"},
    {name:"Klean.ly live directory"}, {region:"eu-west-1"}, {status:"PAUSED"},
  ]) {
    let probes=0;
    const r = await handler({
      getProject:async () => ({...project,...changed}),
      checkTables:async () => {probes++;throw Error("should not inspect");},
    })(request());
    assert.equal(r.status, 409);
    assert.equal(probes, 0);
  }
});

test("pre-existing owner or partial security prevents first-owner readiness", async () => {
  for(const [report,status] of [
    [{...pristine,ownerConfigured:true},"owner_already_present"],
    [{...pristine,staffConfigured:true},"owner_already_present"],
    [{...pristine,eightRlsConfirmed:false},"schema_security_review_required"],
    [{...pristine,eightTablesConfirmed:false},"schema_security_review_required"],
    [{...pristine,schemaVersionConfirmed:false},"schema_security_review_required"],
  ]) {
    const r = await handler({checkTables:async () => report})(request());
    assert.equal(r.status,200);
    const data = await r.json();
    assert.equal(data.state,status);
    assert.equal(data.readyForInvitationDevelopment,false);
    assert.equal(data.ownerInvitationEnabled,false);
    assert.equal(data.emailSent,false);
  }
});

test("read-only API permission denial does not trigger an owner creation attempt",async()=>{
  const r=await handler({
    checkTables:async()=>({permitted:false,reason:"query_permission_required"}),
  })(request());
  assert.equal(r.status,200);
  const data=await r.json();
  assert.equal(data.status,"database_permission_required");
  assert.equal(data.ownerInvitationEnabled,false);
  assert.equal(data.ownerCreated,false);
});

test("owner readiness UI remains read-only with no invitations or email selection yet",()=>{
  // The next release may add a distinct owner invite form only AFTER the
  // dedicated tenant callback URL and email-delivery flow are approved.
  const html=readFileSync(new URL("../installer/index.html",import.meta.url),"utf8");
  const js=readFileSync(new URL("../installer/app.mjs",import.meta.url),"utf8");
  assert.match(html,/id="check-owner-readiness" class="action-button" disabled/);
  assert.match(html,/id="owner-readiness-result"/);
  assert.match(js,/\.netlify\/functions\/owner-login-readiness/);
  assert.match(js,/byId\("check-owner-readiness"\)\.addEventListener/);
  assert.doesNotMatch(html, /id="invite-business-owner"/);
});

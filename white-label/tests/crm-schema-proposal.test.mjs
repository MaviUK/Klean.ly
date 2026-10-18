import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CRM_BLUEPRINT_TABLES, CRM_BLUEPRINT_VERSION, verifiedForSchemaProposal,
  createCrmSchemaProposalHandler,
} from "../netlify/functions/crm-schema-proposal.mjs";
import { PILOT_PROJECT_NAME } from "../netlify/functions/_lib/test-project-pilot.mjs";

const origin = "https://kleanly-business-installer-staging.netlify.app";
const ref = "abcdefghijklmnopqrst";
function request(method = "POST", url = origin + "/.netlify/functions/crm-schema-proposal", headers = {}) {
  return new Request(url, {
    method,
    headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", ...headers },
  });
}
const verifiedReport = {
  mode: "read_only_staging_crm_review",
  state: "schema_ready_for_approval",
  projectVerified: true,
  schemaVerified: true,
  readyForSeparateApproval: true,
  directoryTablesPresent: false,
  existingCrmTables: 0,
  installationEnabled: false,
  schemaInstalled: false,
  writeAttempted: false,
  projectName: PILOT_PROJECT_NAME,
  projectRef: ref,
  region: "eu-central-1",
};

test("schema proposal mirrors the existing committed CRM blueprint", () => {
  const sql = readFileSync(new URL("../blueprint/0001_foundation.sql", import.meta.url), "utf8");
  assert.equal(CRM_BLUEPRINT_VERSION, 1);
  assert.equal(CRM_BLUEPRINT_TABLES.length, 8);
  for (const table of CRM_BLUEPRINT_TABLES) {
    assert.ok(sql.includes("public." + table.name), table.name);
  }
  assert.ok(sql.includes("create schema if not exists kleanly_internal"));
  assert.ok(sql.includes("kleanly_internal.schema_versions"));
  assert.ok(sql.includes("enable row level security"));
  assert.match(sql, /revoke all on.*from anon, authenticated/);
  assert.match(sql, /if to_regclass\('public.cleaners'\) is not null/);
  assert.ok(!sql.toLowerCase().includes("drop table"));
});

test("read-only review creates no schema and requires separate future approval", async () => {
  let checks = 0;
  const handler = createCrmSchemaProposalHandler({
    reviewDatabase: async () => { checks++; return Response.json(verifiedReport); },
  });
  const response = await handler(request());
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(checks, 1);
  assert.equal(data.mode, "read_only_crm_schema_proposal");
  assert.equal(data.publicTables.length, 8);
  assert.equal(data.projectRef, ref);
  assert.equal(data.region, "eu-central-1");
  assert.equal(data.rowLevelSecurityIncluded, true);
  assert.equal(data.ownerBootstrapIncluded, false);
  assert.equal(data.customerDataCopied, false);
  assert.equal(data.paidAddonsRequested, false);
  assert.equal(data.readyForOwnerApproval, true);
  assert.equal(data.separateOwnerConfirmationRequired, true);
  assert.equal(data.schemaInstallEnabled, false);
  assert.equal(data.schemaApplied, false);
  assert.equal(data.writeAttempted, false);
});

test("wrong host/origin or method is blocked before database inspection", async () => {
  let checks = 0;
  const handler = createCrmSchemaProposalHandler({
    reviewDatabase: async () => { checks++; return Response.json(verifiedReport); },
  });
  assert.equal((await handler(request("GET"))).status, 405);
  assert.equal((await handler(request("POST", "https://klean.ly/.netlify/functions/crm-schema-proposal"))).status, 403);
  assert.equal((await handler(request("POST", undefined, { Origin: "https://fake.invalid" }))).status, 403);
  assert.equal(checks, 0);
});

test("cannot review unverified, foreign or already modified projects", async () => {
  const variants = [
    { mode: "wrong" }, { state: "existing_schema_needs_review" },
    { state: "database_permission_required" },
    { projectName: "Klean.ly live directory" },
    { projectRef: "not a 20-character ref" },
    { projectVerified: false },
    { schemaVerified: false },
    { readyForSeparateApproval: false },
    { directoryTablesPresent: true },
    { existingCrmTables: 1 },
    { installationEnabled: true },
    { schemaInstalled: true }, { writeAttempted: true },
    { region: null },
  ];
  assert.equal(verifiedForSchemaProposal(verifiedReport), true);
  for (const variant of variants) {
    const candidate = { ...verifiedReport, ...variant };
    assert.equal(verifiedForSchemaProposal(candidate), false,
      JSON.stringify(variant));
    const handler = createCrmSchemaProposalHandler({
      reviewDatabase: async () => Response.json(candidate),
    });
    const response = await handler(request());
    assert.equal(response.status, 409);
    const data = await response.json();
    assert.equal(data.schemaInstallEnabled, false);
    assert.equal(data.schemaApplied, false);
    assert.equal(data.writeAttempted, false);
  }
});

test("failed project checks do not create an approval form", async () => {
  for (const status of [401, 403, 409, 503]) {
    const handler = createCrmSchemaProposalHandler({
      reviewDatabase: async () => new Response(null, { status }),
    });
    const response = await handler(request());
    assert.equal(response.status, 409);
    assert.equal((await response.json()).readyForOwnerApproval, false);
  }
  const handler = createCrmSchemaProposalHandler({
    reviewDatabase: async () => { throw Error("private provider response"); },
  });
  const response = await handler(request());
  assert.equal(response.status, 503);
  assert.doesNotMatch(JSON.stringify(await response.json()), /private provider response/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  verifyCrmDeployLedgers, interpretCrmDeploymentState,
  inspectCrmDeploymentTarget, createCrmDeploymentReadinessHandler,
} from "../netlify/functions/crm-deployment-readiness.mjs";
import { PILOT_PROJECT_NAME, pilotSettings } from
  "../netlify/functions/_lib/test-project-pilot.mjs";
import {
  CRM_SITE_OWNER_EMAIL, CRM_SITE_TEAM_SLUG,
} from "../netlify/functions/_lib/crm-site-pilot.mjs";
import {
  PILOT_CRM_SITE_NAME, PILOT_CRM_SITE_URL,
} from "../netlify/functions/crm-site-proposal.mjs";

const origin = "https://kleanly-business-installer-staging.netlify.app";
const siteId = "c4632a28-a4b0-4e77-a54e-7a8bf05a8882";
const projectRef = "abcdefghijklmnopqrst";
const current = {
  user_id: "pilot-user", connection_id: "pilot-connection",
  connection_status: "connected", email: CRM_SITE_OWNER_EMAIL,
  organization_name: "kleanly test database",
  organization_id: "test-org", organization_slug: "test-org",
  csrf_token: "csrf-private",
};
const settings = pilotSettings({
  KLEANLY_PILOT_OWNER_EMAIL: CRM_SITE_OWNER_EMAIL,
  KLEANLY_PILOT_ORGANIZATION_NAME: current.organization_name,
});
const ledger = {
  status: "created", user_id: current.user_id,
  organization_id: current.organization_id,
  supabase_project_ref: projectRef, netlify_user_id: "netlify-pilot-owner",
  netlify_team_id: "test-team", netlify_team_slug: CRM_SITE_TEAM_SLUG,
  site_name: PILOT_CRM_SITE_NAME, site_id: siteId,
};
const project = {
  status: "created", project_name: PILOT_PROJECT_NAME,
  project_ref: projectRef,
};
const schema = {
  status: "applied", project_ref: projectRef, blueprint_version: 1,
};
const site = {
  id: siteId, name: PILOT_CRM_SITE_NAME, account_id: ledger.netlify_team_id,
  account_slug: CRM_SITE_TEAM_SLUG, custom_domain: null,
  repo: null, build_settings: null, published_deploy: null, deploy_id: null,
};
const team = {
  id: ledger.netlify_team_id, slug: CRM_SITE_TEAM_SLUG,
  type_name: "Free",
};
const empty = {
  state: "empty_site_verified", confirmedFreePlan: true,
  hasExistingDeploy: false, linkedRepository: false, siteEmpty: true,
  readyToPrepareCrmPackage: true,
};
const req = (method = "POST",
  url = origin + "/.netlify/functions/crm-deployment-readiness",
  headers = {}) => new Request(url, {
    method,
    headers: {
      Origin: origin, "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": current.csrf_token,
      ...headers,
    },
  });
function createHandler(overrides = {}) {
  return createCrmDeploymentReadinessHandler({
    getMode: () => "permanent",
    getSession: async () => current,
    getSettings: () => settings,
    getSiteLedger: async () => ledger,
    getProjectLedger: async () => project,
    getSchemaLedger: async () => schema,
    getNetlifyGrant: async () => ({
      accessToken: "private-test-netlify-token",
      netlifyAccountEmail: CRM_SITE_OWNER_EMAIL,
      netlifyUserId: ledger.netlify_user_id,
    }),
    inspectTarget: async () => empty,
    ...overrides,
  });
}

test("deployment inspection never trusts a browser site ID: all ledgers must match", () => {
  assert.equal(verifyCrmDeployLedgers(current, ledger, project, schema), true);
  for (const change of [
    { status: "submitted" }, { site_id: "not-a-uuid" },
    { user_id: "different-user" }, { organization_id: "live-org" },
    { netlify_team_slug: "live-kleanly" },
    { netlify_team_id: "bad/team" }, { netlify_user_id: "" },
    { site_name: "klean.ly" }, { supabase_project_ref: "00000000000000000000" },
  ]) {
    assert.equal(verifyCrmDeployLedgers(current,
      { ...ledger, ...change }, project, schema), false);
  }
  assert.equal(verifyCrmDeployLedgers(current, ledger,
    { ...project, project_name: "Live Klean.ly" }, schema), false);
  assert.equal(verifyCrmDeployLedgers(current, ledger,
    { ...project, status: "unknown" }, schema), false);
  assert.equal(verifyCrmDeployLedgers(current, ledger, project,
    { ...schema, status: "reserved" }), false);
  assert.equal(verifyCrmDeployLedgers(current, ledger, project,
    { ...schema, blueprint_version: 2 }), false);
});

test("connected test Netlify team, site, and deploy history are only GET requests", async () => {
  const seen = [];
  const report = await inspectCrmDeploymentTarget("private-test-netlify-token",
    ledger, async (url, options) => {
      seen.push(url);
      assert.equal(options.method, "GET");
      assert.equal(options.body, undefined);
      assert.equal(options.headers.Authorization, "Bearer private-test-netlify-token");
      if (url.endsWith("/accounts/test-team")) return Response.json(team);
      if (url.endsWith("/sites/" + siteId)) return Response.json(site);
      if (url.endsWith("/sites/" + siteId + "/deploys?per_page=1")) {
        return Response.json([]);
      }
      throw Error("Unexpected endpoint: " + url);
    });
  assert.deepEqual(seen, [
    "https://api.netlify.com/api/v1/accounts/test-team",
    "https://api.netlify.com/api/v1/sites/" + siteId,
    "https://api.netlify.com/api/v1/sites/" + siteId + "/deploys?per_page=1",
  ]);
  assert.deepEqual(report, empty);
});

test("foreign team, foreign site, custom domain and malformed deployments fail closed", () => {
  for (const mismatch of [
    { ...site, id: "c275509f-2fe2-4fb7-a797-39de7f2b22d4" },
    { ...site, account_id: "main-kleanly-live-account" },
    { ...site, name: "klean.ly" },
    { ...site, custom_domain: "klean.ly" },
    { ...site, account_slug: "main-team" },
  ]) {
    assert.throws(() => interpretCrmDeploymentState(mismatch, team, [], ledger));
  }
  assert.throws(() => interpretCrmDeploymentState(site,
    { ...team, slug: "main-team" }, [], ledger));
  assert.throws(() => interpretCrmDeploymentState(site, team, { results: [] }, ledger));
  assert.throws(() => interpretCrmDeploymentState(site, team, [{ no_id: 1 }], ledger));
});

test("existing deploy, linked Git repository or paid plan blocks blank-site readiness", () => {
  const deployed = interpretCrmDeploymentState(site, team,
    [{ id: "existing-deploy" }], ledger);
  assert.equal(deployed.state, "existing_deployment_review_required");
  assert.equal(deployed.readyToPrepareCrmPackage, false);
  const published = interpretCrmDeploymentState(
    { ...site, published_deploy: { id: "published" } }, team, [], ledger);
  assert.equal(published.hasExistingDeploy, true);
  const linked = interpretCrmDeploymentState(
    { ...site, build_settings: { repo_url: "https://github.com/some/repo" } },
    team, [], ledger);
  assert.equal(linked.linkedRepository, true);
  assert.equal(linked.state, "repository_review_required");
  const paid = interpretCrmDeploymentState(site,
    { ...team, type_name: "Pro" }, [], ledger);
  assert.equal(paid.confirmedFreePlan, false);
  assert.equal(paid.state, "plan_review_required");
  assert.equal(paid.readyToPrepareCrmPackage, false);
});

test("successful staging readiness confirms only an empty host, not a packaged CRM", async () => {
  const response = await createHandler()(req());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "read_only_crm_deployment_readiness");
  assert.equal(body.state, "empty_site_verified");
  assert.equal(body.siteUrl, PILOT_CRM_SITE_URL);
  assert.equal(body.teamSlug, CRM_SITE_TEAM_SLUG);
  assert.equal(body.siteVerified, true);
  assert.equal(body.installedCrmSchema, true);
  assert.equal(body.readyToPrepareCrmPackage, true);
  assert.equal(body.crmAppPackageReady, false);
  assert.equal(body.appDeployed, false);
  assert.equal(body.deploymentEnabled, false);
  assert.equal(body.deploymentAttempted, false);
  assert.equal(body.websiteModified, false);
  assert.equal(body.ownerCreated, false);
  assert.equal(body.emailSent, false);
  assert.doesNotMatch(JSON.stringify(body), /private-test-netlify-token|csrf-private|pilot-connection/);
});

test("foreign host, request origin, CSRF, user or auth mode never reads provider", async () => {
  let reads = 0;
  const handler = createHandler({
    getSiteLedger: async () => { reads++; throw Error("should not read"); },
  });
  assert.equal((await handler(req("GET"))).status, 405);
  assert.equal((await handler(req("POST",
    "https://klean.ly/.netlify/functions/crm-deployment-readiness"))).status, 403);
  assert.equal((await handler(req("POST", undefined, {
    Origin: "https://attacker.example",
  }))).status, 403);
  assert.equal((await handler(req("POST", undefined, {
    "X-CSRF-Token": "incorrect",
  }))).status, 403);
  assert.equal((await createHandler({
    getSession: async () => ({ ...current, email: "other@example.test" }),
    getSiteLedger: async () => { reads++; throw Error("should not read"); },
  })(req())).status, 403);
  assert.equal((await createHandler({
    getMode: () => "temporary",
    getSiteLedger: async () => { reads++; throw Error("should not read"); },
  })(req())).status, 503);
  assert.equal(reads, 0);
});

test("site ledger and OAuth identity must match before Netlify GET", async () => {
  let calls = 0;
  const a = await createHandler({
    getSiteLedger: async () => ({ ...ledger, status: "unknown" }),
    getNetlifyGrant: async () => { calls++; throw Error("should not fetch"); },
  })(req());
  assert.equal(a.status, 409);
  assert.equal(calls, 0);
  const b = await createHandler({
    getNetlifyGrant: async () => ({
      netlifyAccountEmail: "live@example.test",
      netlifyUserId: ledger.netlify_user_id,
      accessToken: "private-test-token",
    }),
    inspectTarget: async () => { calls++; throw Error("should not fetch"); },
  })(req());
  assert.equal(b.status, 403);
  assert.equal(calls, 0);
  const c = await createHandler({
    getNetlifyGrant: async () => ({
      netlifyAccountEmail: CRM_SITE_OWNER_EMAIL,
      netlifyUserId: "different-netlify-user",
      accessToken: "private-test-token",
    }),
    inspectTarget: async () => { calls++; throw Error("should not fetch"); },
  })(req());
  assert.equal(c.status, 403);
  assert.equal(calls, 0);
});

test("site requires review when already deployed; never creates a second deploy", async () => {
  const response = await createHandler({
    inspectTarget: async () => ({
      ...empty, state: "existing_deployment_review_required",
      hasExistingDeploy: true, siteEmpty: false,
      readyToPrepareCrmPackage: false,
    }),
  })(req());
  const body = await response.json();
  assert.equal(body.siteHasExistingDeployment, true);
  assert.equal(body.readyToPrepareCrmPackage, false);
  assert.equal(body.deploymentAttempted, false);
  assert.equal(body.appDeployed, false);
});

test("mobile staging has read-only deployment review and NO deploy button", () => {
  const html = readFileSync(new URL("../installer/index.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../installer/app.mjs", import.meta.url), "utf8");
  assert.match(html, /id="review-crm-deployment" class="action-button" disabled/);
  assert.match(html, /id="crm-deployment-result"/);
  assert.match(js, /byId\("review-crm-deployment"\)\.addEventListener/);
  assert.match(js, /\.netlify\/functions\/crm-deployment-readiness/);
  assert.doesNotMatch(html, /id="deploy-one-crm-app"/);
});

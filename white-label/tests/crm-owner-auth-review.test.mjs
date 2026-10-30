import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  OWNER_AUTH_REDIRECT, AUTH_MANAGEMENT_API,
  summariseOwnerAuthConfig, inspectOwnerAuthConfig,
  verifyFirstPilotAppDeploy, createOwnerAuthSetupReviewHandler,
} from "../netlify/functions/crm-owner-auth-review.mjs";
import { PILOT_PROJECT_NAME, pilotSettings } from
  "../netlify/functions/_lib/test-project-pilot.mjs";
import { PILOT_CRM_SITE_URL } from
  "../netlify/functions/crm-site-proposal.mjs";
import { CRM_SITE_OWNER_EMAIL } from
  "../netlify/functions/_lib/crm-site-pilot.mjs";

const origin = "https://kleanly-business-installer-staging.netlify.app";
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
const owner = {
  mode: "staging_owner_login_readiness",
  state: "owner_setup_can_be_prepared",
  projectVerified: true,
  projectName: PILOT_PROJECT_NAME, projectRef,
  region: "eu-central-1",
  schemaVerified: true, eightTablesConfirmed: true, eightRlsConfirmed: true,
  ownerConfigured: false, staffConfigured: false,
  readyForInvitationDevelopment: true,
  ownerInvitationEnabled: false, ownerCreated: false,
  emailSent: false, writeAttempted: false,
};
const deployment = {
  mode: "read_only_crm_deployment_readiness",
  state: "empty_site_verified",
  siteVerified: true, siteUrl: PILOT_CRM_SITE_URL,
  installedCrmSchema: true, teamSlug: "kleanlytest",
  confirmedFreePlan: true, siteHasExistingDeployment: false,
  gitRepositoryLinked: false, readyToPrepareCrmPackage: true,
  deploymentAttempted: false, appDeployed: false,
  websiteModified: false, ownerCreated: false, emailSent: false,
};
const rawAuth = {
  site_url: "http://localhost:3000",
  uri_allow_list: "",
  disable_signup: false,
  external_email_enabled: true,
  // The API can return private SMTP and OAuth fields; never expose any of these.
  smtp_pass: "PRIVATE_SMTP_PASSWORD_NEVER_RETURN",
  external_google_secret: "PRIVATE_OAUTH_SECRET_NEVER_RETURN",
};
function request(method = "POST",
  url = origin + "/.netlify/functions/crm-owner-auth-review", headers = {}) {
  return new Request(url, {
    method,
    headers: {
      Origin: origin, "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": current.csrf_token,
      ...headers,
    },
  });
}
function handler(overrides = {}) {
  return createOwnerAuthSetupReviewHandler({
    getSession: async () => current,
    getMode: () => "permanent",
    getSettings: () => settings,
    reviewOwner: async () => Response.json(owner),
    reviewDeployment: async () => Response.json(deployment),
    getGrant: async () => "private-test-supabase-management-grant",
    checkAuthConfig: async () => ({
      permitted: true,
      ...summariseOwnerAuthConfig(rawAuth),
    }),
    ...overrides,
  });
}

test("Supabase Auth review inspects GET-only Management API and strips all secrets", async () => {
  let calls = 0;
  const result = await inspectOwnerAuthConfig(projectRef,
    "private-test-supabase-management-grant", async (url, options) => {
      calls++;
      assert.equal(url, AUTH_MANAGEMENT_API + projectRef + "/config/auth");
      assert.equal(options.method, "GET");
      assert.equal(options.body, undefined);
      assert.equal(options.headers.Authorization,
        "Bearer private-test-supabase-management-grant");
      return Response.json(rawAuth);
    });
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    permitted: true,
    siteUrlCorrect: false, callbackAllowlisted: false,
    emailProviderEnabled: true, publicSignupsDisabled: false,
    authSettingsReadyForLaterReview: false,
  });
  assert.equal(JSON.stringify(result).includes("PRIVATE_"), false);
});

test("auth:read permission errors are reported without raw provider data", async () => {
  const reply = await inspectOwnerAuthConfig(projectRef, "valid-fake-token", async () =>
    new Response("", { status: 403 })
  );
  assert.deepEqual(reply, {
    permitted: false, reason: "auth_read_permission_required",
  });
  await assert.rejects(inspectOwnerAuthConfig(projectRef, "valid-fake-token",
    async () => new Response("", { status: 429 })));
  await assert.rejects(inspectOwnerAuthConfig("wrong/project", "valid-fake-token",
    async () => { throw Error("should never fetch"); }));
});

test("the Site URL and Auth callback require explicit exact HTTPS URLs", () => {
  const configured = {
    site_url: PILOT_CRM_SITE_URL,
    uri_allow_list: OWNER_AUTH_REDIRECT,
    external_email_enabled: true,
    disable_signup: true,
  };
  assert.deepEqual(summariseOwnerAuthConfig(configured), {
    siteUrlCorrect: true, callbackAllowlisted: true,
    emailProviderEnabled: true, publicSignupsDisabled: true,
    authSettingsReadyForLaterReview: true,
  });
  assert.equal(summariseOwnerAuthConfig({
    ...configured, site_url: PILOT_CRM_SITE_URL + ".evil.test",
  }).siteUrlCorrect, false);
  assert.equal(summariseOwnerAuthConfig({
    ...configured, site_url: "http://kleanly-business-crm-pilot.netlify.app",
  }).siteUrlCorrect, false);
  assert.equal(summariseOwnerAuthConfig({
    ...configured, uri_allow_list: "https://*.netlify.app/**",
  }).callbackAllowlisted, false);
  assert.equal(summariseOwnerAuthConfig({
    ...configured, uri_allow_list: OWNER_AUTH_REDIRECT + "/malicious",
  }).callbackAllowlisted, false);
  assert.equal(summariseOwnerAuthConfig({
    ...configured, uri_allow_list: "https://other.example/auth/callback, " +
      OWNER_AUTH_REDIRECT,
  }).callbackAllowlisted, true);
  assert.throws(() => summariseOwnerAuthConfig({
    ...configured, disable_signup: "true",
  }));
  assert.throws(() => summariseOwnerAuthConfig({
    ...configured, uri_allow_list: ["https://example.com"],
  }));
  assert.throws(() => summariseOwnerAuthConfig({
    ...configured, external_email_enabled: null,
  }));
});

test("staging review describes configuration work without enabling invitation", async () => {
  const response = await handler()(request());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "read_only_crm_owner_auth_setup");
  assert.equal(body.state, "auth_url_configuration_needed");
  assert.equal(body.ownerEmail, CRM_SITE_OWNER_EMAIL);
  assert.equal(body.proposedLoginUrl, PILOT_CRM_SITE_URL);
  assert.equal(body.requiredCallbackUrl, OWNER_AUTH_REDIRECT);
  assert.equal(body.projectVerified, true);
  assert.equal(body.websiteVerified, true);
  assert.equal(body.siteUrlCorrect, false);
  assert.equal(body.callbackAllowlisted, false);
  assert.equal(body.publicSignupsDisabled, false);
  assert.equal(body.emailProviderEnabled, true);
  assert.equal(body.crmAppDeployed, false);
  assert.equal(body.invitationEnabled, false);
  assert.equal(body.ownerCreated, false);
  assert.equal(body.emailSent, false);
  assert.equal(body.databaseModified, false);
  assert.equal(body.websiteModified, false);
  assert.equal(body.writeAttempted, false);
  assert.doesNotMatch(JSON.stringify(body),
    /PRIVATE_|private-test-supabase-management-grant|csrf-private|pilot-connection/);
});

test("configured redirects still cannot send an invitation until CRM is deployed", async () => {
  const reply = await handler({
    checkAuthConfig: async () => ({
      permitted: true,
      ...summariseOwnerAuthConfig({
        site_url: PILOT_CRM_SITE_URL,
        uri_allow_list: OWNER_AUTH_REDIRECT,
        external_email_enabled: true, disable_signup: true,
      }),
    }),
  })(request());
  const body = await reply.json();
  assert.equal(body.state, "auth_settings_checked_waiting_for_crm_deploy");
  assert.equal(body.invitationEnabled, false);
  assert.equal(body.crmAppDeployed, false);
  assert.equal(body.emailSent, false);
});

test("insufficient auth permissions produce safe read-only guidance", async () => {
  const response = await handler({
    checkAuthConfig: async () => ({
      permitted: false, reason: "auth_read_permission_required",
    }),
  })(request());
  const body = await response.json();
  assert.equal(body.state, "auth_read_permission_required");
  assert.equal(body.authSettingsRead, false);
  assert.equal(body.invitationEnabled, false);
  assert.equal(body.emailSent, false);
});

test("existing owner, unrelated project or changed site block further Auth access", async () => {
  for (const changes of [
    { reviewOwner: async () => Response.json({ ...owner, ownerConfigured: true,
      state: "owner_already_present", readyForInvitationDevelopment: false }) },
    { reviewOwner: async () => Response.json({ ...owner, projectRef: "wrong!" }) },
    { reviewOwner: async () => Response.json({ ...owner, eightRlsConfirmed: false }) },
    { reviewOwner: async () => Response.json({ ...owner, writeAttempted: true }) },
    { reviewDeployment: async () => Response.json({
      ...deployment, siteUrl: "https://klean.ly",
    }) },
    { reviewDeployment: async () => Response.json({
      ...deployment, siteHasExistingDeployment: true, state: "existing_deployment_review_required",
      readyToPrepareCrmPackage: false,
    }) },
    { reviewDeployment: async () => Response.json({ ...deployment, appDeployed: true }) },
  ]) {
    let grantCalls = 0, authCalls = 0;
    const response = await handler({
      getGrant: async () => { grantCalls++; return "private-test-token"; },
      checkAuthConfig: async () => { authCalls++; throw Error("must not fetch"); },
      ...changes,
    })(request());
    const body = await response.json();
    assert.equal(body.invitationEnabled, false);
    assert.equal(body.emailSent, false);
    assert.equal(grantCalls, 0);
    assert.equal(authCalls, 0);
  }
});

test("CSRF, staging host, origin, owner identity and HTTP method are enforced", async () => {
  let preflightCalls = 0;
  const check = handler({
    reviewOwner: async () => { preflightCalls++; throw Error("must not run"); },
  });
  assert.equal((await check(request("GET"))).status, 405);
  assert.equal((await check(request("POST",
    "https://klean.ly/.netlify/functions/crm-owner-auth-review"))).status, 403);
  assert.equal((await check(request("POST", undefined,
    { Origin: "https://attacker.example" }))).status, 403);
  assert.equal((await check(request("POST", undefined,
    { "X-CSRF-Token": "wrong" }))).status, 403);
  assert.equal((await handler({
    getSession: async () => ({ ...current, email: "different@example.org" }),
    reviewOwner: async () => { preflightCalls++; throw Error("must not run"); },
  })(request())).status, 403);
  assert.equal(preflightCalls, 0);
});

test("mobile installer contains only a read-only owner-login review action", () => {
  const html = readFileSync(new URL("../installer/index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../installer/app.mjs", import.meta.url), "utf8");
  assert.match(html, /id="review-owner-auth-setup" class="action-button" disabled/);
  assert.match(html, /id="owner-auth-setup-result"/);
  assert.match(app, /byId\("review-owner-auth-setup"\)\.addEventListener/);
  assert.match(app, /\.netlify\/functions\/crm-owner-auth-review/);
  assert.doesNotMatch(html, /id="invite-one-crm-owner"/);
  assert.doesNotMatch(app, /\.netlify\/functions\/crm-owner-invite/);
});


const actualTestProjectRef = "nlupgjwcyivepzggffss";
const actualPilotSiteId = "c4632a28-a4b0-4e77-a54e-7a8bf05a8882";
const confirmedFirstDeploy = {
  status: "ready", deploy_id: "confirmed-test-deploy-id",
  supabase_project_ref: actualTestProjectRef,
  netlify_site_id: actualPilotSiteId,
  netlify_team_id: "test-team",
  netlify_user_id: "test-netlify-user",
  source_hash: "a".repeat(64), archive_hash: "b".repeat(64),
};
const confirmedSite = {
  status: "created",
  site_id: actualPilotSiteId,
  netlify_team_id: "test-team",
  netlify_user_id: "test-netlify-user",
  netlify_team_slug: "kleanlytest",
  supabase_project_ref: actualTestProjectRef,
};
function liveDeployChecks(overrides={}) {
  const actions=[];
  return {
    actions,
    services:{
      readAttempt: async () => {actions.push("read_attempt");return confirmedFirstDeploy;},
      readSite: async () => {actions.push("read_site");return confirmedSite;},
      getNetlifyGrant: async () => {actions.push("read_grant");return {
        netlifyAccountEmail: CRM_SITE_OWNER_EMAIL,
        netlifyUserId: "test-netlify-user", accessToken: "never-expose-private-token",
      };},
      checkDeploy: async (token,id) => {
        actions.push("provider_get");
        assert.equal(token,"never-expose-private-token");
        assert.equal(id,confirmedFirstDeploy.deploy_id);
        return {ready:true,state:"ready",deployId:id};
      },
      ...overrides,
    },
  };
}

test("first CRM app is verified through exact one-time ledger and Netlify GET, never a site URL alone", async () => {
  const {actions,services}=liveDeployChecks();
  assert.equal(await verifyFirstPilotAppDeploy(current,actualTestProjectRef,services),true);
  assert.deepEqual(actions,["read_attempt","read_site","read_grant","provider_get"]);
});

test("unverified, foreign and uncertain deployments cannot pass the owner preflight", async () => {
  const cases=[
    {readAttempt:async()=>null},
    {readAttempt:async()=>({...confirmedFirstDeploy,status:"submitted"})},
    {readAttempt:async()=>({...confirmedFirstDeploy,status:"unknown"})},
    {readAttempt:async()=>({...confirmedFirstDeploy,netlify_site_id:"foreign"})},
    {readAttempt:async()=>({...confirmedFirstDeploy,supabase_project_ref:"otherproject1234567890"})},
    {readAttempt:async()=>({...confirmedFirstDeploy,source_hash:"bad"})},
    {readSite:async()=>({...confirmedSite,netlify_team_slug:"production"})},
    {readSite:async()=>({...confirmedSite,netlify_user_id:"other-user"})},
    {getNetlifyGrant:async()=>({netlifyAccountEmail:"other@example.com",netlifyUserId:"test-netlify-user",accessToken:"fake"})},
    {checkDeploy:async()=>({ready:false,state:"building",deployId:confirmedFirstDeploy.deploy_id})},
    {checkDeploy:async()=>({ready:true,state:"ready",deployId:"other-deploy"})},
  ];
  for(const extra of cases){
    const {services}=liveDeployChecks(extra);
    assert.equal(await verifyFirstPilotAppDeploy(current,actualTestProjectRef,services),false);
  }
  const {services}=liveDeployChecks();
  assert.equal(await verifyFirstPilotAppDeploy(current,"wrong/project",services),false);
});

const alreadyDeployedSite = {
  ...deployment, state: "existing_deployment_review_required",
  siteHasExistingDeployment:true, readyToPrepareCrmPackage:false,
};
const authReady = {
  site_url:PILOT_CRM_SITE_URL, uri_allow_list:OWNER_AUTH_REDIRECT,
  disable_signup:true, external_email_enabled:true,
};

test("after verified ONE deploy, owner Auth review advances to email/callback preflight without sending", async () => {
  let checks=0;
  const response=await handler({
    reviewDeployment:async()=>Response.json(alreadyDeployedSite),
    verifyAppDeploy:async()=>{checks++;return true;},
    checkAuthConfig:async()=>({permitted:true,...summariseOwnerAuthConfig(authReady)}),
  })(request());
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(checks,1);
  assert.equal(body.state,"auth_settings_checked_waiting_for_invite_review");
  assert.equal(body.crmAppDeployed,true);
  assert.equal(body.authSettingsRead,true);
  assert.equal(body.invitationEnabled,false);
  assert.equal(body.emailSent,false);
  assert.equal(body.ownerCreated,false);
  assert.equal(body.writeAttempted,false);
  assert.match(body.note,/callback/i);
});

test("a verified deployment with incorrect Auth URLs still requires configuration", async () => {
  const response=await handler({
    reviewDeployment:async()=>Response.json(alreadyDeployedSite),
    verifyAppDeploy:async()=>true,
  })(request());
  const body=await response.json();
  assert.equal(body.state,"auth_url_configuration_needed");
  assert.equal(body.crmAppDeployed,true);
  assert.equal(body.siteUrlCorrect,false);
  assert.equal(body.callbackAllowlisted,false);
  assert.equal(body.invitationEnabled,false);
});

test("a deployed site without the exact verified first deploy is blocked before Auth access", async () => {
  let reads=0;
  const response=await handler({
    reviewDeployment:async()=>Response.json(alreadyDeployedSite),
    verifyAppDeploy:async()=>false,
    getGrant:async()=>{reads++;throw Error("must not read Auth provider");},
    checkAuthConfig:async()=>{reads++;throw Error("must not read Auth provider");},
  })(request());
  const body=await response.json();
  assert.equal(body.state,"website_needs_review");
  assert.equal(reads,0);
  assert.equal(body.invitationEnabled,false);
  assert.equal(body.emailSent,false);
});

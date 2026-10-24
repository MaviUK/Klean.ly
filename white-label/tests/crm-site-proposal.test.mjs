import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { encryptTokens } from "../netlify/functions/_lib/connection-vault.mjs";
import { netlifyTokenBinding } from "../netlify/functions/_lib/netlify-connection-store.mjs";
import { PILOT_PROJECT_NAME, pilotSettings } from
  "../netlify/functions/_lib/test-project-pilot.mjs";
import {
  PILOT_CRM_SITE_NAME, PILOT_CRM_SITE_URL,
  parseNetlifyTeams, parseNetlifyMatchingSites, inspectCrmNetlifySite,
  loadVerifiedNetlifyPilotGrant, createCrmSiteProposalHandler,
} from "../netlify/functions/crm-site-proposal.mjs";

const origin = "https://kleanly-business-installer-staging.netlify.app";
const current = {
  user_id: "owner-test", csrf_token: "csrf-private-value",
  connection_status: "connected", email: "pilot@example.test",
  organization_name: "pilot org", organization_slug: "pilot-org",
  organization_id: "pilot-org-id", connection_id: "connected-id",
};
const allowlist = pilotSettings({
  KLEANLY_PILOT_OWNER_EMAIL: current.email,
  KLEANLY_PILOT_ORGANIZATION_NAME: current.organization_name,
});
const ownerReadiness = {
  mode: "staging_owner_login_readiness",
  state: "owner_setup_can_be_prepared",
  projectVerified: true, schemaVerified: true,
  readyForInvitationDevelopment: true,
  eightTablesConfirmed: true, eightRlsConfirmed: true,
  ownerInvitationEnabled: false, ownerConfigured: false,
  staffConfigured: false, writeAttempted: false,
  projectName: PILOT_PROJECT_NAME,
  projectRef: "abcdefghijklmnopqrst",
};
const teams = [{id:"test-team-1",slug:"pilot-team",name:"My Test Team",plan:"Free"}];
const inspected = {accounts:teams,existingSitesVisibleToUser:[]};
function request(method = "POST",
  url = origin + "/.netlify/functions/crm-site-proposal", headers = {}) {
  return new Request(url, {
    method, headers:{
      Origin:origin,"Sec-Fetch-Site":"same-origin",
      "X-CSRF-Token":current.csrf_token, ...headers,
    },
  });
}
function handler(overrides = {}) {
  return createCrmSiteProposalHandler({
    getMode: () => "permanent",
    getSession: async () => current,
    getSettings: () => allowlist,
    reviewOwner: async () => Response.json(ownerReadiness),
    getNetlifyGrant: async () => ({
      accessToken: "secret-netlify-bearer-test",
      netlifyAccountEmail: "connected-test@example.test",
    }),
    inspectSite: async () => inspected,
    ...overrides,
  });
}

test("CRM test site name matches the approved fixed hostname", () => {
  assert.equal(PILOT_CRM_SITE_NAME,"kleanly-business-crm-pilot");
  assert.equal(PILOT_CRM_SITE_URL,"https://kleanly-business-crm-pilot.netlify.app");
});

test("provider team and site lists reject malformed data and preserve exact matches", () => {
  assert.deepEqual(parseNetlifyTeams([
    {id:"team-1",slug:"pilot-team",name:"Pilot Team",type_name:"Free"},
  ]),[{id:"team-1",slug:"pilot-team",name:"Pilot Team",plan:"Free"}]);
  assert.throws(() => parseNetlifyTeams([]));
  assert.throws(() => parseNetlifyTeams([{id:"a",slug:"../evil",name:"Broken"}]));
  assert.throws(() => parseNetlifyTeams([
    {id:"a",slug:"team",name:"One"},
    {id:"a",slug:"other",name:"Two"},
  ]));
  assert.deepEqual(parseNetlifyMatchingSites([
    {id:"site-a",name:"some-other-site"},
    {id:"site-b",name:PILOT_CRM_SITE_NAME,account_id:"team-1"},
  ]),[{id:"site-b",siteName:PILOT_CRM_SITE_NAME,accountId:"team-1"}]);
  assert.throws(() => parseNetlifyMatchingSites({sites:[]}));
  assert.throws(() => parseNetlifyMatchingSites([{name:PILOT_CRM_SITE_NAME}]));
});

test("separate Netlify OAuth token only performs read-only provider requests", async () => {
  let n=0;
  const actual=await inspectCrmNetlifySite("staging-test-grant", async(url,options)=>{
    assert.equal(options.method,"GET");
    assert.equal(options.headers.Authorization,"Bearer staging-test-grant");
    assert.ok(!options.body);
    n++;
    if(url==="https://api.netlify.com/api/v1/accounts"){
      return Response.json([{id:"team-1",slug:"test-team",name:"Test",type_name:"Free"}]);
    }
    assert.equal(url,"https://api.netlify.com/api/v1/sites?name="+PILOT_CRM_SITE_NAME+"&per_page=100");
    return Response.json([]);
  });
  assert.equal(n,2);
  assert.equal(actual.accounts.length,1);
  assert.deepEqual(actual.existingSitesVisibleToUser,[]);
});

test("the stored installer Netlify grant must match current provider identity", async () => {
  const key=randomBytes(32);
  const sealed=encryptTokens({accessToken:"private-netlify-token"},
    netlifyTokenBinding(current.user_id,"test-netlify-id"), key);
  const options={
    getConnection:async()=>({
      netlify_user_id:"test-netlify-id",encrypted_token:sealed,status:"connected",
    }),
    getKey:()=>key,
    getProfile:async(token)=>{
      assert.equal(token,"private-netlify-token");
      return {netlifyUserId:"test-netlify-id",email:"pilot-netlify@example.test"};
    },
  };
  const x=await loadVerifiedNetlifyPilotGrant(current,options);
  assert.equal(x.accessToken,"private-netlify-token");
  assert.equal(x.netlifyAccountEmail,"pilot-netlify@example.test");
  await assert.rejects(()=>loadVerifiedNetlifyPilotGrant(current,{
    ...options,getProfile:async()=>({netlifyUserId:"different-user-id",email:"test@example.test"}),
  }),/netlify_identity_mismatch/);
  await assert.rejects(()=>loadVerifiedNetlifyPilotGrant(current,{
    ...options,getConnection:async()=>({netlify_user_id:"test-netlify-id",
      encrypted_token:sealed,status:"reauthorisation_required"}),
  }),/netlify_grant_unavailable/);
});

test("successful proposal contains test Netlify identity, no create claim or billing approval",async()=>{
  const response=await handler()(request());
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(data.mode,"read_only_crm_site_proposal");
  assert.equal(data.proposedSiteUrl,PILOT_CRM_SITE_URL);
  assert.equal(data.ownerEmail,current.email);
  assert.equal(data.connectedNetlifyEmail,"connected-test@example.test");
  assert.equal(data.testNetlifyTeams.length,1);
  assert.equal(data.teamSelectionRequired,true);
  assert.equal(data.globalNameAvailabilityConfirmed,false);
  assert.equal(data.providerBillingApproved,false);
  assert.equal(data.siteCreated,false);
  assert.equal(data.deploymentCreated,false);
  assert.equal(data.invitationSent,false);
  assert.equal(data.readyToCreateSite,false);
  assert.equal(data.writeAttempted,false);
  assert.doesNotMatch(JSON.stringify(data),/secret-netlify-bearer-test|csrf-private-value|connected-id/);
});

test("if Netlify lists an existing matching site, a new-site attempt remains locked", async()=>{
  const response=await handler({
    inspectSite:async()=>({
      accounts:teams,
      existingSitesVisibleToUser:[{id:"site-a",siteName:PILOT_CRM_SITE_NAME,accountId:"test-team-1"}],
    }),
  })(request());
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(data.existingSiteReviewRequired,true);
  assert.equal(data.matchingSitesInConnectedAccount,1);
  assert.equal(data.readyToCreateSite,false);
});

test("no provider access for wrong method, host, origin, CSRF or owner",async()=>{
  let n=0;
  const safe=handler({
    getNetlifyGrant:async()=>{n++;throw Error("Should not be called");},
  });
  assert.equal((await safe(request("GET"))).status,405);
  assert.equal((await safe(request("POST","https://klean.ly/.netlify/functions/crm-site-proposal"))).status,403);
  assert.equal((await safe(request("POST",undefined,{Origin:"https://attacker.example"}))).status,403);
  assert.equal((await safe(request("POST",undefined,{"X-CSRF-Token":"wrong"}))).status,403);
  const wrong=handler({
    getSession:async()=>({...current,email:"other@example.test"}),
    getNetlifyGrant:async()=>{n++;throw Error("No request");},
  });
  assert.equal((await wrong(request())).status,403);
  assert.equal(n,0);
});

test("missing CRM owner readiness, partial RLS or existing owner blocks Netlify inspection",async()=>{
  for(const override of [
    {state:"owner_already_present"}, {ownerConfigured:true},
    {eightRlsConfirmed:false},{schemaVerified:false},
    {projectName:"Klean.ly directory"}, {ownerInvitationEnabled:true},
  ]){
    let n=0;
    const h=handler({
      reviewOwner:async()=>Response.json({...ownerReadiness,...override}),
      getNetlifyGrant:async()=>{n++;throw Error("provider should not be read");},
    });
    const result=await h(request());
    assert.equal(result.status,409);
    assert.equal(n,0);
    assert.equal((await result.json()).siteCreated,false);
  }
});

test("mobile UI only provides a read-only proposal action",()=>{
  const html=readFileSync(new URL("../installer/index.html",import.meta.url),"utf8");
  const js=readFileSync(new URL("../installer/app.mjs",import.meta.url),"utf8");
  assert.match(html,/id="review-crm-site" class="action-button" disabled/);
  assert.match(html,/id="crm-site-proposal-result"/);
  assert.match(js,/\.netlify\/functions\/crm-site-proposal/);
  assert.match(js,/byId\("review-crm-site"\)\.addEventListener/);
  assert.match(html,/id="crm-site-create-form" class="pilot-approval" hidden/);
  assert.match(html,/id="create-one-crm-site" class="action-button" disabled/);
});

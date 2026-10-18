import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PILOT_NETLIFY_SLUG, PILOT_NETLIFY_EMAIL, NETLIFY_FREE_PROJECT_LIMIT,
  validateFreeTestTeam, validateFreeTeamSitePage,
  checkNetlifyFreeTeamCapacity, createCrmFreeSiteCapacityHandler,
} from "../netlify/functions/crm-free-site-capacity.mjs";
import { PILOT_CRM_SITE_URL, PILOT_CRM_SITE_NAME } from
  "../netlify/functions/crm-site-proposal.mjs";
import { pilotSettings } from "../netlify/functions/_lib/test-project-pilot.mjs";

const origin="https://kleanly-business-installer-staging.netlify.app";
const session={
  user_id:"pilot-user", connection_id:"pilot-connection",
  connection_status:"connected", email:PILOT_NETLIFY_EMAIL,
  organization_name:"kleanly test database",
  organization_id:"test-org", organization_slug:"test-org",
  csrf_token:"csrf-test",
};
const settings=pilotSettings({
  KLEANLY_PILOT_OWNER_EMAIL:session.email,
  KLEANLY_PILOT_ORGANIZATION_NAME:session.organization_name,
});
const team={id:"netlify-test-team",slug:PILOT_NETLIFY_SLUG,
  name:"kleanlytest's team",plan:"Free"};
const detail={id:team.id,slug:team.slug,name:team.name,type_name:"Free",
  capabilities:{sites:{used:1,included:500}}};
const proposal={
  mode:"read_only_crm_site_proposal",
  ownerEmail:PILOT_NETLIFY_EMAIL,
  connectedNetlifyEmail:PILOT_NETLIFY_EMAIL,
  proposedSiteName:PILOT_CRM_SITE_NAME,
  proposedSiteUrl:PILOT_CRM_SITE_URL,
  matchingSitesInConnectedAccount:0,
  existingSiteReviewRequired:false,
  testNetlifyTeams:[team],
  siteCreated:false,writeAttempted:false,
};
function request(method="POST",url=origin+"/.netlify/functions/crm-free-site-capacity",headers={}){
  return new Request(url,{method,headers:{
    Origin:origin,"Sec-Fetch-Site":"same-origin",
    "X-CSRF-Token":session.csrf_token,...headers,
  }});
}
function handler(overrides={}){
  return createCrmFreeSiteCapacityHandler({
    getMode:()=>"permanent",getSession:async()=>session,
    getSettings:()=>settings,
    checkSiteProposal:async()=>Response.json(proposal),
    getNetlifyGrant:async()=>({
      accessToken:"private-test-netlify-bearer",
      netlifyAccountEmail:PILOT_NETLIFY_EMAIL,
    }),
    checkCapacity:async()=>({
      accountIsFree:true,team:{name:team.name,slug:team.slug,plan:"Free"},
      currentSites:1,matchingNameInChosenTeam:false,
      teamCapacityAppearsAvailable:true,
    }),
    ...overrides,
  });
}

test("staging test team and Free Plan limit remain fixed",()=>{
  assert.equal(PILOT_NETLIFY_SLUG,"kleanlytest");
  assert.equal(PILOT_NETLIFY_EMAIL,"kleanlytest@gerball.co.uk");
  assert.equal(NETLIFY_FREE_PROJECT_LIMIT,500);
  assert.equal(validateFreeTestTeam(detail,team).providerLimit,500);
  assert.throws(()=>validateFreeTestTeam({...detail,type_name:"Pro"},team));
  assert.throws(()=>validateFreeTestTeam({...detail,id:"someone-else"},team));
  assert.throws(()=>validateFreeTestTeam({...detail,slug:"live-kleanly"},team));
  assert.throws(()=>validateFreeTestTeam({...detail,capabilities:{
    sites:{used:"1",included:500},
  }},team));
});

test("team site list refuses another account, duplicate IDs and malformed data",()=>{
  assert.deepEqual(validateFreeTeamSitePage([
    {id:"test-site",name:"unrelated-example",account_id:team.id,account_slug:team.slug},
  ],team),[{id:"test-site",name:"unrelated-example"}]);
  assert.throws(()=>validateFreeTeamSitePage({sites:[]},team));
  assert.throws(()=>validateFreeTeamSitePage([
    {id:"other",name:"unrelated",account_id:"main-live-team"},
  ],team));
  assert.throws(()=>validateFreeTeamSitePage([
    {id:"site",name:"../attacker",account_id:team.id},
  ],team));
});

test("Netlify OAuth performs GET only on fixed selected test team, never creates a site",async()=>{
  const calls=[];
  const result=await checkNetlifyFreeTeamCapacity("test-netlify-bearer-token",team,{
    fetchFn:async(url,opts)=>{
      calls.push([url,opts]);
      assert.equal(opts.method,"GET");
      assert.equal(opts.headers.Authorization,"Bearer test-netlify-bearer-token");
      assert.equal(opts.body,undefined);
      if(url==="https://api.netlify.com/api/v1/accounts/"+team.id) {
        return Response.json(detail);
      }
      assert.equal(url,"https://api.netlify.com/api/v1/kleanlytest/sites?per_page=100&page=1");
      return Response.json([{
        id:"other-site",name:"other-test-site",
        account_id:team.id,account_slug:team.slug,
      }]);
    },
  });
  assert.equal(calls.length,2);
  assert.equal(result.currentSites,1);
  assert.equal(result.documentedProjectLimit,500);
  assert.equal(result.accountIsFree,true);
  assert.equal(result.teamCapacityAppearsAvailable,true);
  assert.equal(result.matchingNameInChosenTeam,false);
});

test("existing name or documented Free Plan capacity blocks readiness",async()=>{
  const names=Array.from({length:100},(_,i)=>({
    id:"site-"+i,name:"site-"+i,account_id:team.id,
  }));
  const target={id:"target",name:PILOT_CRM_SITE_NAME,account_id:team.id};
  const result=await checkNetlifyFreeTeamCapacity("valid-netlify-token",team,{
    fetchFn:async(url)=>{
      if(url.endsWith("/accounts/"+team.id))return Response.json(detail);
      return Response.json([target]);
    },
  });
  assert.equal(result.matchingNameInChosenTeam,true);
  assert.equal(result.teamCapacityAppearsAvailable,false);

  const pageCall=async(url)=>{
    if(url.endsWith("/accounts/"+team.id))return Response.json(detail);
    const page=Number(new URL(url).searchParams.get("page"));
    if(page<=5)return Response.json(names.map((x)=>({...x,id:x.id+"-"+page})));
    return Response.json([]);
  };
  const full=await checkNetlifyFreeTeamCapacity("valid-netlify-token",team,{fetchFn:pageCall});
  assert.equal(full.currentSites,500);
  assert.equal(full.teamCapacityAppearsAvailable,false);
});

test("provider capability limits can block even below published project count",async()=>{
  const small={...detail,capabilities:{sites:{included:1,used:1}}};
  const value=await checkNetlifyFreeTeamCapacity("valid-netlify-token",team,{
    fetchFn:async(url)=>url.endsWith("/accounts/"+team.id)
      ? Response.json(small)
      : Response.json([]),
  });
  assert.equal(value.currentSites,0);
  assert.equal(value.providerCapabilityAllowsNewSite,false);
  assert.equal(value.teamCapacityAppearsAvailable,false);
});

test("approval-based capacity is read-only; no credit balance or price is invented",async()=>{
  const response=await handler()(request());
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(data.mode,"read_only_crm_free_site_capacity");
  assert.equal(data.confirmedFreePlan,true);
  assert.equal(data.sitesInTeam,1);
  assert.equal(data.documentedFreeProjectLimit,500);
  assert.equal(data.capacityAppearsAvailable,true);
  assert.equal(data.globalNameAvailabilityConfirmed,false);
  assert.equal(data.remainingMonthlyCreditsVerified,false);
  assert.equal(data.priceQuoteProvided,false);
  assert.equal(data.providerCostApprovalRequired,true);
  assert.equal(data.creationEnabled,false);
  assert.equal(data.siteCreated,false);
  assert.equal(data.deploymentCreated,false);
  assert.equal(data.emailSent,false);
  assert.equal(data.writeAttempted,false);
  assert.doesNotMatch(JSON.stringify(data),/private-test-netlify-bearer|csrf-test|pilot-connection/);
});

test("wrong host, origin, CSRF, method, owner or Netlify identity cannot inspect",async()=>{
  let providerCalls=0;
  const validate=handler({checkCapacity:async()=>{providerCalls++;throw Error("unexpected call");}});
  assert.equal((await validate(request("GET"))).status,405);
  assert.equal((await validate(request("POST","https://klean.ly/.netlify/functions/crm-free-site-capacity"))).status,403);
  assert.equal((await validate(request("POST",undefined,{Origin:"https://attacker.example"}))).status,403);
  assert.equal((await validate(request("POST",undefined,{"X-CSRF-Token":"incorrect"}))).status,403);
  assert.equal((await handler({
    getSession:async()=>({...session,email:"someone-else@example.test"}),
    checkCapacity:async()=>{providerCalls++;return null;},
  })(request())).status,403);
  assert.equal((await handler({
    getNetlifyGrant:async()=>({
      accessToken:"private-token",netlifyAccountEmail:"main-live-owner@example.test",
    }),
    checkCapacity:async()=>{providerCalls++;return null;},
  })(request())).status,409);
  assert.equal(providerCalls,0);
});

test("fails closed on paid team, multiple team matches, pre-existing site and partial CRM",async()=>{
  for(const changed of [
    {...proposal,testNetlifyTeams:[{...team,plan:"Pro"}]},
    {...proposal,testNetlifyTeams:[team,team]},
    {...proposal,existingSiteReviewRequired:true,matchingSitesInConnectedAccount:1},
    {...proposal,ownerEmail:"wrong@example.test"},
    {...proposal,siteCreated:true},
    {...proposal,writeAttempted:true},
    {...proposal,mode:"unexpected"},
  ]){
    let calls=0;
    const response=await handler({
      checkSiteProposal:async()=>Response.json(changed),
      checkCapacity:async()=>{calls++;throw Error("must not inspect");},
    })(request());
    assert.equal(response.status,409);
    assert.equal(calls,0);
    assert.equal((await response.json()).siteCreated,false);
  }
});

test("mobile staging UI has one read-only capacity button and no site-create action",()=>{
  const html=readFileSync(new URL("../installer/index.html",import.meta.url),"utf8");
  const app=readFileSync(new URL("../installer/app.mjs",import.meta.url),"utf8");
  assert.match(html,/id="review-crm-capacity" class="action-button" disabled/);
  assert.match(html,/id="crm-capacity-result"/);
  assert.match(app,/\.netlify\/functions\/crm-free-site-capacity/);
  assert.match(app,/byId\("review-crm-capacity"\)\.addEventListener/);
  assert.doesNotMatch(html,/id="create-one-crm-site"/);
});

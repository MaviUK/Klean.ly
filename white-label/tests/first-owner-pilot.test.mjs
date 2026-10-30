import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PILOT_REF,PILOT_OWNER_EMAIL,PILOT_CRM_ORIGIN,PILOT_CALLBACK,
  INVITE_INSTALL_KEY,BIND_INSTALL_KEY,
  INVITE_CONFIRMATION,BIND_CONFIRMATION,
  ASSIGN_FIRST_OWNER_SQL,VERIFY_FIRST_OWNER_SQL,
  assertInvitePreflight,assertAssignmentPreflight,
  inspectOwnerBindingRows,performOnePilotOwnerInvite,
  performOnePilotOwnerAssignment,
} from "../provisioning/first-owner-pilot.mjs";
import {createOwnerPilotLedger} from "../provisioning/control-plane-ledger.mjs";

const approved=(phrase)=>({
  securePortalSessionVerified:true,csrfVerified:true,sameOrigin:true,
  operatorEmail:PILOT_OWNER_EMAIL,targetProjectRef:PILOT_REF,
  confirmation:phrase,explicitConsentRecorded:true,
});
const inviteEvidence={
  projectRef:PILOT_REF,projectRegion:"eu-central-1",schemaVersion:1,crmTables:8,rlsTables:8,
  ownerProfiles:0,teamMembers:0,authUsersTotal:0,authUsersMatchingOwner:0,
  siteUrl:PILOT_CRM_ORIGIN,siteDeployed:true,sitePubliclyReachable:true,
  liveLoginRouteVerified:true,liveCallbackRouteVerified:true,
  siteUrlMatchesAuth:true,exactCallbackAllowlisted:true,
  publicSignupDisabled:true,emailSigninEnabled:true,
  invitationTemplateInstalled:true,senderVerified:true,
  linkedSiteTeamSlug:"kleanlytest",billingFreePlanVerified:true,noPaidAddons:true,
};
const assignmentEvidence={
  projectRef:PILOT_REF,schemaVersion:1,crmTables:8,rlsTables:8,
  ownerProfiles:0,teamMembers:0,invitationStatus:"sent",
  invitationDestination:PILOT_OWNER_EMAIL,
  authUsersTotal:1,authUsersMatchingOwner:1,
  invitedUserConfirmed:true,invitedUserHasPassword:true,
  invitedUserHasSignedIn:true,invitedAtPresent:true,
  callbackVerifiedOnLiveSite:true,
};
const requestId="11111111-1111-4111-8111-111111111111";
const readFile = p => readFileSync(new URL("../"+p,import.meta.url),"utf8");

test("every dependent provider gate fails shut when an installation is incomplete",()=>{
  assert.equal(assertInvitePreflight(inviteEvidence),true);
  assert.equal(assertAssignmentPreflight(assignmentEvidence),true);
  for(const [field,bad] of [
    ["projectRef","not-the-pilot"],["schemaVersion",0],["crmTables",7],
    ["rlsTables",0],["ownerProfiles",1],["teamMembers",1],
    ["authUsersTotal",1],["siteUrl","https://klean.ly"],
    ["siteDeployed",false],["sitePubliclyReachable",false],
    ["liveLoginRouteVerified",false],["liveCallbackRouteVerified",false],
    ["exactCallbackAllowlisted",false],["publicSignupDisabled",false],
    ["senderVerified",false],["invitationTemplateInstalled",false],
    ["noPaidAddons",false],["billingFreePlanVerified",false],
  ]) assert.throws(()=>assertInvitePreflight({...inviteEvidence,[field]:bad}),/preflight_denied/);
  for(const [field,bad] of [
    ["projectRef","other"],["schemaVersion",0],["crmTables",7],["rlsTables",7],
    ["ownerProfiles",1],["teamMembers",1],["invitationStatus","unknown"],
    ["invitationDestination","wrong@example.com"],["authUsersTotal",2],
    ["authUsersMatchingOwner",0],["invitedUserConfirmed",false],
    ["invitedUserHasPassword",false],["invitedUserHasSignedIn",false],
    ["invitedAtPresent",false],["callbackVerifiedOnLiveSite",false],
  ]) assert.throws(()=>assertAssignmentPreflight({...assignmentEvidence,[field]:bad}),/preflight_denied/);
});

function fakeHandlers(kind, {ready=true,reserve=true,submit=true,fail=false,settle=true}={}) {
  const actions=[];
  const funcs={
    readEvidence:async()=>{actions.push("evidence"); return ready? (kind==="invite"?inviteEvidence:assignmentEvidence):{};},
    reserve:async d=>{actions.push("reserve");return reserve?{reserved:true,requestId:d.requestId}:{reserved:false};},
    markSubmitted:async()=>{actions.push("submitted");return submit;},
    settle:async v=>{actions.push("settle:"+v.status);return settle;},
    sendInvitation:async v=>{
      actions.push("send");
      assert.deepEqual(v,{projectRef:PILOT_REF,email:PILOT_OWNER_EMAIL,redirectTo:PILOT_CALLBACK});
      if(fail)throw new Error("Supabase server secret must not leak");
      return {invitationSubmitted:true,user:{id:"super-private"}};
    },
    executeSql:async v=>{
      actions.push("sql");
      assert.equal(v.projectRef,PILOT_REF);
      assert.equal(v.query,ASSIGN_FIRST_OWNER_SQL);
      if(fail)throw new Error("private DB query error");
      return {submitted:true};
    },
    verifyBinding:async v=>{
      actions.push("verify");
      assert.equal(v.projectRef,PILOT_REF);
      assert.equal(v.query,VERIFY_FIRST_OWNER_SQL);
      assert.equal(v.readOnly,true);
      return [{profile_count:1,member_count:1,verified_binding_count:1}];
    },
  };
  return {actions,funcs};
}
const submitInvite=(deps,overrides={})=>performOnePilotOwnerInvite({
  enabled:true,approval:approved(INVITE_CONFIRMATION),requestId,deps,...overrides
});
const submitAssignment=(deps,overrides={})=>performOnePilotOwnerAssignment({
  enabled:true,approval:approved(BIND_CONFIRMATION),requestId,deps,...overrides
});

test("no approval or default-disabled switch makes ZERO network or database calls",async()=>{
  for(const kind of ["invite","bind"]) {
    const {actions,funcs}=fakeHandlers(kind);
    const f=kind==="invite"?performOnePilotOwnerInvite:performOnePilotOwnerAssignment;
    const confirmation=kind==="invite"?INVITE_CONFIRMATION:BIND_CONFIRMATION;
    for (const params of [
      {enabled:false,approval:approved(confirmation)},
      {enabled:true,approval:null},
      {enabled:true,approval:{...approved(confirmation),csrfVerified:false}},
      {enabled:true,approval:{...approved(confirmation),operatorEmail:"other@test.com"}},
      {enabled:true,approval:{...approved(confirmation),sameOrigin:false}},
      {enabled:true,approval:{...approved(confirmation),confirmation:"YES"}},
      {enabled:true,approval:{...approved(confirmation),targetProjectRef:"other"}},
      {enabled:true,approval:{...approved(confirmation),explicitConsentRecorded:false}},
    ]) await assert.rejects(f({...params,deps:funcs,requestId}),/preflight_denied/);
    assert.deepEqual(actions,[]);
  }
});

test("one approved invite reserves FIRST, marks submitted, sends only ONCE and sanitizes output",async()=>{
  const {funcs,actions}=fakeHandlers("invite");
  const result=await submitInvite(funcs);
  assert.deepEqual(actions,["evidence","reserve","submitted","send","settle:sent"]);
  assert.deepEqual(result,{mode:"first_owner_staging_only",state:"invitation_submitted_once",
    projectRef:PILOT_REF,ownerEmail:PILOT_OWNER_EMAIL,automaticRetry:false});
  assert.doesNotMatch(JSON.stringify(result),/super-private|token|secret/i);
});

test("an existing or unknown invite cannot automatically send again",async()=>{
  for(const variant of [
    {reserve:false,expected:["evidence","reserve"]},
    {submit:false,expected:["evidence","reserve","submitted"]},
    {fail:true,expected:["evidence","reserve","submitted","send","settle:unknown"]},
    {settle:false,expected:["evidence","reserve","submitted","send","settle:sent"]},
  ]) {
    const {funcs,actions}=fakeHandlers("invite",variant);
    const result=await submitInvite(funcs);
    assert.deepEqual(actions,variant.expected);
    assert.ok(["already_attempted_manual_review","manual_review_required"].includes(result.state));
  }
});

test("unverified live routes block invitation before even reserving",async()=>{
  const {funcs,actions}=fakeHandlers("invite",{ready:false});
  await assert.rejects(submitInvite(funcs),/preflight_denied/);
  assert.deepEqual(actions,["evidence"]);
});

test("first-owner SQL has atomic guard and no browser-sourced UUID or owner claim",()=>{
  const sql=ASSIGN_FIRST_OWNER_SQL;
  assert.match(sql,/^begin;/);
  assert.match(sql,/commit;$/);
  assert.match(sql,/pg_advisory_xact_lock/);
  assert.match(sql,/into strict verified_uid/);
  assert.match(sql,/from auth\.users/);
  assert.match(sql,/invited_at is not null/);
  assert.match(sql,/email_confirmed_at is not null/);
  assert.match(sql,/last_sign_in_at is not null/);
  assert.match(sql,/encrypted_password is not null/);
  assert.match(sql,/missing_row_security/);
  assert.match(sql,/where lower\(email\) = 'kleanlytest@gerball\.co\.uk'/);
  assert.match(sql,/insert into public\.business_profile/);
  assert.match(sql,/insert into public\.team_members/);
  assert.match(sql,/role, is_active/);
  assert.match(sql,/unexpected_auth_users/);
  assert.match(sql,/wrong_database/);
  assert.doesNotMatch(sql,/create\s+user|drop\s+table|update\s+auth\.users/i);
  assert.doesNotMatch(sql,/user_metadata|raw_user_meta_data|user_id\s*=\s*\$\{|\bpublic\b\s*execute/i);
});

test("one approved owner binding is atomic and verifies exact owner membership",async()=>{
  const {funcs,actions}=fakeHandlers("bind");
  const result=await submitAssignment(funcs);
  assert.deepEqual(actions,["evidence","reserve","submitted","sql","verify","settle:applied"]);
  assert.equal(result.state,"first_owner_verified");
  assert.equal(result.automaticRetry,false);
  assert.doesNotMatch(JSON.stringify(result),/super-private|token|secret/i);
  assert.equal(inspectOwnerBindingRows([{profile_count:1,member_count:1,verified_binding_count:1}]),true);
  assert.equal(inspectOwnerBindingRows({result:[{profile_count:"1",member_count:"0",verified_binding_count:"0"}]}),false);
  assert.throws(()=>inspectOwnerBindingRows({result:[{profile_count:-1}]}),/preflight_denied/);
});

test("owner binding unknown outcome never silently retries",async()=>{
  const {funcs,actions}=fakeHandlers("bind",{fail:true});
  const result=await submitAssignment(funcs);
  assert.deepEqual(actions,["evidence","reserve","submitted","sql","settle:unknown"]);
  assert.equal(result.state,"manual_review_required");
  assert.equal(result.automaticRetry,false);
});

test("read-only ledger never clears its uniqueness lock when OAuth disconnects",async()=>{
  const sql=readFile("provisioning/control-plane-owner-ledger.proposed.sql");
  assert.match(sql,/NOT AN ACTIVE MIGRATION/);
  assert.match(sql,/operation_key text not null unique/);
  assert.match(sql,/status in \('reserved','submitted','sent','applied','unknown'\)/);
  assert.doesNotMatch(sql,/references\s+portal_|on delete cascade|drop\s+table/i);
  const migration=readFile("netlify.toml");
  assert.match(migration,/publish = "installer"/);
  assert.doesNotMatch(migration,/publish = "provisioning"/);
});

test("ledger uses only parameterised queries and never accepts a different operator",async()=>{
  const fakeUser={user_id:"portal-user",organization_id:"portal-org",
    email:PILOT_OWNER_EMAIL,connection_status:"connected"};
  const statements=[];
  const db=async()=>({pool:{query:async(sql,params)=>{
    statements.push({sql,params});
    if(sql.startsWith("INSERT"))return {rows:[{request_id:requestId}]};
    return {rows:[{request_id:requestId}]};
  }}});
  const ledger=createOwnerPilotLedger(fakeUser,{database:db});
  const input={key:INVITE_INSTALL_KEY,requestId,projectRef:PILOT_REF,ownerEmail:PILOT_OWNER_EMAIL};
  assert.deepEqual(await ledger.reserve(input),{reserved:true,requestId});
  assert.equal(await ledger.markSubmitted({key:INVITE_INSTALL_KEY,requestId}),true);
  assert.equal(await ledger.settle({key:INVITE_INSTALL_KEY,requestId,status:"sent"}),true);
  assert.equal(statements.length,3);
  for(const entry of statements) {
    assert.match(entry.sql,/\$1/);
    assert.doesNotMatch(entry.sql,/portal-user|portal-org/);
    assert.ok(entry.params.includes(requestId));
  }
  const prior=statements.length;
  await assert.rejects(ledger.reserve({...input,projectRef:"other"}));
  await assert.rejects(ledger.settle({key:INVITE_INSTALL_KEY,requestId,status:"applied"}));
  await assert.rejects(ledger.markSubmitted({key:"unexpected-key",requestId}));
  assert.equal(statements.length,prior);
  assert.throws(()=>createOwnerPilotLedger({...fakeUser,email:"other@example.com"},{database:db}));
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  READ_PILOT_AUTH_USERS_SQL,
  parsePilotAuthUsers,
  createPilotManagementAdapter,
  createPilotInviteAdminAdapter,
} from "../provisioning/server-adapters.mjs";
import {
  PILOT_REF,PILOT_OWNER_EMAIL,PILOT_CALLBACK,ASSIGN_FIRST_OWNER_SQL,
  VERIFY_FIRST_OWNER_SQL,
} from "../provisioning/first-owner-pilot.mjs";

test("read-only Auth inventory never exposes user UUID or password hash",()=>{
  const summary=parsePilotAuthUsers([{
    total_users:"1",matching_owner:"1",completed_owner:"1",
    user_id:"private-id",encrypted_password:"private-password",
  }]);
  assert.deepEqual(summary,{authUsersTotal:1,authUsersMatchingOwner:1,
    invitedUserConfirmed:true,invitedUserHasPassword:true,
    invitedUserHasSignedIn:true,invitedAtPresent:true});
  assert.doesNotMatch(JSON.stringify(summary),/private/);
  for (const invalid of [
    [{total_users:2,matching_owner:3,completed_owner:1}],
    [{total_users:1,matching_owner:1,completed_owner:2}],
    [{total_users:-1,matching_owner:1,completed_owner:1}],
    [],[{},{}],null,
  ]) assert.throws(()=>parsePilotAuthUsers(invalid));
  assert.match(READ_PILOT_AUTH_USERS_SQL,/from auth\.users/);
  assert.doesNotMatch(READ_PILOT_AUTH_USERS_SQL,/\bselect\s+\*/i);
});

test("server management adapter issues only audited allowlisted reads and one exact SQL",async()=>{
  const calls=[];
  const adapter=createPilotManagementAdapter({
    getAccessToken:async()=>"secret-mgmt-oauth-token-never-returned",
    fetchFn:async(url,opts)=>{
      calls.push({url,opts});
      const q=JSON.parse(opts.body);
      if (q.query===READ_PILOT_AUTH_USERS_SQL) return Response.json([
        {total_users:0,matching_owner:0,completed_owner:0}
      ]);
      if (q.query===VERIFY_FIRST_OWNER_SQL) return Response.json([
        {profile_count:1,member_count:1,verified_binding_count:1}
      ]);
      return Response.json([]);
    }
  });
  const summary=await adapter.inspectAuthUsers({projectRef:PILOT_REF});
  assert.equal(summary.authUsersTotal,0);
  await adapter.executeSql({projectRef:PILOT_REF,query:ASSIGN_FIRST_OWNER_SQL});
  const verified=await adapter.verifyBinding({
    projectRef:PILOT_REF,query:VERIFY_FIRST_OWNER_SQL,readOnly:true,
  });
  assert.equal(verified[0].verified_binding_count,1);
  assert.equal(calls.length,3);
  for (const call of calls) {
    assert.equal(call.url,"https://api.supabase.com/v1/projects/"+PILOT_REF+"/database/query");
    assert.equal(call.opts.method,"POST");
    assert.equal(call.opts.headers.Authorization,"Bearer secret-mgmt-oauth-token-never-returned");
    assert.equal(call.opts.headers["Content-Type"],"application/json");
  }
  assert.equal(JSON.parse(calls[0].opts.body).read_only,true);
  assert.equal(JSON.parse(calls[1].opts.body).read_only,undefined);
  assert.equal(JSON.parse(calls[2].opts.body).read_only,true);
});

test("queries can't be changed or target another provider project",async()=>{
  let tokenCalls=0;
  const adapter=createPilotManagementAdapter({
    getAccessToken:async()=>{tokenCalls++;return "fake-provider-token";},
    fetchFn:async()=>{throw new Error("no network expected");},
  });
  const bad=[
    ()=>adapter.inspectAuthUsers({projectRef:"other"}),
    ()=>adapter.executeSql({projectRef:"other",query:ASSIGN_FIRST_OWNER_SQL}),
    ()=>adapter.executeSql({projectRef:PILOT_REF,query:"select * from auth.users"}),
    ()=>adapter.verifyBinding({projectRef:PILOT_REF,query:ASSIGN_FIRST_OWNER_SQL,readOnly:true}),
    ()=>adapter.verifyBinding({projectRef:PILOT_REF,query:VERIFY_FIRST_OWNER_SQL,readOnly:false}),
  ];
  for(const testFn of bad)await assert.rejects(testFn);
  assert.equal(tokenCalls,0);
});

test("admin invite accepts only one exact test recipient, without exposing Admin data",async()=>{
  const calls=[];
  const adminClient={auth:{admin:{
    inviteUserByEmail:async(email,options)=>{
      calls.push({email,options});
      return {data:{user:{email}},error:null};
    }
  }}};
  const invite=createPilotInviteAdminAdapter({
    adminClient,adminProjectRef:PILOT_REF,
  });
  const value=await invite({projectRef:PILOT_REF,email:PILOT_OWNER_EMAIL,redirectTo:PILOT_CALLBACK});
  assert.deepEqual(value,{invitationSubmitted:true});
  assert.deepEqual(calls,[{email:PILOT_OWNER_EMAIL,options:{redirectTo:PILOT_CALLBACK}}]);
  for(const bad of [
    {projectRef:"not-our-project",email:PILOT_OWNER_EMAIL,redirectTo:PILOT_CALLBACK},
    {projectRef:PILOT_REF,email:"other@example.com",redirectTo:PILOT_CALLBACK},
    {projectRef:PILOT_REF,email:PILOT_OWNER_EMAIL,redirectTo:"https://klean.ly"},
  ])await assert.rejects(invite(bad));
  assert.equal(calls.length,1);
  assert.throws(()=>createPilotInviteAdminAdapter({
    adminClient,adminProjectRef:"not-our-project"
  }));
  assert.throws(()=>createPilotInviteAdminAdapter({
    adminProjectRef:PILOT_REF
  }));
});

test("provider error does not claim sent or expose its error body",async()=>{
  const adapter=createPilotInviteAdminAdapter({
    adminProjectRef:PILOT_REF,adminClient:{auth:{admin:{
      inviteUserByEmail:async()=>({error:{message:"provider-secret"}})
    }}}
  });
  await assert.rejects(adapter({
    projectRef:PILOT_REF,email:PILOT_OWNER_EMAIL,redirectTo:PILOT_CALLBACK
  }),/admin_invitation_unverified/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parsePilotInviteLink,
} from "../crm-runtime/invite-link.mjs";
import {
  createTenantClient,
} from "../crm-runtime/tenant.mjs";

const origin = "https://kleanly-business-crm-pilot.netlify.app";
const project = "https://nlupgjwcyivepzgqffss.supabase.co";
const email = "kleanlytest@gerball.co.uk";
const uid = "00000000-0000-4000-8000-000000000001";
const config = { projectUrl: project, siteUrl: origin,
  publishableKey:"sb_publishable_" + "a".repeat(40) };
const code = "a".repeat(64);
const token = "pilot-invited-owner-access-token-2026-10";
const refresh = "pilot-invited-owner-refresh-token-2026-10";
const source = file => readFileSync(new URL("../crm-runtime/" + file, import.meta.url),"utf8");
const callback = origin + "/auth/callback";

function api({identity=email, verifyStatus=200, updateStatus=200} = {}) {
  const calls = [];
  async function fetchFn(uri,opts) {
    const u = new URL(uri);
    assert.equal(u.origin,project);
    assert.equal(opts.credentials,"omit");
    assert.equal(opts.headers.apikey,config.publishableKey);
    const path = u.pathname + u.search;
    calls.push({path,opts});
    if (path === "/auth/v1/verify") {
      if (verifyStatus !== 200) return Response.json({message:"internal-provider-info"},{status:verifyStatus});
      return Response.json({access_token:token,refresh_token:refresh,expires_in:3600});
    }
    if (path === "/auth/v1/user" && opts.method === "GET") {
      return Response.json({id:uid,email:identity});
    }
    if (path === "/auth/v1/user" && opts.method === "PUT") {
      if(updateStatus !== 200)return Response.json({message:"secret-provider-info"},{status:updateStatus});
      return Response.json({id:uid,email:identity});
    }
    if (path === "/auth/v1/logout") return new Response(null,{status:204});
    throw new Error("Unexpected network request: " + path);
  }
  return {fetchFn,calls};
}
const clientFor = mock => createTenantClient(config,{fetchFn:mock.fetchFn,browserOrigin:origin});

test("preferred email link requires exact pilot HTTPS origin and one invite token", () => {
  const link=parsePilotInviteLink(callback+"?token_hash="+code+"&type=invite");
  assert.deepEqual(link,{mode:"token_hash",tokenHash:code});
  for(const url of [
    "http://kleanly-business-crm-pilot.netlify.app/auth/callback?token_hash="+code+"&type=invite",
    "https://klean.ly/auth/callback?token_hash="+code+"&type=invite",
    "https://other-business.netlify.app/auth/callback?token_hash="+code+"&type=invite",
    origin+"/other?token_hash="+code+"&type=invite",
    callback+"?token_hash="+code+"&type=signup",
    callback+"?token_hash=abc&type=invite",
    callback+"?token_hash="+code+"&token_hash="+code+"&type=invite",
    callback+"?token_hash="+code+"&type=invite&type=invite",
    callback+"?type=invite",
    callback+"?token_hash="+code,
    callback,
  ])assert.throws(()=>parsePilotInviteLink(url));
});

test("legacy Supabase fragment invite allowed only for verified invite session", () => {
  const u=callback+"#access_token="+token+"&refresh_token="+refresh+
    "&type=invite&token_type=bearer&expires_in=3600";
  const parsed=parsePilotInviteLink(u);
  assert.deepEqual(parsed,{mode:"session",accessToken:token,refreshToken:refresh,expiresIn:3600});
  for(const bad of [
    u.replace("type=invite","type=recovery"),
    u.replace("token_type=bearer","token_type=basic"),
    u.replace("expires_in=3600","expires_in=-1"),
    u+"&refresh_token="+refresh,
    callback+"?type=invite&token_hash="+code+u.slice(callback.length),
  ])assert.throws(()=>parsePilotInviteLink(bad));
});

test("only an explicit accepted token_hash calls Supabase POST verify with type invite", async () => {
  const mock=api();
  const c=clientFor(mock);
  await assert.rejects(c.list("customers"),/Owner sign-in/);
  assert.equal(mock.calls.length,0);
  await assert.rejects(c.acceptInvitation({mode:"token_hash",tokenHash:"x"}),/No valid invitation/);
  assert.equal(mock.calls.length,0);
  const result=await c.acceptInvitation(parsePilotInviteLink(callback+"?token_hash="+code+"&type=invite"));
  assert.deepEqual(result,{email});
  assert.equal(c.isOwnerSignedIn(),false);
  const verified=mock.calls.find(x=>x.path==="/auth/v1/verify");
  assert.equal(verified.opts.method,"POST");
  assert.deepEqual(JSON.parse(verified.opts.body),{token_hash:code,type:"invite"});
  assert.equal(verified.opts.headers.Authorization,undefined);
  const identity=mock.calls.find(x=>x.path==="/auth/v1/user");
  assert.equal(identity.opts.headers.Authorization,"Bearer "+token);
  assert.equal(mock.calls.some(x=>x.path.startsWith("/rest/v1/")),false);
  await assert.rejects(c.list("payments"),/Owner sign-in/);
});

test("verified invited owner can set password, but cannot claim owner profile or read CRM",async()=>{
  const mock=api();
  const c=clientFor(mock);
  await c.acceptInvitation({mode:"token_hash",tokenHash:code});
  assert.equal(c.isOwnerSignedIn(),false);
  await assert.rejects(c.completeInvitationPassword("short"),/12/);
  const result=await c.completeInvitationPassword("correct-battery-river");
  assert.deepEqual(result,{passwordSet:true,ownerAssigned:false});
  const update=mock.calls.find(x=>x.path==="/auth/v1/user"&&x.opts.method==="PUT");
  assert.equal(update.opts.headers.Authorization,"Bearer "+token);
  assert.deepEqual(JSON.parse(update.opts.body),{password:"correct-battery-river"});
  assert.equal(mock.calls.at(-1).path,"/auth/v1/logout");
  assert.equal(c.isOwnerSignedIn(),false);
  await assert.rejects(c.list("customers"),/Owner sign-in/);
  await assert.rejects(c.completeInvitationPassword("another-password-long"),/Verify your invitation first/);
  assert.equal(mock.calls.some(x=>x.path.startsWith("/rest/v1/")),false);
});

test("default verification fragment never issues second OTP verify request",async()=>{
  const mock=api();
  const c=clientFor(mock);
  await c.acceptInvitation({
    mode:"session",accessToken:token,refreshToken:refresh,expiresIn:3600,
  });
  assert.equal(mock.calls.filter(x=>x.path==="/auth/v1/verify").length,0);
  assert.equal(mock.calls.filter(x=>x.path==="/auth/v1/user").length,1);
  await c.logout();
  assert.equal(mock.calls.at(-1).path,"/auth/v1/logout");
});

test("wrong invitation user and rejected token cannot create password or access customer data", async()=>{
  for(const mock of [api({identity:"other@example.com"}),api({verifyStatus:403})]) {
    const c=clientFor(mock);
    await assert.rejects(c.acceptInvitation({mode:"token_hash",tokenHash:code}),/invalid, expired or not for this test owner/);
    await assert.rejects(c.completeInvitationPassword("valid-long-password"),/Verify your invitation first/);
    assert.equal(mock.calls.some(x=>x.path.startsWith("/rest/v1/")),false);
    assert.equal(mock.calls.some(x=>x.opts.method==="PUT"),false);
    assert.doesNotMatch(JSON.stringify(mock.calls.map(c=>c.path)),/service_role|sb_secret_/i);
  }
});

test("failed password update signs out and blocks automatic replay", async()=>{
  const mock=api({updateStatus:403});
  const c=clientFor(mock);
  await c.acceptInvitation({mode:"token_hash",tokenHash:code});
  await assert.rejects(c.completeInvitationPassword("valid-long-password"));
  assert.equal(mock.calls.at(-1).path,"/auth/v1/logout");
  await assert.rejects(c.completeInvitationPassword("valid-long-password"),/Verify your invitation first/);
  assert.equal(mock.calls.filter(x=>x.opts.method==="PUT").length,1);
});

test("callback strips invite URL before network and requires user click for verification",()=>{
  const js=source("invite-callback.mjs");
  const html=source("auth/callback/index.html");
  const headers=source("_headers");
  const redirects=source("_redirects");
  assert.match(js,/parsePilotInviteLink\(window\.location\.href\)/);
  assert.match(js,/history\.replaceState\(/);
  assert.ok(js.indexOf("history.replaceState(")<js.indexOf("await fetch("));
  assert.ok(js.indexOf('accept.addEventListener("click"')<js.indexOf("client.acceptInvitation("));
  assert.match(html,/id="accept-invite" type="button" hidden/);
  assert.match(html,/id="new-password-form" hidden/);
  assert.match(html,/type="password" required minlength="12"/);
  assert.match(html,/src="\.\.\/\.\.\/invite-callback\.mjs"/);
  assert.doesNotMatch(html,/<script(?![^>]*src=)[^>]*>/i);
  assert.doesNotMatch(js,/\blocalStorage\b|\bsessionStorage\b|\binnerHTML\b/);
  assert.match(headers,/Referrer-Policy: no-referrer/);
  assert.match(headers,/Cache-Control: no-store/);
  assert.match(redirects,/\/auth\/callback \/auth\/callback\/index\.html 200/);
  assert.match(source("owner-invitation-email-template.html"),/\{\{ \.TokenHash \}\}/);
  assert.doesNotMatch(source("owner-invitation-email-template.html"),/<img\b|<script\b|pixel\.png/i);
});

test("source package remains undeployed with no invitation sending or admin key",()=>{
  const m=JSON.parse(source("manifest.json"));
  assert.equal(m.deployable,false);
  assert.equal(m.customerSiteDeployed,false);
  assert.equal(m.inviteCallbackInSource,true);
  assert.equal(m.invitationSendingConfigured,false);
  assert.equal(m.ownerBootstrapImplemented,false);
  assert.equal(m.callbackEmailTemplateInstalled,false);
  const runtime=["tenant.mjs","invite-link.mjs","invite-callback.mjs","app.mjs"].map(source).join("\n");
  assert.doesNotMatch(runtime,/\bservice_role\b|\bsb_secret_\b|inviteUserByEmail|createUser\(|\.signUp\(/i);
  assert.doesNotMatch(runtime,/\bfetch\(\s*["']https:\/\/klean\.ly/i);
  const hosting=readFileSync(new URL("../netlify.toml",import.meta.url),"utf8");
  assert.match(hosting,/publish = "installer"/);
  assert.doesNotMatch(hosting,/publish = "crm-runtime"/);
});

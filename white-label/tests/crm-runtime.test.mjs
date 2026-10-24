import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createTenantClient, verifiedPilotClientConfig,
} from "../crm-runtime/tenant.mjs";
const origin = "https://kleanly-business-crm-pilot.netlify.app";
const projectUrl = "https://nlupgjwcyivepzgqffss.supabase.co";
const uid = "00000000-0000-4000-8000-000000000001";
const config = {
  projectUrl, siteUrl: origin,
  publishableKey: "sb_publishable_" + "a".repeat(40),
};
const token = "owner-signed-access-token-123456";
const refresh = "owner-refresh-token-abc123";
const ownerRow = { id: 1, owner_user_id: uid, business_name: "Pilot Cleaning" };
const source = name => readFileSync(new URL("../crm-runtime/" + name, import.meta.url), "utf8");

test("runtime remains a separate, explicitly undeployable code package", () => {
  const m = JSON.parse(source("manifest.json"));
  assert.equal(m.deployable, false);
  assert.equal(m.authenticationConfigured, false);
  assert.equal(m.ownerInvitationConfigured, false);
  assert.equal(m.customerSiteDeployed, false);
  assert.equal(m.readOnly, true);
  assert.equal(m.targetProject, "nlupgjwcyivepzgqffss");
  assert.deepEqual(m.includedFiles,
    ["index.html", "styles.css", "app.mjs", "tenant.mjs", "_headers"]);
  assert.match(source("README.md"), /does NOT implement password creation/i);
  assert.match(source("README.md"), /SEPARATELY approved deploy/);
  assert.doesNotMatch(source("index.html"), /service_role|sb_secret_/i);
  assert.doesNotMatch(source("app.mjs"), /localStorage|sessionStorage|innerHTML/);
  assert.doesNotMatch(source("tenant.mjs"), /localStorage|sessionStorage|innerHTML/);
  assert.doesNotMatch(source("tenant.mjs"), /\.insert\(|\.update\(|\.delete\(/i);
  assert.doesNotMatch(source("app.mjs"), /createUser|signUp|inviteUser|service_role/);
  assert.doesNotMatch(source("index.html"), /tenant-config\.json/);
  assert.match(source("app.mjs"), /tenant-config\.json/);
  assert.match(source("README.md"), /not deployable/i);
});

test("client rejects wrong project, wrong site, live directory and non-publishable credentials", () => {
  assert.equal(verifiedPilotClientConfig(config, origin).siteUrl, origin);
  for (const changed of [
    {projectUrl:"https://otherprojectref1234.supabase.co"},
    {projectUrl:"http://nlupgjwcyivepzgqffss.supabase.co"},
    {projectUrl:projectUrl+"/foo"},
    {siteUrl:"https://klean.ly"},
    {siteUrl:"https://other-tenant.netlify.app"},
    {siteUrl:"http://kleanly-business-crm-pilot.netlify.app"},
    {publishableKey:"sb_secret_12345678901234567890"},
    {publishableKey:"eyJhbGciOi"},
  ]) {
    assert.throws(() => verifiedPilotClientConfig({...config,...changed},origin));
  }
  assert.throws(()=>verifiedPilotClientConfig(config,"https://klean.ly"));
  assert.throws(()=>verifiedPilotClientConfig(null,origin));
});

function fakeApi({ owner = ownerRow, expiresIn = 3600 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    calls.push({path, init});
    if (path === "/auth/v1/token?grant_type=password") {
      assert.equal(init.method, "POST");
      assert.equal(JSON.parse(init.body).email, "owner@example.test");
      return Response.json({
        access_token:token,refresh_token:refresh,expires_in:expiresIn,
      });
    }
    if (path === "/auth/v1/token?grant_type=refresh_token") {
      assert.equal(JSON.parse(init.body).refresh_token, refresh);
      return Response.json({access_token:token+"rotated",
        refresh_token:refresh+"rotated",expires_in:3600});
    }
    if (path === "/auth/v1/user") return Response.json({id:uid});
    if (path.startsWith("/rest/v1/business_profile?"))
      return Response.json(owner ? [owner] : []);
    if (path.startsWith("/rest/v1/customers?"))
      return Response.json([{id:"customer1",full_name:"Customer",town:"Bangor"}]);
    if (path.startsWith("/rest/v1/payments?")) return Response.json([]);
    if (path === "/auth/v1/logout") return new Response("",{status:204});
    return new Response("",{status:404});
  };
  return {calls,fn};
}

test("only authenticated verified owner can read; requests contain public API key plus JWT", async () => {
  const mock = fakeApi();
  const client = createTenantClient(config,{
    fetchFn:mock.fn,browserOrigin:origin,
  });
  await assert.rejects(client.list("customers"),/Owner sign-in/);
  assert.equal(mock.calls.length,0);
  const owner=await client.login("owner@example.test","long-password");
  assert.deepEqual(owner,{businessName:"Pilot Cleaning"});
  assert.equal(client.isOwnerSignedIn(),true);
  const rows=await client.list("customers");
  assert.equal(rows.length,1);
  for(const item of mock.calls) {
    assert.equal(item.init.credentials,"omit");
    assert.equal(item.init.redirect,"error");
    assert.equal(item.init.cache,"no-store");
    assert.equal(item.init.headers.apikey,config.publishableKey);
    assert.equal(item.init.method==="POST" && item.path.includes("rest/v1"),false);
  }
  const dataRequest=mock.calls.find(x=>x.path.startsWith("/rest/v1/customers?"));
  assert.equal(dataRequest.init.headers.Authorization,"Bearer "+token);
  assert.match(dataRequest.path,/limit=20/);
  await client.logout();
  assert.equal(client.isOwnerSignedIn(),false);
  await assert.rejects(client.list("customers"),/Owner sign-in/);
  assert.equal(mock.calls.at(-1).path,"/auth/v1/logout");
});

test("wrong owner ID or empty profile blocks data loading even when Auth login succeeds", async () => {
  for(const invalid of [null,{...ownerRow,owner_user_id:"11111111-1111-4111-8111-111111111111"}]) {
    const mock=fakeApi({owner:invalid});
    const client=createTenantClient(config,{fetchFn:mock.fn,browserOrigin:origin});
    await assert.rejects(client.login("owner@example.test","password"),/assigned business owner access/);
    assert.equal(client.isOwnerSignedIn(),false);
    assert.equal(mock.calls.some(x=>x.path.startsWith("/rest/v1/customers")),false);
  }
});

test("refresh is serialized and identity reverified before any further data access", async () => {
  const mock=fakeApi({expiresIn:40});
  const client=createTenantClient(config,{fetchFn:mock.fn,browserOrigin:origin});
  await client.login("owner@example.test","password");
  await Promise.all([client.list("customers"),client.list("payments")]);
  assert.equal(mock.calls.filter(x=>x.path==="/auth/v1/token?grant_type=refresh_token").length,1);
  assert.equal(mock.calls.filter(x=>x.path==="/auth/v1/user").length,2);
  assert.equal(mock.calls.filter(x=>x.path.startsWith("/rest/v1/payments?")).length,1);
});

test("unsupported table, unsafe paging, invalid login and access-denied stay blocked", async () => {
  const mock=fakeApi();
  const client=createTenantClient(config,{fetchFn:mock.fn,browserOrigin:origin});
  await assert.rejects(client.login("invalid","password"),/valid email/);
  assert.equal(mock.calls.length,0);
  await assert.rejects(client.list("auth.users"),/Unsupported CRM query/);
  await client.login("owner@example.test","password");
  for (const query of [
    ["customers",{limit:200}],["customers",{offset:-1}],
    ["auth.users",{}],["payments",{offset:10001}],
  ]) {
    await assert.rejects(client.list(query[0],query[1]),/Unsupported CRM query/);
  }
});

test("runtime scripts are local, no inline code, and no public-key configuration ships", () => {
  const html=source("index.html"),head=source("_headers"),js=source("app.mjs");
  assert.match(html,/id="login-screen"/);
  assert.match(html,/id="workspace" hidden/);
  assert.match(html,/id="login-form" hidden/);
  assert.match(html,/type="password"/);
  assert.match(js,/createTenantClient/);
  assert.match(js,/\.textContent =/);
  assert.doesNotMatch(js,/\binnerHTML\b/);
  assert.doesNotMatch(html,/<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.match(head,/frame-ancestors 'none'/);
  assert.match(head,/script-src 'self'/);
  assert.match(head,/connect-src 'self' https:\/\/nlupgjwcyivepzgqffss\.supabase\.co/);
  assert.doesNotMatch(head,/\*\.supabase\.co|unsafe-inline|unsafe-eval/i);
  for(const s of [html,js,source("tenant.mjs"),head]) {
    assert.doesNotMatch(s,/SUPABASE_SERVICE_ROLE_KEY|NETLIFY_OAUTH_CLIENT_SECRET|DATABASE_URL/);
  }
});

test("installer staging still only publishes the separate static PREVIEW", () => {
  const config = readFileSync(new URL("../netlify.toml",import.meta.url),"utf8");
  assert.match(config,/publish = "installer"/);
  assert.doesNotMatch(config,/crm-runtime/);
  const previewManifest=JSON.parse(readFileSync(
    new URL("../crm-app/deployment-manifest.json",import.meta.url),"utf8"));
  assert.equal(previewManifest.deployable,false);
  assert.equal(previewManifest.previewOnly,true);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { buildCrmPreview, CRM_PREVIEW_ASSETS } from "../tools/build-crm-preview.mjs";

const source = new URL("../crm-app/", import.meta.url);
const assetText = name => readFileSync(new URL(name, source), "utf8");
const manifest = JSON.parse(assetText("deployment-manifest.json"));

test("CRM package is a NON-deployable, unauthenticated interface preview", () => {
  assert.equal(manifest.package, "kleanly-business-crm");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.deployable, false);
  assert.equal(manifest.authenticationConfigured, false);
  assert.equal(manifest.databaseConnected, false);
  assert.equal(manifest.ownerInvitationConfigured, false);
  assert.equal(manifest.readsCustomerData, false);
  assert.equal(manifest.writesCustomerData, false);
  assert.equal(manifest.previewOnly, true);
  assert.deepEqual(manifest.includedFiles,
    ["index.html", "styles.css", "app.mjs", "_headers", "deployment-manifest.json"]);
  assert.deepEqual(manifest.modules,
    ["dashboard", "customers", "rounds", "jobs", "payments", "messages", "team", "settings"]);
});

test("CRM preview renders all 8 modules and openly discloses its limitations", () => {
  const html = assetText("index.html");
  for (const page of manifest.modules) {
    assert.match(html, new RegExp('data-view="' + page + '"'));
    assert.match(html, new RegExp('data-page="' + page + '"'));
  }
  assert.match(html, /No owner login, live customer data or database connection yet/);
  assert.match(html, /Interface preview/);
  assert.match(html, /No live data is accessed on this preview/);
  assert.match(html, /class="locked-action" disabled type="button"/);
  assert.doesNotMatch(html, /<form[\s>]/i);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(html, /https?:\/\/[^"'\s]+\/auth\/v1\//i);
});

test("preview application is static and does not fetch, store or mutate user records", () => {
  const js = assetText("app.mjs");
  assert.match(js, /function displayPage/);
  assert.match(js, /closeMenu/);
  assert.match(js, /data-page/);
  assert.doesNotMatch(js, /\bfetch\s*\(/);
  assert.doesNotMatch(js, /\bXMLHttpRequest\b/);
  assert.doesNotMatch(js, /\bWebSocket\s*\(/);
  assert.doesNotMatch(js, /\blocalStorage\b|\bsessionStorage\b/);
  assert.doesNotMatch(js, /\binnerHTML\b/);
  assert.doesNotMatch(js, /\bcreateClient\s*\(/);
  assert.doesNotMatch(js, /supabase\.co|service_role|SUPABASE_SECRET_KEY|NETLIFY_AUTH_TOKEN/);
  for (const name of ["app.mjs", "../tools/build-crm-preview.mjs"]) {
    const file = fileURLToPath(new URL(name, source));
    const cmd = spawnSync(process.execPath, ["--check", file], {
      encoding:"utf8",
    });
    assert.equal(cmd.status, 0, cmd.stderr);
  }
});

test("preview includes only local assets and a strict security header", () => {
  const html = assetText("index.html");
  const headers = assetText("_headers");
  assert.match(html, /href="\.\/styles\.css"/);
  assert.match(html, /src="\.\/app\.mjs"/);
  assert.doesNotMatch(html, /<script[^>]+src="https?:/i);
  assert.match(headers, /X-Robots-Tag: noindex, nofollow/i);
  assert.match(headers, /X-Content-Type-Options: nosniff/i);
  assert.match(headers, /frame-ancestors 'none'/);
  assert.match(headers, /connect-src 'self'/);
  assert.match(headers, /form-action 'none'/);
  const publicSource = CRM_PREVIEW_ASSETS.map(assetText).join("\n");
  assert.doesNotMatch(publicSource,
    /SUPABASE_ACCESS_TOKEN|SUPABASE_SERVICE_ROLE_KEY|NETLIFY_OAUTH_CLIENT_SECRET|DATABASE_URL|vaultKey\s*\(/);
});

test("build copies only the approved CRM shell to an isolated preview directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kleanly-crm-preview-"));
  try {
    const out = pathToFileURL(dir + sep);
    const copied = await buildCrmPreview(out);
    assert.deepEqual(copied, CRM_PREVIEW_ASSETS);
    assert.deepEqual((await readdir(dir)).sort(), [...CRM_PREVIEW_ASSETS].sort());
    for (const name of CRM_PREVIEW_ASSETS) {
      assert.equal(await readFile(new URL(name, out), "utf8"), assetText(name));
    }
    assert.ok(!(await readdir(dir)).includes("_headers"));
  } finally {
    await rm(dir, { recursive:true, force:true });
  }
});

test("staging installer links only to the local static CRM preview, not the new CRM host", () => {
  const html = readFileSync(new URL("../installer/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../installer/styles.css", import.meta.url), "utf8");
  const config = readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
  const ignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(html, /href="\/crm-preview\/"/);
  assert.match(html, /View CRM interface preview/);
  assert.match(html, /NOT deployed to your test CRM website/);
  assert.match(css, /\.crm-preview-link\s*\{/);
  assert.match(config, /command = "npm test && node tools\/build-crm-preview\.mjs"/);
  assert.match(config, /publish = "installer"/);
  assert.match(ignore, /installer\/crm-preview\//);
  assert.match(ignore, /\.netlify\//);
  assert.doesNotMatch(config, /publish = "crm-app"/);
  assert.doesNotMatch(config, /kleanly-business-crm-pilot\.netlify\.app/);
});

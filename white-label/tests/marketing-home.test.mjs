import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

const root = new URL("../installer/", import.meta.url);
const html = readFileSync(new URL("index.html", root), "utf8");
const script = readFileSync(new URL("landing.js", root), "utf8");
const styles = readFileSync(new URL("landing.css", root), "utf8");
const progress = JSON.parse(readFileSync(new URL("progress.json", root), "utf8"));

test("marketing homepage and staging wizard coexist without rewriting OAuth endpoints", () => {
  assert.match(html, /id="landing-home"/);
  assert.match(html, /id="setup-wizard" hidden/);
  assert.match(html, /id="supabase-oauth-result"/);
  assert.match(html, /id="netlify-oauth-result"/);
  assert.match(html, /id="crm-app-deploy-form"/);
  assert.match(html, /href="\/#setup"/);
  assert.match(html, /href="\/crm-preview\/"/);
  assert.match(html, /src="\.\/landing\.js"/);
  assert.match(html, /href="\.\/landing\.css"/);
  assert.match(script, /query\.has\("supabase_test"\)/);
  assert.match(script, /query\.has\("netlify_result"\)/);
  assert.match(script, /window\.location\.hash === "#setup"/);
  assert.match(styles, /#setup-wizard\[hidden\]/);
});

test("development percentages are valid planning estimates, not asserted code coverage", () => {
  assert.equal(progress.schemaVersion, 1);
  assert.match(progress.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!Number.isNaN(Date.parse(progress.asOf)));
  const valid = (n) => Number.isInteger(n) && n >= 0 && n <= 100;
  assert.ok(valid(progress.overall));
  assert.ok(valid(progress.firstInstallation));
  assert.equal(progress.components.length, 9);
  assert.equal(new Set(progress.components.map((item) => item.id)).size, progress.components.length);
  for (const item of progress.components) {
    assert.ok(item.id && item.name && valid(item.percent));
  }
  assert.ok(progress.estimateNote.includes("estimates"));
  assert.ok(progress.nextMilestone.length > 10);
  assert.ok(Array.isArray(progress.updates) && progress.updates.length > 0);
  assert.ok(!/"(access_token|refresh_token|service_role_key|api_key|password)"\s*:/i.test(JSON.stringify(progress)));
});

test("live progress loader reads published JSON, rather than guessing from deploy count", () => {
  assert.doesNotThrow(() => new Script(script), "landing.js must be syntactically valid");
  assert.match(script, /fetch\("\.\/progress\.json\?t="/);
  assert.match(script, /cache: "no-store"/);
  assert.match(script, /setInterval\(loadProgress, 120000\)/);
  assert.match(script, /textContent = item\.name/);
  assert.match(html, /id="build-components"/);
  assert.match(html, /id="build-updates"/);
  const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, "homepage must not duplicate existing wizard element IDs");
});


test("marketing page keeps sharp corners, restrained accent colours and responsive layouts", () => {
  const radiusDeclarations = Array.from(styles.matchAll(/border-radius:\s*([^;]+);/g), m => m[1].trim());
  assert.ok(radiusDeclarations.length > 0, "explicit square-corner reset exists");
  assert.ok(radiusDeclarations.every(radius => radius === "0"), "homepage uses no rounded corners");
  assert.match(styles, /--l-blue:\s*#315cf5;/);
  assert.match(styles, /--l-yellow:\s*#ffe45d;/);
  assert.match(styles, /\.landing \.l-ring::after/);
  assert.match(styles, /@media \(max-width: 800px\)/);
  assert.match(styles, /@media \(max-width: 580px\)/);
  assert.doesNotMatch(styles, /(?:radial-gradient|conic-gradient)/i);
  assert.match(styles, /#setup-wizard\[hidden\]/, "wizard visibility remains independently controlled");
  assert.doesNotMatch(styles, /(^|\n)\s*\.(?:sidebar|workspace|provider-card|step-panel)\s*\{/,
    "marketing styles must not affect the existing wizard");
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dir = new URL("../installer/", import.meta.url);
const html = readFileSync(new URL("index.html", dir), "utf8");
const wizardStyles = readFileSync(new URL("wizard-theme.css", dir), "utf8");
const landingStyles = readFileSync(new URL("landing.css", dir), "utf8");
const wizardScript = readFileSync(new URL("app.mjs", dir), "utf8");

test("both entry views load a shared sharp-corner visual language", () => {
  const landingIndex = html.indexOf('<link rel="stylesheet" href="./landing.css" />');
  const wizardIndex = html.indexOf('<link rel="stylesheet" href="./wizard-theme.css" />');
  assert.ok(landingIndex >= 0 && wizardIndex > landingIndex, "wizard theme loads after the homepage theme");
  assert.match(html, /id="setup-wizard" hidden/);
  assert.match(html, /id="landing-home"/);
  for (const [name, value] of [
    ["ink", "#171717"],
    ["blue", "#315cf5"],
    ["yellow", "#ffe45d"],
    ["paper", "#fffefa"],
  ]) {
    assert.ok(landingStyles.includes(value), "homepage uses " + name);
    assert.ok(wizardStyles.includes(value), "wizard uses " + name);
  }
  assert.match(wizardStyles, /#setup-wizard\s*,\s*#setup-wizard \*\s*,/);
  const radii = [...wizardStyles.matchAll(/border-radius:\s*([^;]+);/g)].map(match => match[1].trim());
  assert.ok(radii.length > 0);
  assert.ok(radii.every(radius => radius === "0"), "wizard theme must keep every edge square");
});

test("installer theme preserves navigation, hidden sections, confirmations and statuses", () => {
  assert.match(wizardStyles, /#setup-wizard \[hidden\]\s*\{\s*display: none !important;/);
  assert.match(wizardStyles, /#setup-wizard \.pilot-approval\[hidden\]\s*\{\s*display: none !important;/);
  assert.match(wizardStyles, /#setup-wizard \.oauth-feedback\.is-error/);
  assert.match(wizardStyles, /#setup-wizard \.oauth-feedback\.is-warning/);
  assert.match(wizardStyles, /#setup-wizard \.step-list li button\.active/);
  assert.match(wizardStyles, /#setup-wizard \.provider-oauth/);
  assert.match(wizardStyles, /#setup-wizard \.export-panel > form/);
  assert.match(wizardStyles, /#setup-wizard \.pilot-approval-consent/);
  assert.match(wizardStyles, /@media \(max-width: 830px\)/);
  assert.match(wizardStyles, /@media \(max-width: 640px\)/);

  for (const id of [
    "step-list", "progress-bar", "supabase-oauth-result", "netlify-oauth-result",
    "crm-schema-install-approval", "crm-app-deploy-form", "crm-deploy-one",
    "submit-crm-app-deploy", "next-step", "previous-step"
  ]) {
    assert.ok(html.includes('id="' + id + '"'), "existing wizard control " + id + " preserved");
  }
  assert.match(wizardScript, /window\.location\.assign\("\/\.netlify\/functions\/supabase-oauth-start"\)/);
  assert.match(wizardScript, /window\.location\.assign\("\/\.netlify\/functions\/netlify-oauth-start"\)/);
  assert.match(html, /href="\/#setup"/);
});

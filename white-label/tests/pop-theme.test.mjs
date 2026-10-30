import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../installer/", import.meta.url);
const html = readFileSync(new URL("index.html", root), "utf8");
const home = readFileSync(new URL("pop-home.css", root), "utf8");
const wizard = readFileSync(new URL("pop-wizard.css", root), "utf8");
const app = readFileSync(new URL("app.mjs", root), "utf8");
const landing = readFileSync(new URL("landing.js", root), "utf8");
const progress = JSON.parse(readFileSync(new URL("progress.json", root), "utf8"));

test("both pages load poster styling after existing styles, without changing JS", () => {
  const styles = ["styles.css", "landing.css", "wizard-theme.css", "pop-home.css", "pop-wizard.css"];
  const indexes = styles.map(name => html.indexOf('href="./' + name + '"'));
  assert.ok(indexes.every(index => index > 0), "all expected stylesheets are present");
  assert.ok(indexes.every((index, i) => i === 0 || index > indexes[i-1]), "new CSS overrides legacy CSS");
  assert.match(html, /id="landing-home"/);
  assert.match(html, /id="setup-wizard" hidden/);
  assert.match(html, /src="\.\/app\.mjs"/);
  assert.match(html, /src="\.\/landing\.js"/);
  assert.match(app, /const STEP_COUNT = 4;/);
  assert.match(app, /window\.location\.assign\("\/\.netlify\/functions\/supabase-oauth-start"\)/);
  assert.match(app, /window\.location\.assign\("\/\.netlify\/functions\/netlify-oauth-start"\)/);
  assert.match(landing, /fetch\("\.\/progress\.json\?t="/);
});

test("fun visuals use strong colours, angular shapes and respect motion settings", () => {
  assert.match(home, /--l-blue:\s*#263bff;/);
  assert.match(home, /--l-yellow:\s*#ffe500;/);
  assert.match(home, /--pop-pink:\s*#ff45b5;/);
  assert.match(home, /--pop-orange:\s*#ff7429;/);
  assert.match(wizard, /--kb-blue:\s*#263bff;/);
  assert.match(wizard, /--kb-yellow:\s*#ffe500;/);
  assert.match(home, /#landing-home \.pop-sticker/);
  assert.match(home, /clip-path:\s*polygon/);
  assert.match(home, /#landing-home \.pop-ticker/);
  assert.match(home, /prefers-reduced-motion:\s*reduce/);
  assert.match(home, /max-width:\s*580px/);
  assert.match(wizard, /max-width:\s*640px/);
  assert.match(html, /class="pop-sticker" aria-hidden="true"/);
  assert.match(html, /class="pop-ticker" aria-hidden="true"/);
  assert.doesNotMatch(home, /(^|\n)\s*(html|body|:root)\s*\{/);
  assert.doesNotMatch(wizard, /(^|\n)\s*(html|body|:root)\s*\{/);
});

test("real installation approval, warning UI and progress values remain intact", () => {
  for (const id of [
    "crm-app-deploy-form", "crm-deploy-credits", "crm-deploy-one",
    "crm-schema-install-approval", "crm-site-create-form", "test-project-approval",
    "supabase-oauth-result", "netlify-oauth-result", "next-step", "previous-step",
    "overall-value", "pilot-value", "build-components",
  ]) {
    assert.ok(html.includes('id="' + id + '"'), id + " still exists");
  }
  assert.match(wizard, /#setup-wizard \.oauth-feedback\.is-error/);
  assert.match(wizard, /#setup-wizard \.oauth-feedback\.is-warning/);
  assert.match(wizard, /#setup-wizard \.pilot-approval/);
  assert.match(wizard, /\.action-button:disabled/);
  assert.equal(progress.overall, 25, "styling must not inflate overall completion");
  assert.equal(progress.firstInstallation, 70, "styling must not inflate pilot completion");
});

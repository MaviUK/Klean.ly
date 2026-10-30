import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const html=readFileSync(new URL("../installer/index.html",import.meta.url),"utf8");
const js=readFileSync(new URL("../installer/app.mjs",import.meta.url),"utf8");

test("the mobile staging installer wires a hidden, separately confirmed schema form",()=>{
  for(const id of [
    "review-crm-installation","crm-schema-install-proposal-result",
    "crm-schema-install-approval","crm-schema-accept-changes",
    "crm-schema-confirm-phrase","crm-schema-confirm-phrase-display",
    "install-one-crm-schema","crm-schema-install-result",
  ]) {
    assert.match(html,new RegExp('id="'+id+'"'));
    assert.ok(js.includes('"'+id+'"'),"JS must reference "+id);
  }
  assert.match(html,/id="crm-schema-install-approval" class="pilot-approval" hidden/);
  assert.match(html,/id="install-one-crm-schema" class="action-button" disabled/);
  assert.match(js,/window\.confirm\(/);
  assert.match(js,/\/\.netlify\/functions\/crm-schema-install/);
  assert.match(js,/acknowledgeSchemaChanges: true/);
  assert.match(js,/Do not send another request/);
});

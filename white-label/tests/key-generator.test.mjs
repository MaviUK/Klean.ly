import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateEncryptionKey } from "../installer/generate-key.mjs";

test("browser key generator makes a canonical 256-bit base64url key", () => {
  const keys = Array.from({ length: 10 }, generateEncryptionKey);
  for (const key of keys) {
    assert.match(key, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(key, "base64url").length, 32);
  }
  assert.equal(new Set(keys).size, 10);
});

test("key generator never transmits or persists key material", () => {
  const source = readFileSync(new URL("../installer/generate-key.mjs", import.meta.url), "utf8");
  assert.match(source, /crypto\.getRandomValues/);
  for (const banned of ["fetch(", "XMLHttpRequest", "localStorage", "sessionStorage", "sendBeacon", "Math.random"]) {
    assert.equal(source.includes(banned), false, banned);
  }
});

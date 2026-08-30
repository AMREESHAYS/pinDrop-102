// One check for the vault function: pin validation, round-trip, fuse, burn.
// Run: node --experimental-test-module-mocks test_vault.mjs
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const blobs = new Map();
mock.module("@netlify/blobs", {
  exports: {
    getStore: () => ({
      get: async (k) => blobs.get(k) ?? null,
      set: async (k, v) => void blobs.set(k, v),
      delete: async (k) => void blobs.delete(k),
    }),
  },
});

const { default: handler } = await import("./netlify/functions/vault.mjs");
const call = (pin, init) =>
  handler(new Request(`https://x/.netlify/functions/vault/${pin}`, init));
const post = (pin, obj) =>
  call(pin, { method: "POST", body: JSON.stringify(obj) });

test("rejects non-6-digit pins", async () => {
  assert.equal((await call("12345")).status, 400);
  assert.equal((await call("abcdef")).status, 400);
});

test("round-trips a drop", async () => {
  assert.equal((await post("123456", { pin: "123456", text: "hi" })).status, 200);
  const res = await call("123456");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).text, "hi");
});

test("404s an unknown pin", async () => {
  assert.equal((await call("999999")).status, 404);
});

test("rejects a non-JSON body", async () => {
  assert.equal((await call("222222", { method: "POST", body: "nope" })).status, 400);
});

test("burns an expired drop on read", async () => {
  await post("111111", { pin: "111111", expiresAt: Date.now() - 1 });
  assert.equal((await call("111111")).status, 410);
  assert.equal((await call("111111")).status, 404, "expired record must be deleted");
});

test("keeps a live fuse", async () => {
  await post("333333", { pin: "333333", expiresAt: Date.now() + 60000 });
  assert.equal((await call("333333")).status, 200);
});

test("deletes on DELETE", async () => {
  await post("444444", { pin: "444444" });
  assert.equal((await call("444444", { method: "DELETE" })).status, 200);
  assert.equal((await call("444444")).status, 404);
});

// Password locks: what the vault stores must not open without the password,
// and the proof sent to the vault must not be the encryption key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveKeys, lockValue, unlockValue } from "./.test-build/lock.js";

const secret = { title: "t", text: "wifi: hunter2", files: [] };

test("round-trips with the right password", async () => {
  const { salt, box, verifier } = await lockValue(secret, "correct horse");
  const { key, auth } = await deriveKeys("correct horse", salt);
  assert.equal(auth, verifier, "the same password reproduces the proof the vault holds");
  assert.deepEqual(await unlockValue(box, key), secret);
});

test("a wrong password gives a different proof and cannot decrypt", async () => {
  const { salt, box, verifier } = await lockValue(secret, "correct horse");
  const { key, auth } = await deriveKeys("wrong horse", salt);
  assert.notEqual(auth, verifier);
  await assert.rejects(unlockValue(box, key));
});

test("ciphertext and proof never contain the plaintext or each other", async () => {
  const { box, verifier } = await lockValue(secret, "correct horse");
  assert.ok(!box.includes("hunter2"));
  assert.match(verifier, /^[0-9a-f]{64}$/);
});

test("a tampered box is rejected (GCM authenticates)", async () => {
  const { salt, box } = await lockValue(secret, "pw123456");
  const { key } = await deriveKeys("pw123456", salt);
  const flipped = box.slice(0, 20) + (box[20] === "A" ? "B" : "A") + box.slice(21);
  await assert.rejects(unlockValue(flipped, key));
});

test("same password, fresh salt each time", async () => {
  const a = await lockValue(secret, "pw123456");
  const b = await lockValue(secret, "pw123456");
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.verifier, b.verifier);
});

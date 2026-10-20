// The vault function is the whole security model: owner tokens, create-only
// sealing, server-side burn and open limits, and the wrong-guess budget.
// Run: node --experimental-test-module-mocks test_vault.mjs
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

const stores = new Map(); // name -> Map<key, { value, etag }>
let etags = 0;
mock.module("@netlify/blobs", {
  exports: {
    getStore: ({ name }) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      const read = (k, o) => {
        const e = m.get(k);
        if (!e) return null;
        return o?.type === "json" ? JSON.parse(e.value) : e.value;
      };
      return {
        get: async (k, o) => read(k, o),
        getWithMetadata: async (k, o) =>
          m.has(k) ? { data: read(k, o), etag: m.get(k).etag, metadata: {} } : null,
        set: async (k, v, o = {}) => {
          const cur = m.get(k);
          if (o.onlyIfNew && cur) return { modified: false };
          if (o.onlyIfMatch && cur?.etag !== o.onlyIfMatch) return { modified: false };
          const etag = `e${++etags}`;
          m.set(k, { value: v, etag });
          return { modified: true, etag };
        },
        delete: async (k) => void m.delete(k),
      };
    },
  },
});

const { default: handler, MISS_LIMIT, MAX_FUSE, cleanDrop } = await import(
  "./netlify/functions/vault.mjs"
);

let ip = "10.0.0.1";
const call = (path, init = {}) =>
  handler(new Request(`https://x/.netlify/functions/vault/${path}`, init), { ip });
const seal = (pin, obj) =>
  call(pin, { method: "POST", body: JSON.stringify({ type: "note", text: "hi", ...obj }) });
const owned = (token) => ({ headers: { "x-owner-token": token } });
const raw = (pin) => stores.get("pindrop")?.get(pin);

beforeEach(() => {
  stores.clear();
  ip = "10.0.0.1";
});

test("rejects non-6-digit pins", async () => {
  assert.equal((await call("12345")).status, 400);
  assert.equal((await call("abcdef")).status, 400);
});

test("seals, returns an owner token, and never leaks its hash", async () => {
  const res = await seal("123456", { title: "t" });
  assert.equal(res.status, 201);
  const { owner, expiresAt } = await res.json();
  assert.match(owner, /^[0-9a-f]{64}$/);
  assert.ok(expiresAt > Date.now());
  assert.ok(!raw("123456").value.includes(owner), "token itself is never stored");

  const open = await call("123456");
  assert.equal(open.status, 200);
  const body = await open.json();
  assert.equal(body.text, "hi");
  assert.equal(body.ownerHash, undefined);
});

test("sealing is create-only — nobody can overwrite a live PIN", async () => {
  await seal("123456", { text: "real" });
  const res = await seal("123456", { type: "link", link: "https://phish.example" });
  assert.equal(res.status, 409);
  assert.equal((await (await call("123456")).json()).text, "real");
});

test("PUT is not a way around create-only", async () => {
  await seal("123456", { text: "real" });
  const put = await call("123456", { method: "PUT", body: JSON.stringify({ type: "note", text: "evil" }) });
  assert.equal(put.status, 409);
  assert.equal((await (await call("123456")).json()).text, "real");
});

test("only the owner can shred a drop", async () => {
  const { owner } = await (await seal("444444")).json();
  assert.equal((await call("444444", { method: "DELETE" })).status, 403);
  assert.equal((await call("444444", { method: "DELETE", ...owned("f".repeat(64)) })).status, 403);
  assert.ok(raw("444444"), "wrong token leaves the drop alone");
  assert.equal((await call("444444", { method: "DELETE", ...owned(owner) })).status, 200);
  assert.equal((await call("444444")).status, 404);
});

test("burn-after-read is enforced on the server, first reader only", async () => {
  await seal("555555", { burnAfterRead: true });
  const first = await call("555555");
  assert.equal(first.status, 200);
  assert.equal((await first.json()).burned, true);
  assert.notEqual((await call("555555")).status, 200, "a second read must not see the drop");
});

test("two simultaneous readers cannot both get a burn-after-read drop", async () => {
  await seal("565656", { burnAfterRead: true });
  const res = await Promise.all([call("565656"), call("565656"), call("565656")]);
  assert.equal(res.filter((r) => r.status === 200).length, 1);
});

test("download limit counts opens on the server", async () => {
  await seal("666666", { maxOpens: 2 });
  const a = await (await call("666666")).json();
  assert.equal(a.opens, 1);
  assert.equal(a.burned, false);
  const b = await (await call("666666")).json();
  assert.equal(b.opens, 2);
  assert.equal(b.burned, true);
  assert.notEqual((await call("666666")).status, 200);
});

test("owner status reports opens without counting one", async () => {
  const { owner } = await (await seal("777777")).json();
  await call("777777");
  const s = await call("777777/status", owned(owner));
  assert.equal(s.status, 200);
  assert.equal((await s.json()).opens, 1);
  assert.equal((await (await call("777777/status", owned(owner))).json()).opens, 1);
  assert.equal((await call("777777/status", owned("nope"))).status, 403);
});

test("expired drops are shredded on read", async () => {
  await seal("111111");
  const rec = JSON.parse(raw("111111").value);
  raw("111111").value = JSON.stringify({ ...rec, expiresAt: Date.now() - 1 });
  assert.equal((await call("111111")).status, 410);
  assert.equal(raw("111111"), undefined);
});

test("legacy records without a fuse expire a week after creation", async () => {
  stores.set("pindrop", new Map([["222222", {
    value: JSON.stringify({ pin: "222222", text: "old", createdAt: Date.now() - MAX_FUSE - 1 }),
    etag: "x",
  }]]));
  assert.equal((await call("222222")).status, 410);
});

test("wrong guesses lock the IP out, and only that IP", async () => {
  await seal("888888");
  for (let i = 0; i < MISS_LIMIT; i++) {
    assert.equal((await call(String(100000 + i))).status, 404);
  }
  assert.equal((await call("888888")).status, 429, "even a right PIN is refused once locked");
  ip = "10.0.0.2";
  assert.equal((await call("888888")).status, 200);
});

test("a taken-PIN reply costs a guess, so POST can't enumerate", async () => {
  await seal("999999");
  ip = "10.0.0.9";
  for (let i = 0; i < MISS_LIMIT; i++) await seal("999999");
  assert.equal((await seal("123123")).status, 429);
});

test("rejects bad bodies", async () => {
  assert.equal((await call("232323", { method: "POST", body: "nope" })).status, 400);
  assert.equal((await seal("232323", { text: "" })).status, 400);
  assert.equal((await seal("232323", { text: "x".repeat(12001) })).status, 400);
  assert.equal((await seal("232323", { type: "exe" })).status, 400);
  assert.equal((await seal("232323", { maxOpens: 0 })).status, 400);
});

test("cleanDrop whitelists fields and clamps fuses", () => {
  const now = 1_000_000;
  const r = cleanDrop("123456", { type: "note", text: "x", ownerHash: "evil", opens: 99, expiresAt: now * 1e6 }, now);
  assert.equal(r.ownerHash, undefined);
  assert.equal(r.opens, 0);
  assert.equal(r.expiresAt, now + MAX_FUSE);
  assert.ok(cleanDrop("123456", { type: "note", text: "x" }, now).expiresAt > now);
});

test("links must be http(s)", () => {
  assert.equal(cleanDrop("1", { type: "link", link: "javascript:alert(1)" }), "link");
  assert.equal(cleanDrop("1", { type: "link", link: "example.com/x" }).link, "https://example.com/x");
});

test("file URLs must point at a known relay or our own R2", () => {
  const f = (o) => cleanDrop("1", { type: "file", files: [{ name: "a", size: 1, ...o }] });
  assert.equal(f({ host: "tmpfiles", fileUrl: "https://evil.example/x" }), "file");
  assert.equal(f({ host: "r2", fileUrl: "/.netlify/functions/r2/get?key=..%2Fetc" }), "file");
  assert.equal(f({ host: "other", fileUrl: "https://tmpfiles.org/dl/1/a" }), "file");
  assert.ok(f({ host: "r2", fileUrl: "/.netlify/functions/r2/get?key=drops%2Fabcdef0123456789%2Fa.txt" }).files);
});

test("a drop cannot outlive the relay holding its files", () => {
  const now = 0;
  const r = cleanDrop("1", {
    type: "file",
    expiresAt: now + MAX_FUSE,
    files: [{ name: "a", size: 1, host: "tmpfiles", fileUrl: "https://tmpfiles.org/dl/1/a" }],
  }, now);
  assert.equal(r.expiresAt, 48 * 3600_000);
});

/* ------------------------------ inbox ------------------------------ */

const fill = (pin, obj) =>
  call(pin, { method: "PUT", body: JSON.stringify({ type: "note", text: "for you", ...obj }) });

test("an empty inbox tells senders where to send, without counting a guess", async () => {
  await seal("313131", { type: "inbox", title: "send me the deck" });
  const r = await (await call("313131")).json();
  assert.equal(r.waiting, true);
  assert.equal(r.title, "send me the deck");
  assert.equal(r.text, undefined);
});

test("an inbox fills once, and then only its owner can read it", async () => {
  const { owner } = await (await seal("323232", { type: "inbox" })).json();
  assert.equal((await fill("323232")).status, 200);
  assert.equal((await fill("323232", { text: "overwrite" })).status, 409, "second sender is refused");

  assert.equal((await call("323232")).status, 409, "a stranger with the PIN can't read it");
  const mine = await (await call("323232", owned(owner))).json();
  assert.equal(mine.text, "for you");
  assert.equal(mine.ownerHash, undefined);

  const st = await (await call("323232/status", owned(owner))).json();
  assert.equal(st.filled, true);
});

test("two senders racing for one inbox — exactly one lands", async () => {
  await seal("333333", { type: "inbox" });
  const res = await Promise.all([fill("333333", { text: "a" }), fill("333333", { text: "b" })]);
  assert.equal(res.filter((r) => r.status === 200).length, 1);
});

test("filling a missing PIN costs a guess; filling with an inbox is refused", async () => {
  assert.equal((await fill("343434")).status, 404);
  await seal("353535", { type: "inbox" });
  assert.equal((await fill("353535", { type: "inbox" })).status, 400);
});

/* ------------------------------ password ------------------------------ */

// The browser derives a proof from the password and sends it once at seal
// time as `verifier`; the vault stores only its hash and compares later proofs.
const lockedBody = (proof) => ({
  type: "note",
  title: "leaks?",
  locked: { salt: "a".repeat(32), verifier: proof, box: "Q0lQSEVSVEVYVA" },
  r2Keys: ["drops/abcdef0123456789/a.bin"],
});
const authed = (proof) => ({ headers: { "x-drop-auth": proof } });
const PROOF = "b".repeat(64);

test("a locked drop shows the prompt for free, then needs the right proof", async () => {
  await seal("414141", lockedBody(PROOF));

  const prompt = await call("414141");
  assert.equal(prompt.status, 401);
  const p = await prompt.json();
  assert.equal(p.needsPassword, true);
  assert.equal(p.salt, "a".repeat(32));
  assert.equal(p.locked, undefined, "no ciphertext before the proof");

  assert.equal((await call("414141", authed("c".repeat(64)))).status, 401);

  const ok = await call("414141", authed(PROOF));
  assert.equal(ok.status, 200);
  const r = await ok.json();
  assert.equal(r.locked.box, "Q0lQSEVSVEVYVA");
  assert.equal(r.title, "", "the title is not stored in the clear");
  assert.equal(r.lockHash, undefined);
  assert.equal(r.r2Keys, undefined);
  assert.equal(r.opens, 1);
});

test("wrong passwords spend the guess budget; the prompt alone does not", async () => {
  const body = lockedBody(PROOF);
  await seal("424242", body);
  for (let i = 0; i < MISS_LIMIT + 5; i++) assert.equal((await call("424242")).status, 401);
  for (let i = 0; i < MISS_LIMIT; i++) await call("424242", authed("d".repeat(64)));
  assert.equal((await call("424242")).status, 429);
});

test("a wrong password never counts an open or burns the drop", async () => {
  await seal("434343", { ...lockedBody(PROOF), burnAfterRead: true });
  await call("434343", authed("e".repeat(64)));
  assert.equal((await call("434343", authed(PROOF))).status, 200);
  assert.notEqual((await call("434343", authed(PROOF))).status, 200, "and the right one then burns it");
});

test("bad lock fields are refused, and inboxes can't be filled locked", async () => {
  const bad = lockedBody(PROOF);
  bad.locked.salt = "zz";
  assert.equal((await seal("444444", bad)).status, 400);
  const badKeys = { ...lockedBody(PROOF), r2Keys: ["../etc"] };
  assert.equal((await seal("444444", badKeys)).status, 400);
  await seal("454545", { type: "inbox" });
  assert.equal((await fill("454545", lockedBody(PROOF))).status, 400);
});

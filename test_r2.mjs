// Multipart upload flow against a stand-in S3 server.
// Covers what a broken deploy would actually break: the XML round trip, the
// part maths, and the key validation that stops a caller signing PUTs to
// somewhere it shouldn't.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

/* ---------------- stand-in S3 (multipart subset) ---------------- */

const uploads = new Map(); // uploadId -> { key, parts: Map<n, Buffer> }
const objects = new Map(); // key -> Buffer
let nextId = 1;

const readBody = (req) =>
  new Promise((r) => {
    const c = [];
    req.on("data", (d) => c.push(d));
    req.on("end", () => r(Buffer.concat(c)));
  });

const s3 = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const key = decodeURIComponent(url.pathname.replace(/^\/[^/]+\//, ""));
  const body = await readBody(req);

  if (req.method === "POST" && url.searchParams.has("uploads")) {
    const id = `up-${nextId++}`;
    uploads.set(id, { key, parts: new Map() });
    res.writeHead(200, { "Content-Type": "application/xml" });
    return res.end(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
  }

  if (req.method === "PUT" && url.searchParams.has("partNumber")) {
    const up = uploads.get(url.searchParams.get("uploadId"));
    if (!up) return res.writeHead(404).end();
    const n = Number(url.searchParams.get("partNumber"));
    up.parts.set(n, body);
    res.writeHead(200, { ETag: `"etag-${n}"` });
    return res.end();
  }

  if (req.method === "POST" && url.searchParams.has("uploadId")) {
    const up = uploads.get(url.searchParams.get("uploadId"));
    if (!up) return res.writeHead(404).end();
    // Honour the order the client asked for, like S3 does.
    const order = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1]));
    objects.set(up.key, Buffer.concat(order.map((n) => up.parts.get(n) || Buffer.alloc(0))));
    res.writeHead(200, { "Content-Type": "application/xml" });
    return res.end(`<CompleteMultipartUploadResult><ETag>"final"</ETag></CompleteMultipartUploadResult>`);
  }

  if (req.method === "DELETE") {
    if (url.searchParams.has("uploadId")) uploads.delete(url.searchParams.get("uploadId"));
    else objects.delete(key);
    return res.writeHead(204).end();
  }

  if (req.method === "GET") {
    const obj = objects.get(key);
    if (!obj) return res.writeHead(404).end();
    res.writeHead(200);
    return res.end(obj);
  }
  res.writeHead(400).end();
});

let handler;
let port;

before(async () => {
  await new Promise((r) => s3.listen(0, r));
  port = s3.address().port;
  process.env.R2_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.R2_BUCKET = "pindrop";
  process.env.R2_ACCESS_KEY_ID = "testkey";
  process.env.R2_SECRET_ACCESS_KEY = "testsecret";
  handler = (await import("./netlify/functions/r2.mjs")).default;
});

after(() => s3.close());

const call = (action, body, method = "POST") =>
  handler(
    new Request(`https://x/.netlify/functions/r2/${action}`, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );

/* ------------------------------ tests ------------------------------ */

test("reports itself configured", async () => {
  const r = await call("config", null, "GET");
  assert.deepEqual(await r.json(), { enabled: true, maxSize: 50 * 1024 ** 3 });
});

test("runs a whole multipart upload end to end", async () => {
  const size = 20 * 1024 * 1024;
  const created = await (await call("create", { name: "movie.mkv", size, mime: "video/x-matroska" })).json();

  assert.match(created.key, /^drops\/[a-z0-9]{16}\/movie\.mkv$/);
  assert.equal(created.partSize, 8 * 1024 * 1024);
  assert.equal(created.parts, 3);

  const { urls } = await (
    await call("sign", { key: created.key, uploadId: created.uploadId, partNumbers: [1, 2, 3] })
  ).json();
  assert.equal(Object.keys(urls).length, 3);
  for (const u of Object.values(urls)) assert.match(u, /X-Amz-Signature=/);

  // Upload the parts out of order — the server must still stitch them in order.
  const chunks = { 1: "aaa", 2: "bbb", 3: "ccc" };
  for (const n of [3, 1, 2]) {
    const put = await fetch(urls[n], { method: "PUT", body: chunks[n] });
    assert.equal(put.status, 200);
  }

  const done = await (
    await call("complete", {
      key: created.key,
      uploadId: created.uploadId,
      parts: [
        { n: 3, etag: '"etag-3"' },
        { n: 1, etag: '"etag-1"' },
        { n: 2, etag: '"etag-2"' },
      ],
    })
  ).json();
  assert.match(done.url, /\/\.netlify\/functions\/r2\/get\?key=/);
  assert.equal(objects.get(created.key).toString(), "aaabbbccc");
});

test("download hands back a redirect, never the bytes", async () => {
  const key = [...objects.keys()][0];
  const res = await handler(
    new Request(`https://x/.netlify/functions/r2/get?key=${encodeURIComponent(key)}`)
  );
  assert.equal(res.status, 302);
  const loc = res.headers.get("Location");
  assert.match(loc, /X-Amz-Signature=/);
  const disposition = decodeURIComponent(new URL(loc).searchParams.get("response-content-disposition"));
  assert.equal(disposition, "attachment;filename*=UTF-8''movie.mkv");
  assert.ok(!disposition.includes("+"), "a space here would arrive as a literal +");
});

test("refuses a key outside the drops prefix", async () => {
  for (const key of ["../../etc/passwd", "drops/short/x", "other/aaaaaaaaaaaaaaaa/x", ""]) {
    const r = await call("sign", { key, uploadId: "up-1", partNumbers: [1] });
    assert.equal(r.status, 400, `should reject ${JSON.stringify(key)}`);
  }
});

test("refuses an oversized or nonsense file", async () => {
  for (const size of [0, -1, 51 * 1024 ** 3, "big"]) {
    const r = await call("create", { name: "x", size });
    assert.equal(r.status, 413, `should reject size ${size}`);
  }
});

test("caps how many parts one call may sign", async () => {
  const key = `drops/${"a".repeat(16)}/x`;
  const many = Array.from({ length: 201 }, (_, i) => i + 1);
  assert.equal((await call("sign", { key, uploadId: "u", partNumbers: many })).status, 400);
  assert.equal((await call("sign", { key, uploadId: "u", partNumbers: [0] })).status, 400);
  assert.equal((await call("sign", { key, uploadId: "u", partNumbers: [10001] })).status, 400);
});

test("neutralises filenames that would break the key URL", async () => {
  // "#" truncates a path and "?" starts a query string — either one corrupts
  // the request we sign, so the upload silently targets the wrong object.
  const cases = [
    ["report#1.pdf", "report_1.pdf"],
    ["a?b.txt", "a_b.txt"],
    ["100%.csv", "100_.csv"],
    ["../../etc/passwd", "passwd"],
    ["keeps spaces.zip", "keeps spaces.zip"],
    ["naïve.txt", "naïve.txt"],
  ];
  for (const [given, expected] of cases) {
    const c = await (await call("create", { name: given, size: 1024 })).json();
    assert.equal(c.key.split("/").pop(), expected, `for ${given}`);
    // and the signed URL must still carry the multipart marker intact
    const u = new URL(`https://h/b/${encodeURI(c.key)}?uploads=`);
    assert.equal(u.search, "?uploads=", `query broken by ${given}`);
  }
});

test("has no public delete — only the vault deletes, after checking the owner", async () => {
  const c = await (await call("create", { name: "gone.bin", size: 1024 })).json();
  objects.set(c.key, Buffer.from("bytes"));
  assert.equal((await call("delete", { key: c.key })).status, 404);
  assert.ok(objects.has(c.key), "anonymous caller must not delete an object");

  const { deleteR2Object } = await import("./netlify/functions/r2.mjs");
  await deleteR2Object(c.key);
  assert.ok(!objects.has(c.key));
  await deleteR2Object("../nope"); // refused silently, no request made
});

test("rejects non-POST on the mutating actions", async () => {
  for (const a of ["create", "sign", "complete", "abort"]) {
    const r = await handler(new Request(`https://x/.netlify/functions/r2/${a}`));
    assert.equal(r.status, 405, `${a} should refuse GET`);
  }
});

test("keeps a 50 GB file under the S3 part ceiling", async () => {
  const size = 50 * 1024 ** 3;
  const c = await (await call("create", { name: "huge.iso", size })).json();
  assert.ok(c.parts <= 10000, `${c.parts} parts exceeds the S3 limit`);
  assert.ok(c.partSize >= 5 * 1024 * 1024, "parts must clear the 5 MB S3 floor");
});

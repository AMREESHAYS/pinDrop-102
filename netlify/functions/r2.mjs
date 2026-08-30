import { AwsClient } from "aws4fetch";

/* ------------------------------------------------------------------ */
/*  Resumable multipart uploads straight to R2 (S3 API).               */
/*                                                                     */
/*  The browser never sees a credential: it asks here for a presigned  */
/*  PUT per part, uploads the bytes directly to R2, then asks here to  */
/*  stitch the parts together. Because each part is its own request,   */
/*  a dropped connection only costs the part in flight.                */
/* ------------------------------------------------------------------ */

const MAX_SIZE = 50 * 1024 * 1024 * 1024; // 50 GB
const MIN_PART = 8 * 1024 * 1024; // S3 floor is 5 MB; 8 keeps part counts sane
const MAX_PARTS = 9000; // S3 allows 10000 — leave headroom
const KEY_RE = /^drops\/[a-z0-9]{16}\/[^/\\]{1,200}$/;

const env = () => ({
  account: process.env.R2_ACCOUNT_ID,
  bucket: process.env.R2_BUCKET,
  id: process.env.R2_ACCESS_KEY_ID,
  secret: process.env.R2_SECRET_ACCESS_KEY,
  /** override for plain S3 or a local test server; R2 needs only the account */
  endpoint: process.env.R2_ENDPOINT,
});

const configured = () => {
  const e = env();
  return !!(e.bucket && e.id && e.secret && (e.account || e.endpoint));
};

const client = () => {
  const { id, secret } = env();
  return new AwsClient({
    accessKeyId: id,
    secretAccessKey: secret,
    service: "s3",
    region: "auto",
  });
};

const base = () => {
  const { account, bucket, endpoint } = env();
  const host = endpoint || `https://${account}.r2.cloudflarestorage.com`;
  return `${host.replace(/\/+$/, "")}/${bucket}`;
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

/**
 * Strip anything that could climb out of the key prefix or break the key's
 * URL. "#" truncates a path, "?" starts a query string and "%" can open an
 * invalid escape — all of which corrupt the request we sign.
 */
const safeName = (name) => {
  const bare = String(name || "file").split(/[/\\]/).pop() || "file";
  const cleaned = bare
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[#?%&+=:;,"'`<>{}|^~[\]\\]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return cleaned || "file";
};

const rand = () => {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
};

const partSizeFor = (size) =>
  Math.max(MIN_PART, Math.ceil(size / MAX_PARTS / MIN_PART) * MIN_PART);

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : null;
};

const xmlEscape = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export default async (req) => {
  const action = new URL(req.url).pathname.split("/").pop();

  if (action === "config") return json({ enabled: configured(), maxSize: MAX_SIZE });
  if (!configured()) return json({ error: "r2-not-configured" }, 503);

  const aws = client();

  if (action === "create") {
    if (req.method !== "POST") return json({ error: "method" }, 405);
    const { name, size, mime } = await req.json();
    if (!Number.isFinite(size) || size <= 0 || size > MAX_SIZE)
      return json({ error: "size" }, 413);

    const key = `drops/${rand()}/${safeName(name)}`; // rand() is 16 hex chars
    const url = `${base()}/${encodeURI(key)}?uploads=`;
    const res = await aws.fetch(url, {
      method: "POST",
      headers: mime ? { "Content-Type": mime } : {},
    });
    const body = await res.text();
    const uploadId = tag(body, "UploadId");
    if (!res.ok || !uploadId) return json({ error: "create", detail: body.slice(0, 300) }, 502);

    const partSize = partSizeFor(size);
    return json({ key, uploadId, partSize, parts: Math.ceil(size / partSize) });
  }

  if (action === "sign") {
    if (req.method !== "POST") return json({ error: "method" }, 405);
    const { key, uploadId, partNumbers } = await req.json();
    if (!KEY_RE.test(key || "")) return json({ error: "key" }, 400);
    if (!uploadId || !Array.isArray(partNumbers) || partNumbers.length > 200)
      return json({ error: "parts" }, 400);

    const urls = {};
    for (const n of partNumbers) {
      if (!Number.isInteger(n) || n < 1 || n > 10000) return json({ error: "part" }, 400);
      const target = `${base()}/${encodeURI(key)}?partNumber=${n}&uploadId=${encodeURIComponent(
        uploadId
      )}&X-Amz-Expires=3600`;
      const signed = await aws.sign(target, { method: "PUT", aws: { signQuery: true } });
      urls[n] = signed.url;
    }
    return json({ urls });
  }

  if (action === "complete") {
    if (req.method !== "POST") return json({ error: "method" }, 405);
    const { key, uploadId, parts } = await req.json();
    if (!KEY_RE.test(key || "")) return json({ error: "key" }, 400);
    if (!uploadId || !Array.isArray(parts) || parts.length === 0)
      return json({ error: "parts" }, 400);

    const ordered = [...parts].sort((a, b) => a.n - b.n);
    const body =
      "<CompleteMultipartUpload>" +
      ordered
        .map((p) => `<Part><PartNumber>${Number(p.n)}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`)
        .join("") +
      "</CompleteMultipartUpload>";

    const res = await aws.fetch(
      `${base()}/${encodeURI(key)}?uploadId=${encodeURIComponent(uploadId)}`,
      { method: "POST", body, headers: { "Content-Type": "application/xml" } }
    );
    const text = await res.text();
    // S3 can return 200 with an error document — check for the location tag.
    if (!res.ok || !tag(text, "ETag"))
      return json({ error: "complete", detail: text.slice(0, 300) }, 502);

    return json({ url: `/.netlify/functions/r2/get?key=${encodeURIComponent(key)}` });
  }

  if (action === "abort") {
    if (req.method !== "POST") return json({ error: "method" }, 405);
    const { key, uploadId } = await req.json();
    if (!KEY_RE.test(key || "")) return json({ error: "key" }, 400);
    await aws.fetch(
      `${base()}/${encodeURI(key)}?uploadId=${encodeURIComponent(uploadId)}`,
      { method: "DELETE" }
    );
    return json({ ok: true });
  }

  if (action === "delete") {
    if (req.method !== "POST") return json({ error: "method" }, 405);
    const { key } = await req.json();
    if (!KEY_RE.test(key || "")) return json({ error: "key" }, 400);
    const res = await aws.fetch(`${base()}/${encodeURI(key)}`, { method: "DELETE" });
    return json({ ok: res.ok || res.status === 404 });
  }

  if (action === "get") {
    // Keeps the bucket private: mint a short-lived GET and bounce the browser
    // to it, so downloads stream from R2 and never through this function.
    const key = new URL(req.url).searchParams.get("key") || "";
    if (!KEY_RE.test(key)) return json({ error: "key" }, 400);
    const name = key.split("/").pop();
    // RFC 6266 encoded form: no spaces (query normalisation turns those into
    // "+") and it carries a non-ASCII filename intact.
    const disposition = `attachment;filename*=UTF-8''${encodeURIComponent(name)}`;
    const target =
      `${base()}/${encodeURI(key)}?X-Amz-Expires=3600` +
      `&response-content-disposition=${encodeURIComponent(disposition)}`;
    const signed = await aws.sign(target, { method: "GET", aws: { signQuery: true } });
    return new Response(null, {
      status: 302,
      headers: { Location: signed.url, "Cache-Control": "no-store" },
    });
  }

  return json({ error: "unknown-action" }, 404);
};

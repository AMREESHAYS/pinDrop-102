import { getStore } from "@netlify/blobs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { deleteR2Object, KEY_RE } from "./r2.mjs";

/* ------------------------------------------------------------------ */
/*  One global store keyed by PIN — any browser, any device, same six  */
/*  digits. Everything that decides who may read, change or destroy a  */
/*  drop happens here, never in the browser:                           */
/*                                                                     */
/*  - sealing is create-only, and returns an owner token; only that    */
/*    token can check on or shred the drop                             */
/*  - opens, burn-after-read and download limits are counted here, in  */
/*    the same compare-and-swap that serves the drop, so a reader who  */
/*    skips the client cannot keep a burned drop alive                 */
/*  - wrong guesses are counted per IP; six digits is only a million   */
/*    combinations, so the guess budget is the real lock               */
/*  - an inbox is a PIN sealed empty: anyone with the PIN may fill it  */
/*    once, and from then on only its owner can read it                */
/*  - a password-locked drop is encrypted in the browser; the vault    */
/*    holds only ciphertext and a hash of a proof derived from the     */
/*    password, and hands the ciphertext out only for the right proof  */
/* ------------------------------------------------------------------ */

const HOUR = 3600_000;
export const DEFAULT_FUSE = 24 * HOUR;
export const MAX_FUSE = 7 * 24 * HOUR;
const MIN_FUSE = 60_000;
const NOTE_MAX = 12_000;
const TITLE_MAX = 120;
const LINK_MAX = 2048;
const MAX_FILES = 500;
const MAX_OPENS = 100;
const BODY_MAX = 1_000_000;
const BOX_MAX = 900_000;

/** Wrong guesses one IP gets per window before it is locked out. */
export const MISS_LIMIT = 20;
const MISS_WINDOW = 10 * 60_000;

/** The free relays delete files on their own clock; a drop must not outlive its bytes. */
const RELAY_TTL = { tmpfiles: 48 * HOUR, litterbox: 72 * HOUR };
const RELAY_HOSTS = {
  tmpfiles: ["tmpfiles.org"],
  litterbox: ["catbox.moe"],
  gofile: ["gofile.io"],
};

// Platform-level limit in front of everything below; the miss counter is the precise one.
export const config = {
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ["ip", "domain"] },
};

const drops = () => getStore({ name: "pindrop", consistency: "strong" });
const limits = () => getStore({ name: "pindrop-limits", consistency: "strong" });

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
const fail = (status, error) => json({ error }, status);

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

const ownerMatches = (rec, token) => {
  if (typeof token !== "string" || !token || typeof rec.ownerHash !== "string") return false;
  const a = Buffer.from(sha256(token), "hex");
  const b = Buffer.from(rec.ownerHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};

/* ------------------------- guess budget -------------------------- */

const clientIp = (req, context) =>
  context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
const ipKey = (ip) => `miss/${String(ip).replace(/[^A-Za-z0-9.]/g, "_")}`;

async function missCount(ip) {
  const rec = await limits().get(ipKey(ip), { type: "json" });
  return rec && rec.w === Math.floor(Date.now() / MISS_WINDOW) ? rec.n : 0;
}

// shortcut: read-modify-write, so parallel misses can undercount by a few; fine for a guess budget.
async function addMiss(ip) {
  const w = Math.floor(Date.now() / MISS_WINDOW);
  const n = (await missCount(ip)) + 1;
  await limits().set(ipKey(ip), JSON.stringify({ w, n }));
}

/* --------------------------- validation -------------------------- */

const str = (v, max) => (typeof v === "string" && v.length <= max ? v : null);

function cleanLink(raw) {
  const s = str(raw, LINK_MAX)?.trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function cleanFile(f) {
  if (!f || typeof f !== "object") return null;
  const name = str(f.name, 255);
  const mime = f.mime == null ? "" : str(f.mime, 127);
  const size = Number(f.size);
  const url = str(f.fileUrl, 2048);
  if (!name || mime === null || !Number.isFinite(size) || size < 0 || !url) return null;

  if (f.host === "r2") {
    const m = url.match(/^\/\.netlify\/functions\/r2\/get\?key=([^&]+)$/);
    if (!m || !KEY_RE.test(decodeURIComponent(m[1]))) return null;
  } else if (RELAY_HOSTS[f.host]) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    const ok = u.protocol === "https:" &&
      RELAY_HOSTS[f.host].some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
    if (!ok) return null;
  } else {
    return null;
  }
  return { name, mime, size, fileUrl: url, host: f.host };
}

/** Build the stored record from whitelisted fields only. Returns an error string on bad input. */
export function cleanDrop(pin, body, now = Date.now(), { allowInbox = true } = {}) {
  if (!body || typeof body !== "object") return "body";
  const type = body.type;
  if (!["note", "link", "file", ...(allowInbox ? ["inbox"] : [])].includes(type)) return "type";
  const title = str(body.title ?? "", TITLE_MAX);
  if (title === null) return "title";

  const rec = { v: 2, pin, type, title, createdAt: now, opens: 0 };
  if (body.locked != null && type !== "inbox") {
    const bad = cleanLocked(rec, body.locked, body.r2Keys);
    if (bad) return bad;
  } else if (type === "inbox") {
    rec.inbox = true;
    rec.filled = false;
  } else if (type === "note") {
    const text = str(body.text, NOTE_MAX);
    if (!text || !text.trim()) return "text";
    rec.text = text;
  } else if (type === "link") {
    const link = cleanLink(body.link);
    if (!link) return "link";
    rec.link = link;
  } else {
    if (!Array.isArray(body.files) || body.files.length === 0 || body.files.length > MAX_FILES)
      return "files";
    const files = body.files.map(cleanFile);
    if (files.some((f) => !f)) return "file";
    rec.files = files;
  }

  // Every drop has a fuse: a PIN that lives forever is a PIN someone eventually guesses.
  const wanted = Number(body.expiresAt);
  let expiresAt = Number.isFinite(wanted) ? wanted : now + DEFAULT_FUSE;
  expiresAt = Math.min(Math.max(expiresAt, now + MIN_FUSE), now + MAX_FUSE);
  for (const f of rec.files || []) {
    if (RELAY_TTL[f.host]) expiresAt = Math.min(expiresAt, now + RELAY_TTL[f.host]);
  }
  rec.expiresAt = expiresAt;

  if (rec.inbox) return rec; // only the owner reads an inbox — opens don't apply
  if (body.burnAfterRead === true) rec.burnAfterRead = true;
  if (body.maxOpens != null) {
    const n = Number(body.maxOpens);
    if (!Number.isInteger(n) || n < 1 || n > MAX_OPENS) return "maxOpens";
    rec.maxOpens = n;
  }
  return rec;
}

/** What a reader gets back: never the owner hash, the lock verifier or our R2 keys. */
function publicView(rec) {
  const { ownerHash: _o, lockHash: _l, r2Keys: _k, ...rest } = rec;
  return rest;
}

const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);

/**
 * A locked drop's content is ciphertext we can't inspect, so the browser
 * validates links and file URLs after decrypting. We keep only what the vault
 * itself needs: the salt (public), the verifier, and R2 keys so shredding
 * still deletes the bytes.
 */
function cleanLocked(rec, locked, r2Keys) {
  if (!locked || typeof locked !== "object") return "locked";
  if (!HEX(32).test(locked.salt || "") || !HEX(64).test(locked.verifier || "")) return "locked";
  if (typeof locked.box !== "string" || !locked.box || locked.box.length > BOX_MAX || !/^[A-Za-z0-9_-]+$/.test(locked.box))
    return "box";
  if (r2Keys != null && (!Array.isArray(r2Keys) || r2Keys.length > MAX_FILES || !r2Keys.every((k) => KEY_RE.test(k))))
    return "r2Keys";
  rec.title = "";
  rec.locked = { salt: locked.salt, box: locked.box };
  rec.lockHash = sha256(locked.verifier); // verifier is the proof itself; we keep only its hash
  if (r2Keys?.length) rec.r2Keys = r2Keys;
  return null;
}

/** Records sealed before fuses were mandatory expire a week after creation. */
const expiryOf = (rec) =>
  typeof rec.expiresAt === "number" ? rec.expiresAt : (Number(rec.createdAt) || 0) + MAX_FUSE;

async function shred(pin, rec) {
  await drops().delete(pin);
  const keys = (Array.isArray(rec?.files) ? rec.files : [])
    .filter((f) => f && f.host === "r2")
    .map((f) => String(f.fileUrl).match(/key=([^&]+)/)?.[1])
    .filter(Boolean)
    .map(decodeURIComponent)
    .concat(Array.isArray(rec?.r2Keys) ? rec.r2Keys : []);
  await Promise.all(keys.map((k) => deleteR2Object(k).catch(() => {})));
}

/** Locked drops: no proof shows the prompt (a right PIN isn't a miss); a wrong proof is a guess. */
async function lockGate(rec, auth, ip) {
  if (!rec.locked) return null;
  if (auth == null) return json({ pin: rec.pin, type: rec.type, needsPassword: true, salt: rec.locked.salt }, 401);
  const ok = typeof auth === "string" && HEX(64).test(auth) && typeof rec.lockHash === "string" &&
    timingSafeEqual(Buffer.from(sha256(auth), "hex"), Buffer.from(rec.lockHash, "hex"));
  if (ok) return null;
  await addMiss(ip);
  return json({ error: "wrong-password", needsPassword: true, salt: rec.locked.salt }, 401);
}

/* ----------------------------- routes ----------------------------- */

/** Before it's filled an inbox only says "send here"; after, it opens for its owner alone. */
async function openInbox(rec, token, ip) {
  if (!rec.filled) {
    return json({ pin: rec.pin, type: "inbox", title: rec.title, expiresAt: expiryOf(rec), waiting: true });
  }
  if (!ownerMatches(rec, token)) {
    await addMiss(ip);
    return fail(409, "filled");
  }
  return json({ ...publicView(rec), burned: false });
}

async function fillInbox(pin, req, ip) {
  const raw = await req.text();
  if (raw.length > BODY_MAX) return fail(413, "too-large");
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "not-json");
  }
  if (body && body.locked != null) return fail(400, "locked"); // the owner has no password to open it with
  const content = cleanDrop(pin, body, Date.now(), { allowInbox: false });
  if (typeof content === "string") return fail(400, content);

  const store = drops();
  const got = await store.getWithMetadata(pin, { type: "json" }).catch(() => null);
  const rec = got?.data;
  if (!rec || rec.pin !== pin) {
    await addMiss(ip);
    return fail(404, "unknown");
  }
  if (!rec.inbox || rec.filled) {
    await addMiss(ip);
    return fail(409, "not-an-open-inbox");
  }
  if (expiryOf(rec) <= Date.now()) {
    await shred(pin, rec);
    return fail(410, "expired");
  }
  const { text, link, files, type } = content;
  const next = {
    ...rec,
    type,
    title: content.title || rec.title,
    text,
    link,
    files,
    filled: true,
    filledAt: Date.now(),
    expiresAt: Math.min(expiryOf(rec), content.expiresAt),
  };
  // onlyIfMatch: two senders racing for one inbox — exactly one lands.
  const w = await store.set(pin, JSON.stringify(next), { onlyIfMatch: got.etag });
  if (!w.modified) return fail(409, "not-an-open-inbox");
  return json({ ok: true });
}

async function openDrop(pin, ip, token, auth) {
  const store = drops();
  // Compare-and-swap: if another reader changes the record between our read
  // and write, re-read and try again, so two readers can never both get the
  // "last" open of a burn-after-read drop.
  for (let attempt = 0; attempt < 4; attempt++) {
    const got = await store.getWithMetadata(pin, { type: "json" }).catch(() => null);
    const rec = got?.data;
    if (!rec || typeof rec !== "object" || rec.pin !== pin) {
      if (rec?.burned) return fail(410, "gone");
      await addMiss(ip);
      return fail(404, "unknown");
    }
    if (expiryOf(rec) <= Date.now()) {
      await shred(pin, rec);
      return fail(410, "expired");
    }
    if (rec.inbox) return openInbox(rec, token, ip);
    const gate = await lockGate(rec, auth, ip);
    if (gate) return gate;

    const opens = (Number(rec.opens) || 0) + 1;
    const last = !!rec.burnAfterRead || (!!rec.maxOpens && opens >= rec.maxOpens);
    const next = last ? { burned: true, at: Date.now() } : { ...rec, opens };
    const w = await store.set(pin, JSON.stringify(next), { onlyIfMatch: got.etag });
    if (!w.modified) continue;
    // Burn kills the PIN, not the bytes: this reader still has to download them.
    if (last) await store.delete(pin);
    return json({ ...publicView(rec), opens, burned: last });
  }
  return fail(503, "busy");
}

async function ownerStatus(pin, token, ip) {
  const rec = await drops().get(pin, { type: "json" }).catch(() => null);
  if (!rec || rec.burned || rec.pin !== pin) {
    await addMiss(ip);
    return fail(404, "gone");
  }
  if (!ownerMatches(rec, token)) {
    await addMiss(ip);
    return fail(403, "owner");
  }
  if (expiryOf(rec) <= Date.now()) {
    await shred(pin, rec);
    return fail(404, "gone");
  }
  return json({
    opens: rec.opens || 0,
    expiresAt: expiryOf(rec),
    maxOpens: rec.maxOpens ?? null,
    filled: rec.inbox ? !!rec.filled : undefined,
  });
}

async function createDrop(pin, req, ip) {
  const raw = await req.text();
  if (raw.length > BODY_MAX) return fail(413, "too-large");
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "not-json");
  }
  const rec = cleanDrop(pin, body);
  if (typeof rec === "string") return fail(400, rec);

  const owner = randomBytes(32).toString("hex");
  rec.ownerHash = sha256(owner);
  const w = await drops().set(pin, JSON.stringify(rec), { onlyIfNew: true });
  if (!w.modified) {
    // A taken PIN tells the caller a drop exists there — that's a guess like any other.
    await addMiss(ip);
    return fail(409, "taken");
  }
  return json({ owner, expiresAt: rec.expiresAt }, 201);
}

async function destroy(pin, token, ip) {
  const rec = await drops().get(pin, { type: "json" }).catch(() => null);
  if (!rec || rec.burned) return json({ ok: true }); // already gone either way
  if (!ownerMatches(rec, token)) {
    await addMiss(ip);
    return fail(403, "owner");
  }
  await shred(pin, rec);
  return json({ ok: true });
}

export default async (req, context) => {
  // /.netlify/functions/vault/<pin>[/status]
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const status = parts[parts.length - 1] === "status";
  const pin = parts[parts.length - (status ? 2 : 1)] || "";
  if (!/^\d{6}$/.test(pin)) return fail(400, "bad-pin");

  const ip = clientIp(req, context);
  if ((await missCount(ip)) >= MISS_LIMIT) return fail(429, "too-many-guesses");
  const token = req.headers.get("x-owner-token");

  if (status && req.method === "GET") return ownerStatus(pin, token, ip);
  if (status) return fail(405, "method");
  if (req.method === "GET") return openDrop(pin, ip, token, req.headers.get("x-drop-auth"));
  if (req.method === "POST") return createDrop(pin, req, ip);
  if (req.method === "PUT") return fillInbox(pin, req, ip);
  if (req.method === "DELETE") return destroy(pin, token, ip);
  return fail(405, "method");
};

/* ------------------------------------------------------------------ */
/*  PinDrop vault — local shelf + global cloud layer                   */
/*                                                                     */
/*  Local:  drops you sealed in THIS browser (instant, offline).       */
/*  Cloud:  one global store behind our own Netlify Function, keyed by */
/*          PIN. Any browser, anywhere, can GET /vault/{pin} — the six  */
/*          digits alone unlock the drop, no bucket address needed.     */
/*  Files:  our own R2 bucket when it's configured — resumable, so a   */
/*          dropped connection costs one 8 MB part, not the whole      */
/*          upload. Otherwise anonymous relays: tmpfiles for small     */
/*          files, GoFile for big. The drop JSON only carries URLs.    */
/* ------------------------------------------------------------------ */

import { deriveKeys, lockValue, unlockValue } from "./lock";
import { r2Enabled, uploadToR2 } from "./r2";

/** "inbox" is a PIN sealed empty, waiting for someone else to send into it. */
export type DropType = "note" | "link" | "file" | "inbox";

export type RelayHost = "tmpfiles" | "litterbox" | "gofile" | "r2";

export interface FileMeta {
  name: string;
  mime: string;
  size: number;
  /** direct link for tmpfiles/litterbox, a landing page for gofile */
  fileUrl: string;
  host: RelayHost;
}

/** gofile hands back a landing page, not a file — it can't be blob-downloaded. */
export const isDirectLink = (f: FileMeta): boolean => f.host !== "gofile";

export interface Drop {
  id: string;
  pin: string;
  type: DropType;
  title: string;
  createdAt: number;
  expiresAt?: number;
  burnAfterRead?: boolean;
  opens: number;
  payload: {
    text?: string;
    link?: string;
    files?: FileMeta[];
    /** legacy single-file records — read only, never written */
    file?: FileMeta;
  };
  /** stop serving after this many opens (burn-after-read is 1) */
  maxOpens?: number;
  /** present when published to the cloud vault */
  remote?: { bucket: string };
  /** secret the vault minted at seal time — the only way to check on or shred the drop */
  owner?: string;
  /** sealed with a password: the vault holds only ciphertext */
  locked?: boolean;
}

export type OpenVerdict =
  | { status: "ok"; drop: Drop; burned: boolean; via: "local" | "cloud" }
  | { status: "unknown" }
  | { status: "expired" }
  | { status: "limited" }
  | { status: "inbox"; title: string }
  | { status: "filled" }
  | { status: "locked" }
  | { status: "offline" };

/** Files on a drop, old single-file records included. */
export const dropFiles = (d: Drop): FileMeta[] =>
  d.payload.files?.length ? d.payload.files : d.payload.file ? [d.payload.file] : [];

export const totalBytes = (files: { size: number }[]): number =>
  files.reduce((n, f) => n + f.size, 0);

export const NOTE_MAX = 12000;
export const FILE_MAX = 50 * 1024 * 1024 * 1024; // 50 GB
export const FILE_MAX_LABEL = "50 GB";
/** above this a file goes to gofile; below it, tmpfiles gives a direct link */
export const SMALL_FILE_MAX = 100 * 1024 * 1024;
/** blob-downloading past this buffers the whole file in RAM and kills the tab */
export const BLOB_DOWNLOAD_MAX = 100 * 1024 * 1024;
const API = "/.netlify/functions/vault";
const BUCKET = "global";
const LS_VAULT = "pindrop.vault.v2";

export const TYPE_LABEL: Record<DropType, string> = {
  note: "Note",
  link: "Link",
  file: "File",
  inbox: "Inbox",
};

/* ----------------------------- utils ------------------------------ */

export const uid = (): string =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 9);

export const generatePin = (): string => {
  const a = new Uint32Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, (n) => n % 10).join("");
};

export const isExpired = (d: Pick<Drop, "expiresAt">): boolean =>
  !!d.expiresAt && d.expiresAt <= Date.now();

export const formatBytes = (b: number): string => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

export function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function expiryLabel(d: Drop): string {
  if (!d.expiresAt) return "no fuse";
  const ms = d.expiresAt - Date.now();
  if (ms <= 0) return "expired";
  const h = ms / 36e5;
  if (h < 1) return `${Math.max(1, Math.round(ms / 6e4))}m left`;
  if (h < 48) return `${Math.round(h)}h left`;
  return `${Math.round(h / 24)}d left`;
}

/* --------------------------- local vault --------------------------- */

export function loadVault(): Drop[] {
  try {
    const raw = localStorage.getItem(LS_VAULT);
    if (!raw) return [];
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((d) => d && typeof d === "object" && typeof d.pin === "string" && d.payload);
  } catch {
    return [];
  }
}

/** returns false when the browser refuses (storage full) */
export function saveVault(drops: Drop[]): boolean {
  try {
    localStorage.setItem(LS_VAULT, JSON.stringify(drops));
    return true;
  } catch {
    return false;
  }
}

export const vaultSizeBytes = (drops: Drop[]): number =>
  new Blob([JSON.stringify(drops)]).size;

/* ------------------------- bucket bookkeeping ---------------------- */
/* One global store now lives behind our own Netlify Function, so there is
   nothing per-browser to remember. The bucket argument is kept so callers
   and existing #/r/<bucket>/<pin> share links keep working. */

async function timedFetch(url: string, init?: RequestInit, ms = 10000): Promise<Response> {
  const c = new AbortController();
  const t = window.setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: c.signal });
  } finally {
    window.clearTimeout(t);
  }
}

/**
 * Publish the drop under its PIN. The vault is create-only: a taken PIN throws
 * "taken" so the caller can mint another. Returns the owner token and the fuse
 * the vault actually set, which can be shorter than asked for.
 */
const dropBody = (d: Drop) =>
  JSON.stringify({
      type: d.type,
      title: d.title,
      expiresAt: d.expiresAt,
      burnAfterRead: d.burnAfterRead || undefined,
      maxOpens: d.maxOpens,
      text: d.payload.text,
      link: d.payload.link,
      files: d.type === "file" ? dropFiles(d) : undefined,
  });

const RELAY_TTL: Partial<Record<RelayHost, number>> = { tmpfiles: 48 * 36e5, litterbox: 72 * 36e5 };

/**
 * The vault can't see inside a locked drop, so the browser does what the vault
 * would: cut the fuse to the relay lifetime and list the R2 keys to delete on shred.
 */
async function lockedBody(d: Drop, password: string): Promise<string> {
  const files = d.type === "file" ? dropFiles(d) : [];
  let expiresAt = d.expiresAt ?? Date.now() + 24 * 36e5;
  for (const f of files) if (RELAY_TTL[f.host]) expiresAt = Math.min(expiresAt, Date.now() + RELAY_TTL[f.host]!);
  const r2Keys = files
    .filter((f) => f.host === "r2")
    .map((f) => new URL(f.fileUrl, "https://x").searchParams.get("key"))
    .filter((k): k is string => !!k);
  return JSON.stringify({
    type: d.type,
    expiresAt,
    burnAfterRead: d.burnAfterRead || undefined,
    maxOpens: d.maxOpens,
    locked: await lockValue({ title: d.title, text: d.payload.text, link: d.payload.link, files }, password),
    r2Keys: r2Keys.length ? r2Keys : undefined,
  });
}

export async function publishDrop(d: Drop, password?: string): Promise<{ owner: string; expiresAt: number }> {
  const res = await timedFetch(`${API}/${d.pin}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: password ? await lockedBody(d, password) : dropBody(d),
  });
  if (res.status === 409) throw new Error("taken");
  if (!res.ok) throw new Error(`publish-${res.status}`);
  return (await res.json()) as { owner: string; expiresAt: number };
}

/** Send a drop into someone else's inbox PIN. It lands once; after that only they can open it. */
export async function fillInbox(pin: string, d: Drop): Promise<void> {
  const res = await timedFetch(`${API}/${pin}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: dropBody(d),
  });
  if (!res.ok) throw new Error(`fill-${res.status}`);
}

/** The owner reading what arrived in their inbox. */
export async function openOwnInbox(drop: Drop): Promise<Drop | null> {
  if (!drop.owner) return null;
  try {
    const res = await timedFetch(`${API}/${drop.pin}`, { headers: { "X-Owner-Token": drop.owner } }, 9000);
    if (!res.ok) return null;
    const raw = (await res.json()) as Record<string, unknown>;
    return { ...recordToDrop(raw), id: drop.id, owner: drop.owner };
  } catch {
    return null;
  }
}

/**
 * Shred a drop everywhere. The vault deletes the record and any R2 bytes, but
 * only for the holder of the owner token.
 */
export async function destroyDrop(drop: Drop): Promise<void> {
  if (!drop.remote || !drop.owner) return;
  try {
    await timedFetch(`${API}/${drop.pin}`, { method: "DELETE", headers: { "X-Owner-Token": drop.owner } }, 8000);
  } catch {
    /* best effort — the fuse is the backstop */
  }
}

export type OwnerStatus = { opens: number; expiresAt: number; filled?: boolean } | "gone" | "offline";

/** Owner-only check: how often it's been opened, or whether it's gone. Never counts an open. */
export async function fetchOwnerStatus(drop: Drop): Promise<OwnerStatus> {
  if (!drop.owner) return "offline";
  try {
    const res = await timedFetch(`${API}/${drop.pin}/status`, { headers: { "X-Owner-Token": drop.owner } }, 8000);
    if (res.status === 404 || res.status === 403) return "gone";
    if (!res.ok) return "offline";
    return (await res.json()) as { opens: number; expiresAt: number; filled?: boolean };
  } catch {
    return "offline";
  }
}

const RELAYS: RelayHost[] = ["tmpfiles", "litterbox", "gofile", "r2"];

/** Same rule the vault applies to unlocked drops; locked ones only get checked here, after decrypting. */
const safeFile = (f: FileMeta): boolean =>
  !!f &&
  typeof f.fileUrl === "string" &&
  RELAYS.includes(f.host) &&
  (f.host === "r2" ? f.fileUrl.startsWith("/.netlify/functions/r2/get?key=") : f.fileUrl.startsWith("https://"));

function recordToDrop(raw: Record<string, unknown>): Drop {
  const list = Array.isArray(raw.files) ? (raw.files as FileMeta[]) : [];
  const legacy = raw.file as FileMeta | undefined;
  const files = (list.length ? list : legacy ? [legacy] : []).filter(safeFile);
  return {
    id: `r-${String(raw.pin)}`,
    pin: String(raw.pin),
    type: (raw.type as DropType) || "note",
    title: String(raw.title || "Untitled drop"),
    createdAt: Number(raw.createdAt) || Date.now(),
    expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : undefined,
    burnAfterRead: !!raw.burnAfterRead,
    maxOpens: typeof raw.maxOpens === "number" ? raw.maxOpens : undefined,
    opens: Number(raw.opens) || 0,
    payload: {
      text: typeof raw.text === "string" ? raw.text : undefined,
      link: typeof raw.link === "string" ? raw.link : undefined,
      files: files.length ? files : undefined,
    },
    remote: { bucket: BUCKET },
  };
}

/**
 * Open a PIN in the global vault. The vault counts the open, and burns the
 * drop when this was its last allowed open — `burned` says so.
 */
export type OpenResult = Awaited<ReturnType<typeof fetchDropByPin>>;

export async function fetchDropByPin(
  pin: string,
  auth?: string
): Promise<
  | { drop: Drop; burned: boolean; box?: string }
  | { inbox: { pin: string; title: string } }
  | { needsPassword: { salt: string; wrong: boolean } }
  | "none"
  | "expired"
  | "limited"
  | "filled"
  | "offline"
> {
  try {
    const res = await timedFetch(`${API}/${pin}`, auth ? { headers: { "X-Drop-Auth": auth } } : undefined, 9000);
    if (res.status === 429) return "limited";
    if (res.status === 401) {
      const j = (await res.json()) as { salt?: string; error?: string };
      if (!j.salt || !/^[0-9a-f]{32}$/.test(j.salt)) return "none";
      return { needsPassword: { salt: j.salt, wrong: j.error === "wrong-password" } };
    }
    if (res.status === 410) return "expired";
    if (res.status === 409) return "filled";
    if (!res.ok) return "none";
    const raw = JSON.parse(await res.text()) as Record<string, unknown>;
    if (!raw || raw.pin !== pin) return "none";
    if (raw.type === "inbox" && raw.waiting) return { inbox: { pin, title: String(raw.title || "") } };
    const box = (raw.locked as { box?: unknown } | undefined)?.box;
    return { drop: recordToDrop(raw), burned: raw.burned === true, box: typeof box === "string" ? box : undefined };
  } catch (e) {
    // JSON.parse failure means a real but corrupt record — not a network problem.
    return e instanceof SyntaxError ? "none" : "offline";
  }
}

/**
 * Open a password-locked PIN: derive the proof, let the vault check it (a wrong
 * one costs a guess, never an open), then decrypt what it hands back.
 */
export async function unlockDrop(pin: string, salt: string, password: string): Promise<OpenResult | "corrupt"> {
  const { key, auth } = await deriveKeys(password, salt);
  const res = await fetchDropByPin(pin, auth);
  if (typeof res !== "object" || !("drop" in res) || !res.box) return res;
  let inner: Record<string, unknown>;
  try {
    inner = (await unlockValue(res.box, key)) as Record<string, unknown>;
  } catch {
    return "corrupt"; // right proof, undecryptable box: tampered or broken record
  }
  const opened = recordToDrop({ ...inner, pin, type: res.drop.type, createdAt: res.drop.createdAt,
    expiresAt: res.drop.expiresAt, burnAfterRead: res.drop.burnAfterRead, maxOpens: res.drop.maxOpens, opens: res.drop.opens });
  return { drop: { ...opened, locked: true }, burned: res.burned };
}

/* --------------------------- file relays --------------------------- */

/** Bytes sent for the file currently in flight. */
export type ByteProgress = (sent: number, total: number) => void;

/**
 * POST a FormData with upload progress. fetch() cannot report bytes sent, and
 * a multi-gigabyte upload with no progress is indistinguishable from a hang.
 */
function xhrUpload(
  url: string,
  form: FormData,
  onBytes?: ByteProgress,
  timeoutMs = 0
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.timeout = timeoutMs; // 0 = no timeout; big files take as long as they take
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onBytes?.(e.loaded, e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve(xhr.responseText)
        : reject(new Error(`http-${xhr.status}`));
    xhr.onerror = () => reject(new Error("network"));
    xhr.ontimeout = () => reject(new Error("timeout"));
    xhr.onabort = () => reject(new Error("aborted"));
    xhr.send(form);
  });
}

/** Our own R2 bucket: resumable, and the only relay we actually control. */
async function uploadToR2Relay(file: File, onBytes?: ByteProgress): Promise<FileMeta> {
  if (!(await r2Enabled())) throw new Error("r2-off");
  const url = await uploadToR2(file, onBytes);
  return { name: file.name, mime: file.type, size: file.size, fileUrl: url, host: "r2" };
}

/** GoFile: anonymous, no advertised per-file cap. Returns a landing page URL. */
async function uploadToGofile(file: File, onBytes?: ByteProgress): Promise<FileMeta> {
  const list = (await (await timedFetch("https://api.gofile.io/servers", undefined, 15000)).json()) as {
    status?: string;
    data?: { servers?: { name: string }[] };
  };
  const server = list?.data?.servers?.[0]?.name;
  if (list?.status !== "ok" || !server) throw new Error("gofile-servers");

  const fd = new FormData();
  fd.append("file", file);
  const json = JSON.parse(
    await xhrUpload(`https://${server}.gofile.io/contents/uploadfile`, fd, onBytes)
  ) as { status?: string; data?: { downloadPage?: string } };
  const page = json?.data?.downloadPage;
  if (json?.status !== "ok" || !page) throw new Error("gofile-upload");
  return { name: file.name, mime: file.type, size: file.size, fileUrl: page, host: "gofile" };
}

/** tmpfiles.org: ≤100MB, 48h, but hands back a direct link. */
async function uploadToTmpfiles(file: File, onBytes?: ByteProgress): Promise<FileMeta> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("expire", "172800");
  const json = JSON.parse(
    await xhrUpload("https://tmpfiles.org/api/v1/upload", fd, onBytes, 300000)
  ) as { status?: string; data?: { url?: string } };
  const url = json?.data?.url;
  if (json?.status !== "success" || !url) throw new Error("tmpfiles");
  return {
    name: file.name,
    mime: file.type,
    size: file.size,
    fileUrl: url.replace("tmpfiles.org/", "tmpfiles.org/dl/"),
    host: "tmpfiles",
  };
}

/** litterbox: ≤1GB, 72h, direct link. Middle ground when tmpfiles refuses. */
async function uploadToLitterbox(file: File, onBytes?: ByteProgress): Promise<FileMeta> {
  const fd = new FormData();
  fd.append("reqtype", "fileupload");
  fd.append("time", "72h");
  fd.append("fileToUpload", file);
  const url = (
    await xhrUpload("https://litterbox.catbox.moe/resources/internals/api.php", fd, onBytes)
  ).trim();
  if (!/^https:\/\//.test(url)) throw new Error("litterbox");
  return { name: file.name, mime: file.type, size: file.size, fileUrl: url, host: "litterbox" };
}

/**
 * Relay one file. Small files prefer the hosts that return a direct link so
 * the download saves straight to disk; anything bigger goes to GoFile, which
 * is the only anonymous relay here without a size cap.
 */
export async function uploadFile(file: File, onBytes?: ByteProgress): Promise<FileMeta> {
  // R2 first whenever it's configured: it resumes, and nothing else here does.
  const chain =
    file.size <= SMALL_FILE_MAX
      ? [uploadToR2Relay, uploadToTmpfiles, uploadToLitterbox, uploadToGofile]
      : [uploadToR2Relay, uploadToGofile, uploadToLitterbox];
  let lastError: unknown;
  for (const relay of chain) {
    try {
      return await relay(file, onBytes);
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`relay-failed: ${String(lastError)}`);
}

/**
 * Relay a batch, one at a time — the free relays throttle concurrent uploads.
 * Reports progress per file and returns which ones the relays refused.
 */
export interface BatchProgress {
  done: number;
  total: number;
  name: string;
  /** bytes sent for the file in flight */
  sent: number;
  /** size of the file in flight */
  bytes: number;
}

export async function uploadFiles(
  files: File[],
  onProgress?: (p: BatchProgress) => void
): Promise<{ uploaded: FileMeta[]; failed: string[] }> {
  const uploaded: FileMeta[] = [];
  const failed: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    onProgress?.({ done: i, total: files.length, name: f.name, sent: 0, bytes: f.size });
    try {
      uploaded.push(
        await uploadFile(f, (sent, bytes) =>
          onProgress?.({ done: i, total: files.length, name: f.name, sent, bytes })
        )
      );
    } catch {
      failed.push(f.name);
    }
  }
  onProgress?.({ done: files.length, total: files.length, name: "", sent: 0, bytes: 0 });
  return { uploaded, failed };
}

/* --------------------------- share links --------------------------- */

function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64decode(s: string): string {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Self-contained link payload — the drop travels inside the URL itself. */
export function encodeSelfContained(d: Drop): string | null {
  // A URL that carries the content can't be burned, limited or expired.
  if (d.type === "file" || d.burnAfterRead || d.maxOpens || d.expiresAt) return null;
  try {
    const json = JSON.stringify({
      s: 1,
      pin: d.pin,
      type: d.type,
      title: d.title,
      createdAt: d.createdAt,
      text: d.payload.text,
      link: d.payload.link,
    });
    return b64encode(json);
  } catch {
    return null;
  }
}

export function decodeSelfContained(payload: string): Drop | null {
  try {
    const o = JSON.parse(b64decode(payload)) as Record<string, unknown>;
    if (o.s !== 1 || typeof o.pin !== "string") return null;
    return {
      id: `s-${o.pin}`,
      pin: o.pin,
      type: (o.type as DropType) || "note",
      title: String(o.title || "Shared drop"),
      createdAt: Number(o.createdAt) || Date.now(),
      opens: 0,
      payload: {
        text: typeof o.text === "string" ? o.text : undefined,
        link: typeof o.link === "string" ? o.link : undefined,
      },
    };
  } catch {
    return null;
  }
}

const base = () => window.location.origin + window.location.pathname;

export function buildShareLink(d: Drop): string {
  if (d.remote) return `${base()}#/d/${d.pin}`;
  const sc = encodeSelfContained(d);
  if (sc) return `${base()}#/s/${sc}`;
  return `${base()}#/d/${d.pin}`;
}

export function buildOfflineLink(d: Drop): string | null {
  const sc = encodeSelfContained(d);
  return sc ? `${base()}#/s/${sc}` : null;
}

export type HashRoute =
  | { kind: "autotype"; pin: string }
  | { kind: "selfcontained"; drop: Drop };

export function parseHash(hash: string): HashRoute | null {
  const h = hash.replace(/^#\/?/, "");
  if (!h) return null;
  const parts = h.split("/");
  // old share links: #/r/<bucket>/<pin>
  if (parts[0] === "r" && parts[2] && /^\d{6}$/.test(parts[2])) {
    return { kind: "autotype", pin: parts[2] };
  }
  if (parts[0] === "s" && parts[1]) {
    const drop = decodeSelfContained(parts[1]);
    if (drop) return { kind: "selfcontained", drop };
  }
  if (parts[0] === "d" && parts[1] && /^\d{6}$/.test(parts[1])) {
    return { kind: "autotype", pin: parts[1] };
  }
  return null;
}

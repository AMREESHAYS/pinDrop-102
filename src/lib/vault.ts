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

import { deleteFromR2, r2Enabled, uploadToR2 } from "./r2";

export type DropType = "note" | "link" | "file";

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
  /** present when published to the cloud bucket */
  remote?: { bucket: string };
}

export type OpenVerdict =
  | { status: "ok"; drop: Drop; burned: boolean; via: "local" | "cloud" }
  | { status: "unknown" }
  | { status: "expired" }
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

export const getOwnBucket = (): string => BUCKET;
export const getKnownBuckets = (): string[] => [BUCKET];
export function rememberBucket(_id: string) {
  /* no-op — every browser reads the same store */
}

/* ----------------------------- cloud ------------------------------- */

async function timedFetch(url: string, init?: RequestInit, ms = 10000): Promise<Response> {
  const c = new AbortController();
  const t = window.setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: c.signal });
  } finally {
    window.clearTimeout(t);
  }
}

export async function ensureBucket(): Promise<string> {
  return BUCKET;
}

export async function cloudPinTaken(_bucket: string, pin: string): Promise<boolean> {
  try {
    const res = await timedFetch(`${API}/${pin}`, undefined, 8000);
    return res.ok;
  } catch {
    return false; // can't tell — treat as free rather than block sealing
  }
}

/** Publish the drop under its PIN. Throws when the cloud is unreachable. */
export async function publishDrop(_bucket: string, d: Drop): Promise<void> {
  const body = JSON.stringify({
    v: 1,
    pin: d.pin,
    type: d.type,
    title: d.title,
    createdAt: d.createdAt,
    expiresAt: d.expiresAt,
    burnAfterRead: d.burnAfterRead || undefined,
    opens: d.opens,
    text: d.payload.text,
    link: d.payload.link,
    files: dropFiles(d),
  });
  const res = await timedFetch(`${API}/${d.pin}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) throw new Error("publish");
}

/**
 * Shred a drop everywhere: the PIN record, and any bytes we actually own.
 * The free relays expire on their own; ours would sit there forever, and the
 * UI promises a burned drop is gone.
 */
export async function destroyDrop(drop: Drop): Promise<void> {
  await deleteRemote("", drop.pin);
  await Promise.all(
    dropFiles(drop)
      .filter((f) => f.host === "r2")
      .map((f) => deleteFromR2(f.fileUrl))
  );
}

export async function deleteRemote(_bucket: string, pin: string): Promise<void> {
  try {
    await timedFetch(`${API}/${pin}`, { method: "DELETE" }, 8000);
  } catch {
    /* best effort */
  }
}

async function bumpOpens(raw: Record<string, unknown>) {
  try {
    const next: Record<string, unknown> = { ...raw, opens: (Number(raw.opens) || 0) + 1 };
    await timedFetch(`${API}/${String(next.pin)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    }, 8000);
  } catch {
    /* cosmetic */
  }
}

interface CloudRecord {
  raw: Record<string, unknown>;
  drop: Drop;
  bucket: string;
}

function recordToDrop(bucket: string, raw: Record<string, unknown>): Drop {
  const list = Array.isArray(raw.files) ? (raw.files as FileMeta[]) : [];
  const legacy = raw.file as FileMeta | undefined;
  const files = (list.length ? list : legacy ? [legacy] : []).filter((f) => f && f.fileUrl);
  return {
    id: `r-${bucket}-${String(raw.pin)}`,
    pin: String(raw.pin),
    type: (raw.type as DropType) || "note",
    title: String(raw.title || "Untitled drop"),
    createdAt: Number(raw.createdAt) || Date.now(),
    expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : undefined,
    burnAfterRead: !!raw.burnAfterRead,
    opens: Number(raw.opens) || 0,
    payload: {
      text: typeof raw.text === "string" ? raw.text : undefined,
      link: typeof raw.link === "string" ? raw.link : undefined,
      files: files.length ? files : undefined,
    },
    remote: { bucket },
  };
}

/**
 * Look the PIN up in the global store.
 * Returns the drop, "none" (404/410/garbage), or "offline" (network failed).
 */
export async function fetchDropByPin(
  pin: string,
  _buckets?: string[]
): Promise<CloudRecord | "none" | "offline"> {
  try {
    const res = await timedFetch(`${API}/${pin}`, undefined, 9000);
    if (!res.ok) return "none";
    const raw = JSON.parse(await res.text()) as Record<string, unknown>;
    if (!raw || raw.pin !== pin) return "none";
    return { raw, drop: recordToDrop(BUCKET, raw), bucket: BUCKET };
  } catch (e) {
    // JSON.parse failure means a real but corrupt record — not a network problem.
    return e instanceof SyntaxError ? "none" : "offline";
  }
}

export async function registerCloudOpen(rec: CloudRecord, burn: boolean): Promise<void> {
  if (burn) {
    await deleteRemote(rec.bucket, rec.drop.pin);
  } else {
    await bumpOpens(rec.raw);
  }
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
  if (d.type === "file") return null;
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
  if (d.remote) return `${base()}#/r/${d.remote.bucket}/${d.pin}`;
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
  | { kind: "remote"; bucket: string; pin: string }
  | { kind: "selfcontained"; drop: Drop };

export function parseHash(hash: string): HashRoute | null {
  const h = hash.replace(/^#\/?/, "");
  if (!h) return null;
  const parts = h.split("/");
  if (parts[0] === "r" && parts[1] && parts[2] && /^\d{6}$/.test(parts[2])) {
    return { kind: "remote", bucket: parts[1].replace(/[^A-Za-z0-9-]/g, ""), pin: parts[2] };
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

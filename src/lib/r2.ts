/* ------------------------------------------------------------------ */
/*  Resumable uploads to R2, one part at a time.                       */
/*                                                                     */
/*  Each part is its own presigned PUT, so a dropped connection costs  */
/*  only the part in flight. Finished parts are written to localStorage*/
/*  keyed by the file's identity, so a reload — or a phone that killed */
/*  the tab — picks up where it left off instead of restarting 40 GB.  */
/* ------------------------------------------------------------------ */

const API = "/.netlify/functions/r2";
const LS_PREFIX = "pindrop.upload.";
/** parts in flight; low enough that a cheap phone isn't holding much */
const CONCURRENCY = 3;
const PART_RETRIES = 3;

export interface R2Session {
  key: string;
  uploadId: string;
  partSize: number;
  parts: number;
}

interface DonePart {
  n: number;
  etag: string;
}

interface Saved extends R2Session {
  done: DonePart[];
  savedAt: number;
}

export type UploadProgress = (sent: number, total: number) => void;

/** Identity of a file as far as resuming is concerned. */
const sigOf = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;
const slotFor = (f: File) => LS_PREFIX + sigOf(f);

function readSaved(file: File): Saved | null {
  try {
    const raw = localStorage.getItem(slotFor(file));
    if (!raw) return null;
    const v = JSON.parse(raw) as Saved;
    if (!v?.key || !v.uploadId || !Array.isArray(v.done)) return null;
    // A stale upload id is worse than no resume — R2 expires them.
    if (Date.now() - (v.savedAt || 0) > 24 * 3600 * 1000) {
      clearSaved(file);
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

function writeSaved(file: File, s: Saved) {
  try {
    localStorage.setItem(slotFor(file), JSON.stringify({ ...s, savedAt: Date.now() }));
  } catch {
    /* storage full — the upload still works, it just won't resume */
  }
}

export function clearSaved(file: File) {
  try {
    localStorage.removeItem(slotFor(file));
  } catch {
    /* ignore */
  }
}

/** Is a half-finished upload waiting for this exact file? */
export function resumableBytes(file: File): number {
  const saved = readSaved(file);
  if (!saved) return 0;
  return saved.done.reduce(
    (sum, p) => sum + Math.min(saved.partSize, file.size - (p.n - 1) * saved.partSize),
    0
  );
}

let cachedEnabled: boolean | null = null;

/** Is R2 wired up on this deploy? Cached — the answer can't change mid-session. */
export async function r2Enabled(): Promise<boolean> {
  if (cachedEnabled !== null) return cachedEnabled;
  try {
    const res = await fetch(`${API}/config`);
    const body = (await res.json()) as { enabled?: boolean };
    cachedEnabled = res.ok && !!body.enabled;
  } catch {
    cachedEnabled = false;
  }
  return cachedEnabled;
}

async function postJson<T>(action: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${action}-${res.status}`);
  return (await res.json()) as T;
}

/** PUT one part, reporting bytes as they leave. Returns the part's ETag. */
function putPart(
  url: string,
  blob: Blob,
  onBytes: (loaded: number) => void,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onBytes(e.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader("ETag");
      if (xhr.status >= 200 && xhr.status < 300 && etag) {
        onBytes(blob.size);
        resolve(etag);
      } else {
        reject(new Error(`part-${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("network"));
    xhr.onabort = () => reject(new Error("aborted"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

/**
 * Upload a file to R2 in parts, resuming any run left half-finished.
 * Returns the download URL. Throws if the upload cannot be completed.
 */
/** Delete the stored object behind an r2 file URL. Best effort. */
export async function deleteFromR2(fileUrl: string): Promise<void> {
  const key = new URL(fileUrl, location.origin).searchParams.get("key");
  if (!key) return;
  try {
    await fetch(`${API}/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
  } catch {
    /* best effort — a lifecycle rule is the backstop */
  }
}

export async function uploadToR2(
  file: File,
  onProgress?: UploadProgress,
  signal?: AbortSignal
): Promise<string> {
  const saved = readSaved(file);
  const session: R2Session = saved
    ? { key: saved.key, uploadId: saved.uploadId, partSize: saved.partSize, parts: saved.parts }
    : await postJson<R2Session>("create", { name: file.name, size: file.size, mime: file.type });

  const done = new Map<number, string>((saved?.done || []).map((p) => [p.n, p.etag]));
  const pending: number[] = [];
  for (let n = 1; n <= session.parts; n++) if (!done.has(n)) pending.push(n);

  /** Real byte length of a part — the last one is short. */
  const sizeOfPart = (n: number) =>
    Math.min(session.partSize, file.size - (n - 1) * session.partSize);

  // Bytes already banked, including by a previous run, so the bar neither
  // restarts at 0 nor drops back when a part finishes and leaves the flight map.
  let banked = 0;
  for (const n of done.keys()) banked += sizeOfPart(n);
  const inFlight = new Map<number, number>();
  const report = () => {
    let sent = banked;
    for (const v of inFlight.values()) sent += v;
    onProgress?.(Math.min(sent, file.size), file.size);
  };
  report();

  // A 50 GB file is 6400 parts. Re-serialising the whole done-list after each
  // one is O(n²) string work that a cheap phone feels near the end, so write at
  // most once a second — and always on the last part, so nothing is lost.
  let lastWrite = 0;
  const persist = (force = false) => {
    const now = Date.now();
    if (!force && now - lastWrite < 1000) return;
    lastWrite = now;
    writeSaved(file, {
      ...session,
      done: [...done].map(([n, etag]) => ({ n, etag })),
      savedAt: now,
    });
  };

  // Sign in batches — one round trip per 100 parts instead of per part.
  const signCache = new Map<number, string>();
  const signBatch = async (nums: number[]) => {
    const missing = nums.filter((n) => !signCache.has(n));
    if (missing.length === 0) return;
    const { urls } = await postJson<{ urls: Record<string, string> }>("sign", {
      key: session.key,
      uploadId: session.uploadId,
      partNumbers: missing,
    });
    for (const [n, url] of Object.entries(urls)) signCache.set(Number(n), url);
  };

  let cursor = 0;
  let failure: unknown = null;

  const worker = async () => {
    while (cursor < pending.length && !failure) {
      if (signal?.aborted) throw new Error("aborted");
      // Hold this part's own index: `cursor` is shared, and the other workers
      // move it on, so a retry must not re-sign from wherever it landed.
      const idx = cursor++;
      const n = pending[idx];
      const start = (n - 1) * session.partSize;
      const blob = file.slice(start, Math.min(start + session.partSize, file.size));

      let lastError: unknown;
      for (let attempt = 0; attempt < PART_RETRIES; attempt++) {
        try {
          await signBatch([n, ...pending.slice(idx + 1, idx + 100)]);
          const url = signCache.get(n);
          if (!url) throw new Error("unsigned");
          const etag = await putPart(url, blob, (loaded) => {
            inFlight.set(n, loaded);
            report();
          }, signal);
          done.set(n, etag);
          inFlight.delete(n);
          banked += sizeOfPart(n);
          persist(done.size === session.parts);
          report();
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
          inFlight.delete(n);
          // A signature can expire mid-run; drop it and sign again.
          signCache.delete(n);
          if (String(e).includes("aborted")) throw e;
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
      if (lastError) {
        failure = lastError;
        throw lastError;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length || 1) }, worker));

  const { url } = await postJson<{ url: string }>("complete", {
    key: session.key,
    uploadId: session.uploadId,
    parts: [...done].map(([n, etag]) => ({ n, etag })),
  });
  clearSaved(file);
  return url;
}

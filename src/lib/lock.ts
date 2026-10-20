/* ------------------------------------------------------------------ */
/*  Password locks, done in the browser.                               */
/*                                                                     */
/*  PBKDF2 stretches the password into 64 bytes: the first half is the */
/*  AES-GCM key, the second half a proof sent to the vault. The vault  */
/*  stores only a hash of the proof and releases the ciphertext for    */
/*  the right one, so a wrong password neither burns the drop nor      */
/*  hands out anything to crack offline. Neither half reveals the      */
/*  other without brute-forcing the password itself.                   */
/* ------------------------------------------------------------------ */

const ITERATIONS = 600_000; // OWASP 2023 guidance for PBKDF2-SHA256
export const PASSWORD_MIN = 6;

const enc = new TextEncoder();
const dec = new TextDecoder();

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));

function toB64url(b: Uint8Array): string {
  let s = "";
  b.forEach((x) => (s += String.fromCharCode(x)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export interface Keys {
  key: CryptoKey;
  /** hex proof for the vault's X-Drop-Auth header */
  auth: string;
}

export async function deriveKeys(password: string, saltHex: string): Promise<Keys> {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex), iterations: ITERATIONS },
      base,
      512
    )
  );
  const key = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
  return { key, auth: toHex(bits.slice(32)) };
}

/** Encrypt any JSON value under a fresh salt. `verifier` is the proof the vault will hash and keep. */
export async function lockValue(
  value: unknown,
  password: string
): Promise<{ salt: string; verifier: string; box: string }> {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const { key, auth } = await deriveKeys(password, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(value)))
  );
  const box = new Uint8Array(iv.length + ct.length);
  box.set(iv);
  box.set(ct, iv.length);
  return { salt, verifier: auth, box: toB64url(box) };
}

/** Decrypt a box. Throws when the key is wrong or the box was tampered with (GCM authenticates). */
export async function unlockValue(box: string, key: CryptoKey): Promise<unknown> {
  const raw = fromB64url(box);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12));
  return JSON.parse(dec.decode(pt));
}

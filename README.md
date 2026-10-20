<div align="center">

# PinDrop

### Seal anything behind six digits.

Notes, links and files up to **50 GB** — drop them in, get a 6‑digit PIN.
Anyone, anywhere types the digits and the drop opens. No accounts, no sign‑up, no waiting room.

[![Live](https://img.shields.io/badge/live-pindrop--102.netlify.app-E9B44C?style=for-the-badge)](https://pindrop-102.netlify.app/)
[![React](https://img.shields.io/badge/React-18-7BC896?style=for-the-badge&logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?style=for-the-badge&logo=vite&logoColor=white)](https://vite.dev)

</div>

---

## What it does

```
   ┌─────────────┐        ┌──────────┐        ┌─────────────┐
   │  1. SEAL    │  ───►  │  4 7 5 4 │  ───►  │  3. OPEN    │
   │  note/link  │        │   3 3    │        │  anywhere,  │
   │  files 50GB │        │  the PIN │        │  any device │
   └─────────────┘        └──────────┘        └─────────────┘
```

1. **Seal** — paste a note, a link, or drop in a batch of files.
2. **Share the digits** — say them, text them, write them on a napkin.
3. **Open** — they type six digits on any device and the drop pops open.

The drop never travels with the PIN. The digits alone are the whole handover.

---

## Features

| | |
|---|---|
| **6‑digit PINs** | Cryptographically random; the vault refuses a taken PIN outright |
| **Any payload** | Notes up to 12 000 characters, links, or any number of files |
| **Receive mode** | Open an inbox PIN, someone sends into it, only you can read what arrives |
| **QR on the receipt** | Scan with a phone and the PIN types itself |
| **Password lock** | Optional; encrypted in the browser (PBKDF2 + AES‑GCM) — the vault holds only ciphertext |
| **Installable** | Add to home screen, then share files straight from the phone's share sheet |
| **Paste** | Paste a screenshot, file, link or text anywhere on the page |
| **50 GB files** | With R2 configured: 8 MB parts straight to object storage, resumable |
| **Self‑destruct** | Every drop has a fuse — 1 h / 24 h (default) / 7 d max |
| **Open limits** | Burn after 1 open, or cap at 5 / 25 — counted by the server |
| **Owner status** | Your shelf shows when a drop was opened, burned or filled |
| **Guess lockout** | 20 wrong PINs per network per 10 minutes, then 429 |
| **No accounts** | Nothing to sign up for; an owner token on your device proves a drop is yours |

---

## How it works

```
Browser ──── PIN metadata ────►  Netlify Function  ────►  Netlify Blobs
   │                              (vault.mjs)              one global store
   │                                                       keyed by PIN
   │
   └──── file bytes ────────────►  R2 / S3
          presigned PUT per part   (never through the function)
```

Two moving pieces, deliberately separate:

- **The vault** (`netlify/functions/vault.mjs`) stores only a small JSON record per PIN in Netlify Blobs — type, title, fuse, and the URLs of any files. Never the bytes. It is also the whole security model: sealing is create‑only and returns an owner token (only its hash is stored); only that token can check on or shred a drop; opens, burn‑after‑read and open limits are counted in the same compare‑and‑swap that serves the drop; wrong guesses are budgeted per IP. Fuses are enforced on read, since blobs have no TTL of their own.
- **The files** (`netlify/functions/r2.mjs`) go straight from the browser to object storage. The function hands out a presigned `PUT` for each 8 MB part and stitches them together at the end. **No credential ever reaches the browser**, and no file byte ever passes through the function.

Because each part is its own request, a dropped connection costs one part rather than the whole transfer. Completed parts are recorded in `localStorage`, so re‑adding the same file resumes instead of restarting.

Without object storage configured, files fall back to free anonymous relays (tmpfiles for small files, GoFile for large ones), which work fine but cannot resume.

---

## Quick start

```bash
git clone https://github.com/AMREESHAYS/pinDrop-102.git
cd pinDrop-102
npm install
npm run dev
```

Open <http://localhost:3000>. For the cloud vault locally, run `npm run dev:functions` alongside — it serves both functions on the port Vite proxies to, backed by a local Blobs store in `.netlify/dev-blobs`.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on port 3000 |
| `npm run build` | Production build into `dist/` |
| `npm run dev:functions` | Local functions + Blobs on port 9101 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Full test suite |
| `npm run pack` | Builds a drag‑and‑drop deploy bundle, `pinDrop-102.zip` |

---

## Deploying

### Connect the repo (recommended)

Point Netlify at this repository. `netlify.toml` already sets the build command, publish directory and function bundling — nothing else to configure.

### Or drag and drop

```bash
npm run pack
```

Drop the resulting `pinDrop-102.zip` onto **Netlify → your site → Deploys**. The functions are pre‑bundled with their dependencies, because manual deploys skip `npm install`.

---

## Enabling 50 GB resumable uploads

Optional. Without it the app works and large files use free relays that cannot resume.

<details>
<summary><b>Full setup — Cloudflare R2</b></summary>

**1. Create a bucket.** Cloudflare dashboard → R2 → Create bucket. Keep it **private**; downloads are served through short‑lived signed URLs.

**2. Create an API token.** R2 → Manage R2 API Tokens → **Object Read & Write**, scoped to that bucket.

**3. Set the environment variables** in Netlify → Site configuration → Environment variables:

| Variable | Value |
|---|---|
| `R2_ACCOUNT_ID` | Your Cloudflare account ID |
| `R2_BUCKET` | The bucket name |
| `R2_ACCESS_KEY_ID` | From step 2 |
| `R2_SECRET_ACCESS_KEY` | From step 2 |

`R2_ENDPOINT` is optional — set it to target plain S3 or any S3‑compatible host instead.

**4. Add a CORS rule** on the bucket, since parts upload straight from the browser:

```json
[
  {
    "AllowedOrigins": ["https://pindrop-102.netlify.app"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

> `ExposeHeaders: ["ETag"]` is **not** optional. Each part's ETag is what stitches the file back together; without it every upload fails at the final step.

**5. Confirm it took:**

```bash
curl https://your-site.netlify.app/.netlify/functions/r2/config
# {"enabled":true,"maxSize":53687091200}
```

</details>

`R2-SETUP.md` has the same walkthrough in full.

---

## Testing

```bash
npm test
```

39 tests covering the vault's security rules (owner tokens, create‑only sealing, server‑side burn and open limits under concurrent readers, guess lockout, field whitelisting, fuse clamping, inboxes), the drop model, and the multipart upload flow — a complete round trip against a stand‑in S3 server, plus key‑traversal rejection, size limits and part‑count caps.

---

## Security

Read this before pointing a real bucket at the public internet.

- **The upload endpoint is unauthenticated by design.** "No accounts" is the premise of the app, which means anyone who finds the URL can push files into the bucket and you pay for the storage. There is a 50 GB per‑file ceiling and keys are server‑generated and unguessable, but there is no quota — only a per‑IP request rate limit (Netlify's `config.rateLimit`).
- **Add a lifecycle rule.** R2 → Settings → Object lifecycle: delete objects after 7–30 days and abort incomplete multipart uploads after a day. PinDrop deletes an object when the owner shreds a drop or its fuse expires, but a drop nobody ever touches again will sit there.
- **A PIN is the only lock, and nothing is encrypted.** Six digits is a million combinations. The guess lockout is per IP, so someone with many IPs can still sweep it — every drop expiring within 7 days is what keeps the odds down. Fine for a WiFi password, wrong for anything that actually matters.
- **A password locks the drop record, not the file bytes.** Note text, links, titles and file names/URLs are encrypted in the browser; the vault stores ciphertext plus a hash of a proof derived from the password, and a wrong password costs a guess instead of an open. File contents on a relay or in R2 are not encrypted, so the storage host can read them. Lose the password and nobody can open the drop.
- **Burn kills the PIN, not the bytes.** Whoever opens a burned drop still has its file URLs. R2 objects are deleted when the owner shreds a drop or its fuse expires on read; a lifecycle rule is the backstop for the rest.
- **Free relays are third parties.** When object storage isn't configured, files go to tmpfiles or GoFile, whose retention and availability are entirely their call.

---

## License

[MIT](LICENSE) — do what you like with it, just keep the copyright notice.

---

## Tech

React 18 · TypeScript · Vite 6 · Tailwind CSS 4 · Netlify Functions · Netlify Blobs · Cloudflare R2 (S3 API, signed with [aws4fetch](https://github.com/mhart/aws4fetch))

<div align="center">

**[Try it →](https://pindrop-102.netlify.app/)**

</div>

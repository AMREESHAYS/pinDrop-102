<div align="center">

# [PinDrop](https://pindrop-102.netlify.app/)

### Seal anything behind six digits.

### 🔗 [**pindrop-102.netlify.app**](https://pindrop-102.netlify.app/)

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
| **6‑digit PINs** | Cryptographically random, checked for collisions before minting |
| **Any payload** | Notes up to 12 000 characters, links, or any number of files |
| **50 GB files** | Uploaded in 8 MB parts straight to object storage |
| **Resumable** | Close the tab mid‑upload and it picks up where it stopped |
| **Self‑destruct** | Optional 1 h / 24 h / 7 d fuse, enforced on read |
| **Burn after read** | The PIN dies the moment the first person opens it |
| **Works offline‑ish** | A local shelf keeps your own drops instant on your device |
| **No accounts** | Nothing to sign up for, nothing to log into |

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

- **The vault** (`netlify/functions/vault.mjs`) stores only a small JSON record per PIN in Netlify Blobs — type, title, fuse, and the URLs of any files. Never the bytes. Fuses are enforced when the record is read, since blobs have no TTL of their own.
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

Open <http://localhost:3000>. Sealing works immediately; cloud publishing needs the functions, which run on a deploy (or under `netlify dev`).

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on port 3000 |
| `npm run build` | Production build into `dist/` |
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

24 tests covering the PIN vault (storage, expiry, burn, validation), the drop model (file lists, legacy records, relay routing) and the multipart upload flow — a complete round trip against a stand‑in S3 server, plus key‑traversal rejection, size limits and part‑count caps.

---

## Security

Read this before pointing a real bucket at the public internet.

- **The upload endpoint is unauthenticated by design.** "No accounts" is the premise of the app, which means anyone who finds the URL can push files into the bucket and you pay for the storage. There is a 50 GB per‑file ceiling and keys are server‑generated and unguessable, but there is **no rate limiting and no quota**.
- **Add a lifecycle rule.** R2 → Settings → Object lifecycle: delete objects after 7–30 days and abort incomplete multipart uploads after a day. PinDrop deletes an object when the owner shreds a drop or its fuse expires, but a drop nobody ever touches again will sit there.
- **A PIN is the only lock.** Six digits is a million combinations and the store is public — fine for a WiFi password, wrong for anything that actually matters. Don't drop state secrets.
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

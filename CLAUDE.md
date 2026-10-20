# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

PinDrop: seal a note, link or files (up to 50 GB) behind a 6-digit PIN; anyone types the PIN to open it. No accounts. React 18 + TypeScript + Vite 6 + Tailwind 4 frontend, two Netlify Functions backend. Deployed at https://pindrop-102.netlify.app/.

## Commands

```bash
npm run dev        # Vite on :3000 (strictPort, host 0.0.0.0)
npm run dev:functions  # both functions + local Blobs on :9101 (what Vite proxies to)
npm run build      # -> dist/
npm run typecheck  # tsc --noEmit (covers src/ only, not netlify/functions or tests)
npm test           # all tests
npm run pack       # build + esbuild-bundle functions -> ../pinDrop-102.zip for drag-and-drop deploy
```

Tests use `node:test`, no framework. `npm test` first esbuilds `src/lib/vault.ts` and `src/lib/lock.ts` into `.test-build/` (Node here can't run TS), then runs `test_vault.mjs test_model.mjs test_r2.mjs test_lock.mjs` with `--experimental-test-module-mocks`. Single file / single test:

```bash
node --test --experimental-test-module-mocks test_vault.mjs
node --test --experimental-test-module-mocks --test-name-pattern="round-trips" test_vault.mjs
```

`test_model.mjs` and `test_lock.mjs` import from `.test-build/`, so run `npm test` once after editing `vault.ts`/`lock.ts` before running them alone.

- `test_vault.mjs` mocks `@netlify/blobs` (Map + etags, honouring `onlyIfNew`/`onlyIfMatch`) and calls the handler directly with a fake `context.ip`.
- `test_r2.mjs` spins up a stand-in S3 HTTP server and points `R2_ENDPOINT` at it.

Locally, Vite (dev and `vite preview`) proxies `/.netlify/functions` to `127.0.0.1:9101`, served by `dev-functions.mjs` using `@netlify/blobs/server` (data in `.netlify/dev-blobs`). Port 3000 may be taken on this machine; `vite preview --port 4173` after a build works too. Ten minutes of wrong guesses from 127.0.0.1 will lock you out locally — delete `.netlify/dev-blobs` to reset.

## Architecture

Two separate data paths — metadata and bytes never share a route:

1. **Vault** (`netlify/functions/vault.mjs`, client in `src/lib/vault.ts`): one global Netlify Blobs store `pindrop`, one JSON record per PIN. All trust decisions live here, never in the browser:
   - `POST /vault/<pin>` creates (`onlyIfNew`; 409 if taken) and returns a 64-hex **owner token**; only `sha256(token)` is stored. `cleanDrop` whitelists fields, clamps the fuse (default 24h, max 7d, cut to relay TTL for tmpfiles/litterbox), validates links (http/https) and file URLs (known relay hosts or `/.netlify/functions/r2/get?key=`).
   - `GET /vault/<pin>` opens: counts the open and burns (burnAfterRead / `maxOpens`) in a compare-and-swap (`onlyIfMatch` etag, retried), so concurrent readers can't both get a last open. Response never includes `ownerHash`.
   - `GET /vault/<pin>/status` and `DELETE /vault/<pin>` need `X-Owner-Token`. DELETE also deletes the drop's R2 objects server-side (`deleteR2Object` exported from `r2.mjs`; there is no public R2 delete).
   - **Inbox** (receive mode): `type: "inbox"` record sealed empty. GET returns `{waiting:true}` to anyone; `PUT /vault/<pin>` fills it once (CAS); after that only the owner token can read it (strangers get 409).
   - **Guess budget**: every 404/403/409 from a caller increments a per-IP counter in store `pindrop-limits`; at `MISS_LIMIT` (20 per 10 min) all requests from that IP get 429. Plus Netlify `config.rateLimit` on both functions (unverified on the live plan).
   - **Password lock**: `src/lib/lock.ts` derives 64 bytes with PBKDF2-SHA256 (600k): first half = AES-GCM key, second half = proof. Sealing sends `locked: {salt, verifier: proof, box}` + `r2Keys`; the vault stores `sha256(proof)` as `lockHash`, blanks the title, and can't validate content — `recordToDrop`'s `safeFile` re-validates file URLs client-side after decrypting. GET without `X-Drop-Auth` → 401 `{needsPassword, salt}` (no miss, no open); wrong proof → 401 + miss; right proof → ciphertext, open counted. `lockHash`/`r2Keys`/`ownerHash` never leave the server (`publicView`).
   - Records missing `expiresAt` (pre-v2) expire `createdAt + 7d`.
2. **Files** (`netlify/functions/r2.mjs`, client in `src/lib/r2.ts`): `/.netlify/functions/r2/{config,create,sign,complete,abort,delete,get}`. S3 multipart against R2 via `aws4fetch`. The function only presigns per-part PUTs; the browser uploads 8 MB+ parts directly to R2 (3 concurrent, 3 retries). Completed parts are saved in `localStorage` (`pindrop.upload.<name:size:lastModified>`) so re-adding the same file resumes. Keys are server-generated and must match `^drops/[a-z0-9]{16}/<safe name>$`; part size scales to stay under 9000 parts. Enabled only when `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_ACCOUNT_ID` (or `R2_ENDPOINT`) are set — see `R2-SETUP.md`.

`@netlify/blobs` is v11 (needs Node ≥22.12 — `netlify.toml` pins `NODE_VERSION = "22"`, `pack.sh` targets node22).

`uploadFile` in `vault.ts` tries a relay chain: R2 first, then free anonymous relays (tmpfiles/litterbox/gofile; small files ≤100 MB vs large have different orders). Only R2 resumes. GoFile links aren't direct downloads (`isDirectLink`).

Client state:
- **Local shelf**: drops sealed in this browser incl. their owner tokens, `localStorage` key `pindrop.vault.v2`. Opening a PIN checks local first — that's an owner preview (not counted, never burns) — then the cloud.
- **Owner status polling** (`App.tsx`): on load and tab focus, plus every 10s while an unfilled inbox is on the shelf, it calls `/status` for each owned drop: removes gone ones, updates open counts, pulls in filled inboxes. Each call costs a request; keep it frugal.
- **Hash routes** (`parseHash`): `#/d/<pin>` auto-types a PIN (share links and the receipt QR use it; old `#/r/<bucket>/<pin>` maps to the same), `#/s/<base64>` is a self-contained drop in the URL — only built for drops with no fuse/limit, which new drops always have, so effectively legacy.

**PWA**: `public/manifest.webmanifest` + `public/sw.js` (registered in `main.tsx`, production only). The SW does one thing: catch the share-target POST to `/share-target`, stash files/text in Cache Storage (`pindrop-share`), redirect to `/#/share`; `App.tsx` `takeShared()` reads and clears it on load. No offline caching on purpose. Icons in `public/` are drawn with PIL (ImageMagick's SVG renderer dropped the shackle path).

Paste: `SealStation` listens for `paste` on `document` — files always go to the File tab; text only when not typing in a field (lone URL → Link, else Note).

UI is mostly in `src/App.tsx` (orchestration, toasts, routing, inbox target, unlock prompt via `UnlockModal`) with `SealStation` (create / Receive tab / send-into-inbox banner, receipt + `QrCode` from `ui.tsx`), `Keypad` (enter PIN), `OpenedModal` (view, inline image/video/audio previews for direct links), `VaultList` (local shelf).

## Deploy notes

- `netlify.toml` builds `dist/` with an SPA catch-all redirect; functions auto-discovered from `netlify/functions/`.
- `pack.sh` exists because manual Netlify deploys skip `npm install` — functions must be pre-bundled with their deps.
- R2 bucket CORS must expose `ETag`, or every multipart upload fails at `complete`.
- Security headers + CSP live in `netlify.toml` (`pack.sh` copies them into the manual bundle). The CSP has no `unsafe-inline` scripts — no inline handlers in `index.html`. New third-party hosts (relays, previews) must be added to `connect-src`/`img-src`/`media-src`.
- Upload endpoint is intentionally anonymous (rate-limited, no quota) — don't add accounts without asking; it's the product premise.

## Workspace layout

This `work/` dir is the actual project. The parent `pinDrop/` holds deploy zips, screenshots, workspace tarballs, an empty `src/`, and `.claude/launch.json` (`npm --prefix work run dev`, port 3000).

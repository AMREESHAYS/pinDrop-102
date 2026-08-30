# Turning on resumable 50 GB uploads

Without these four variables PinDrop still works — large files fall back to the
free GoFile relay, which cannot resume. Set them and uploads go to your own R2
bucket in 8 MB parts that pick up where they left off.

## 1. Create the bucket

Cloudflare dashboard → R2 → **Create bucket** (any name). Keep it **private**;
downloads are served through a short-lived signed URL, so the bucket never
needs public access.

## 2. Create an API token

R2 → **Manage R2 API Tokens** → Create token, permission **Object Read & Write**,
scoped to that bucket. Copy the Access Key ID and Secret Access Key — the secret
is shown once.

## 3. Set the variables in Netlify

Site configuration → Environment variables:

| Variable | Value |
|---|---|
| `R2_ACCOUNT_ID` | your Cloudflare account ID |
| `R2_BUCKET` | the bucket name |
| `R2_ACCESS_KEY_ID` | from step 2 |
| `R2_SECRET_ACCESS_KEY` | from step 2 |

Redeploy. Check it took: `curl https://<your-site>/.netlify/functions/r2/config`
should answer `{"enabled":true,...}`.

`R2_ENDPOINT` is optional — set it to use plain S3 or any S3-compatible host
instead of R2.

## 4. Allow the browser to upload (CORS)

Parts are uploaded straight from the browser to R2, so the bucket needs a CORS
rule. R2 → your bucket → Settings → CORS policy:

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

`ExposeHeaders: ["ETag"]` is not optional. Each part's ETag is what stitches the
file back together; without it every upload fails at the last step.

## Before you point this at the public internet

The upload endpoint is **unauthenticated by design** — no accounts is the whole
premise of the app. That means anyone who finds the URL can push files into your
bucket and you pay for the storage. There is a 50 GB per-file ceiling and keys
are server-generated, but there is no rate limiting and no quota.

Worth adding before this gets shared widely:

- A lifecycle rule on the bucket (R2 → Settings → Object lifecycle) deleting
  objects after 7–30 days. PinDrop deletes an object when the owner shreds the
  drop or its fuse expires, but a drop nobody ever touches again sits there.
- Rate limiting on `/.netlify/functions/r2/create`.
- Incomplete multipart uploads also cost storage — a lifecycle rule to abort
  them after a day cleans up interrupted transfers nobody resumed.

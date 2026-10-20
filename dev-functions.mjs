// Local stand-in for Netlify Functions + Blobs, on the port vite.config.js
// proxies /.netlify/functions to. Run next to `npm run dev`:  npm run dev:functions
// Blobs persist under .netlify/dev-blobs. R2 stays off unless its env vars are set.
import { createServer } from "node:http";
import { BlobsServer } from "@netlify/blobs/server";

const token = "dev";
const blobs = new BlobsServer({ directory: ".netlify/dev-blobs", token });
const { port: blobsPort } = await blobs.start();
const url = `http://127.0.0.1:${blobsPort}`;
globalThis.netlifyBlobsContext = Buffer.from(
  JSON.stringify({ edgeURL: url, uncachedEdgeURL: url, siteID: "local", token })
).toString("base64");

const handlers = {
  vault: (await import("./netlify/functions/vault.mjs")).default,
  r2: (await import("./netlify/functions/r2.mjs")).default,
};

const PORT = Number(process.env.FUNCTIONS_PORT) || 9101;
createServer(async (req, res) => {
  const name = req.url.match(/^\/\.netlify\/functions\/([^/?]+)/)?.[1];
  const handler = handlers[name];
  if (!handler) return res.writeHead(404).end("no such function");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
  try {
    const out = await handler(request, { ip: req.socket.remoteAddress });
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500).end("function crashed");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`functions on http://127.0.0.1:${PORT}`));

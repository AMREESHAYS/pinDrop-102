import { getStore } from "@netlify/blobs";

/** One global store keyed by PIN — any browser, any device, same six digits. */
const store = () => getStore({ name: "pindrop", consistency: "strong" });

export default async (req) => {
  // Reserved function path: /.netlify/functions/vault/<pin>
  const pin = new URL(req.url).pathname.split("/").pop() || "";
  if (!/^\d{6}$/.test(pin)) return new Response("bad pin", { status: 400 });
  const blobs = store();

  if (req.method === "GET" || req.method === "HEAD") {
    const raw = await blobs.get(pin, { type: "text" });
    if (!raw) return new Response("Not Found", { status: 404 });
    // Blobs have no TTL — enforce the fuse on read.
    try {
      const exp = JSON.parse(raw).expiresAt;
      if (typeof exp === "number" && exp <= Date.now()) {
        await blobs.delete(pin);
        return new Response("Gone", { status: 410 });
      }
    } catch {
      /* unparseable record — hand it back, the client rejects it */
    }
    return new Response(raw, {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  if (req.method === "POST" || req.method === "PUT") {
    const body = await req.text();
    if (body.length > 1_000_000) return new Response("too large", { status: 413 });
    try {
      JSON.parse(body);
    } catch {
      return new Response("not json", { status: 400 });
    }
    await blobs.set(pin, body);
    return new Response("ok", { status: 200 });
  }

  if (req.method === "DELETE") {
    await blobs.delete(pin);
    return new Response("ok", { status: 200 });
  }

  return new Response("method not allowed", { status: 405 });
};

// PinDrop service worker. One job: catch what the OS share sheet POSTs to
// /share-target (a static site can't receive a POST) and hand it to the page.
// Deliberately no offline cache: a cached app shell would outlive security fixes.
const SHARE_CACHE = "pindrop-share";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "POST" || url.origin !== self.location.origin || url.pathname !== "/share-target") return;
  e.respondWith(
    (async () => {
      const form = await e.request.formData();
      const cache = await caches.open(SHARE_CACHE);
      await Promise.all((await cache.keys()).map((k) => cache.delete(k)));
      const files = form.getAll("files").filter((f) => typeof f !== "string");
      const text = ["title", "text", "url"]
        .map((k) => form.get(k))
        .filter((v) => typeof v === "string" && v)
        .join("\n");
      await Promise.all(
        files.map((f, i) =>
          cache.put(
            `/shared/file/${i}`,
            new Response(f, {
              headers: { "Content-Type": f.type || "application/octet-stream", "X-Name": encodeURIComponent(f.name) },
            })
          )
        )
      );
      await cache.put("/shared/meta", new Response(JSON.stringify({ text, count: files.length })));
      return Response.redirect("/#/share", 303);
    })()
  );
});

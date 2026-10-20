import { useCallback, useEffect, useRef, useState } from "react";
import {
  destroyDrop,
  fetchDropByPin,
  fetchOwnerStatus,
  fillInbox,
  generatePin,
  isExpired,
  loadVault,
  openOwnInbox,
  parseHash,
  publishDrop,
  saveVault,
  unlockDrop,
  timeAgo,
  TYPE_LABEL,
  vaultSizeBytes,
  type Drop,
  type OpenVerdict,
} from "./lib/vault";
import { Keypad } from "./components/Keypad";
import { SealStation, type Incoming } from "./components/SealStation";
import { VaultList } from "./components/VaultList";
import { OpenedModal } from "./components/OpenedModal";
import { UnlockModal } from "./components/UnlockModal";
import { CountUp, Reveal, ToastHost, type Toast, type ToastKind } from "./components/ui";
import {
  IconCloud,
  IconFlame,
  IconGlobe,
  IconKey,
  IconLock,
  IconShare,
  IconShield,
  IconTerminal,
  IconUnlock,
  IconVaultDoor,
  IconZap,
} from "./components/icons";

function useInView<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (e) => {
        if (e[0].isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold: 0.3 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { ref, inView };
}

/** Collect what sw.js stashed from the OS share sheet, once, then clear it. */
async function takeShared(): Promise<Incoming | null> {
  if (!("caches" in window)) return null;
  const cache = await caches.open("pindrop-share");
  const meta = await cache.match("/shared/meta");
  if (!meta) return null;
  const { text, count } = (await meta.json()) as { text: string; count: number };
  const files: File[] = [];
  for (let i = 0; i < count; i++) {
    const r = await cache.match(`/shared/file/${i}`);
    if (!r) continue;
    const name = decodeURIComponent(r.headers.get("X-Name") || `shared-${i}`);
    files.push(new File([await r.blob()], name, { type: r.headers.get("Content-Type") || "" }));
  }
  await caches.delete("pindrop-share");
  return { files, text: text || "" };
}

const DRIFT_DIGITS = [
  { ch: "4", left: "6%", top: "18%", delay: "0s", dur: "13s", cls: "text-gold/12" },
  { ch: "0", left: "14%", top: "72%", delay: "1.2s", dur: "16s", cls: "text-mint/10" },
  { ch: "7", left: "28%", top: "34%", delay: "2.4s", dur: "12s", cls: "text-fern/15" },
  { ch: "2", left: "47%", top: "12%", delay: "0.8s", dur: "15s", cls: "text-gold/10" },
  { ch: "9", left: "62%", top: "80%", delay: "3.1s", dur: "14s", cls: "text-mint/10" },
  { ch: "5", left: "74%", top: "26%", delay: "1.8s", dur: "17s", cls: "text-gold/12" },
  { ch: "1", left: "88%", top: "58%", delay: "0.4s", dur: "13s", cls: "text-fern/15" },
  { ch: "8", left: "94%", top: "14%", delay: "2.9s", dur: "15s", cls: "text-mint/10" },
  { ch: "3", left: "38%", top: "88%", delay: "1.5s", dur: "12s", cls: "text-gold/10" },
];

export default function App() {
  const [drops, setDrops] = useState<Drop[]>(() => loadVault());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [sealed, setSealed] = useState<Drop | null>(null);
  const [opened, setOpened] = useState<{ drop: Drop; burned: boolean; via?: "local" | "cloud" } | null>(null);
  const [autoPin, setAutoPin] = useState<string | null>(null);
  const [autoNonce, setAutoNonce] = useState(0);
  /** someone else's inbox PIN we're about to send into */
  const [inboxTarget, setInboxTarget] = useState<{ pin: string; title: string } | null>(null);
  /** a password-locked PIN waiting for its password */
  const [locked, setLocked] = useState<{ pin: string; salt: string } | null>(null);
  const [shared, setShared] = useState<Incoming | null>(null);

  /* ------- arrived via the OS share sheet (installed app) ------- */
  useEffect(() => {
    if (window.location.hash !== "#/share") return;
    history.replaceState(null, "", window.location.pathname);
    void takeShared().then((got) => {
      if (!got) return;
      setShared(got);
      document.getElementById("seal")?.scrollIntoView({ behavior: "smooth" });
    });
  }, []);

  const dropsRef = useRef(drops);
  useEffect(() => {
    dropsRef.current = drops;
  }, [drops]);

  const toast = useCallback((kind: ToastKind, msg: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, msg }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3400);
  }, []);

  const persist = useCallback(
    (next: Drop[]): boolean => {
      if (!saveVault(next)) {
        toast("error", "Vault storage is full on this device — shred an old drop and retry.");
        return false;
      }
      setDrops(next);
      return true;
    },
    [toast]
  );

  /* ------- share-link routing: #/d/pin · #/s/payload ------- */
  useEffect(() => {
    const handle = () => {
      const route = parseHash(window.location.hash);
      if (!route) return;
      if (route.kind === "selfcontained") {
        setOpened({ drop: route.drop, burned: false });
        return;
      }
      setAutoPin(route.pin);
      setAutoNonce((n) => n + 1);
      document.getElementById("terminal")?.scrollIntoView({ behavior: "smooth" });
    };
    handle();
    window.addEventListener("hashchange", handle);
    return () => window.removeEventListener("hashchange", handle);
  }, []);

  /* ------- seal: publish to cloud vault + shelve locally ------- */
  const handleSeal = useCallback(
    async (draft: Drop, password?: string): Promise<Drop | null> => {
      if (inboxTarget) {
        try {
          await fillInbox(inboxTarget.pin, draft);
        } catch (e) {
          const why = String(e);
          toast(
            "error",
            why.includes("409")
              ? "That inbox already got its delivery — ask for a new PIN."
              : why.includes("410")
              ? "That inbox expired before you sent."
              : why.includes("429")
              ? "Too many attempts from this network — try again in a few minutes."
              : "Couldn't deliver — the cloud vault is unreachable."
          );
          return null;
        }
        toast("success", `Delivered to inbox ••${inboxTarget.pin.slice(-4)}. Only its owner can open it now.`);
        setInboxTarget(null);
        return draft;
      }
      let drop = draft;
      try {
        // The vault refuses a taken PIN outright; mint another and retry.
        for (let tries = 0; ; tries++) {
          if (dropsRef.current.some((d) => d.pin === drop.pin)) {
            drop = { ...drop, pin: generatePin() };
            continue;
          }
          try {
            const { owner, expiresAt } = await publishDrop(drop, password);
            drop = { ...drop, owner, expiresAt, locked: !!password || undefined, remote: { bucket: "global" } };
            break;
          } catch (e) {
            if (String(e).includes("taken") && tries < 5) drop = { ...drop, pin: generatePin() };
            else throw e;
          }
        }
      } catch (e) {
        toast(
          "error",
          String(e).includes("429")
            ? "Too many attempts from this network — sealed on this device only. Try again in a few minutes."
            : "Cloud vault unreachable — sealed on this device only. Reseal later to publish."
        );
        drop = { ...drop, remote: undefined, owner: undefined };
      }
      if (!persist([drop, ...dropsRef.current])) return null;
      setSealed(drop);
      if (drop.remote) toast("success", `Sealed & published. PIN ${drop.pin} now works on any device.`);
      return drop;
    },
    [inboxTarget, persist, toast]
  );

  /* ------- open: local shelf first (owner preview), then the cloud vault ------- */
  const attemptOpen = useCallback(
    async (pin: string): Promise<OpenVerdict> => {
      const drops = dropsRef.current;
      const local = drops.find((d) => d.pin === pin);
      if (local) {
        if (isExpired(local)) {
          persist(drops.filter((d) => d.id !== local.id));
          void destroyDrop(local);
          toast("info", "That drop expired and was shredded.");
          return { status: "expired" };
        }
        if (local.type === "inbox") {
          toast("info", "That's your own inbox — still waiting for someone to send into it.");
          return { status: "inbox", title: local.title };
        }
        // Your own drop on your own device is a preview: it neither counts
        // as an open nor burns the PIN for the person you sent it to.
        setOpened({ drop: local, burned: false, via: "local" });
        return { status: "ok", drop: local, burned: false, via: "local" };
      }
      const res = await fetchDropByPin(pin);
      if (res === "offline") return { status: "offline" };
      if (res === "none") return { status: "unknown" };
      if (res === "limited") return { status: "limited" };
      if (res === "filled") return { status: "filled" };
      if (res === "expired") {
        toast("info", "That drop expired and was shredded from the cloud vault.");
        return { status: "expired" };
      }
      if ("needsPassword" in res) {
        setLocked({ pin, salt: res.needsPassword.salt });
        return { status: "locked" };
      }
      if ("inbox" in res) {
        setInboxTarget(res.inbox);
        toast("info", `PIN ••${pin.slice(-4)} is an inbox — whatever you seal next goes straight to its owner.`);
        document.getElementById("seal")?.scrollIntoView({ behavior: "smooth" });
        return { status: "inbox", title: res.inbox.title };
      }
      setOpened({ drop: res.drop, burned: res.burned, via: "cloud" });
      return { status: "ok", drop: res.drop, burned: res.burned, via: "cloud" };
    },
    [persist, toast]
  );

  const handleUnlock = useCallback(
    async (password: string): Promise<string | null> => {
      if (!locked) return null;
      const res = await unlockDrop(locked.pin, locked.salt, password);
      if (typeof res === "object" && "drop" in res) {
        setLocked(null);
        setOpened({ drop: res.drop, burned: res.burned, via: "cloud" });
        return null;
      }
      if (typeof res === "object" && "needsPassword" in res) return "Wrong password — that counted as a wrong guess.";
      if (res === "limited") return "Too many wrong tries from this network — wait 10 minutes.";
      if (res === "offline") return "Can't reach the cloud vault — check your connection.";
      if (res === "corrupt") return "The password was right but the drop is damaged — it can't be decrypted.";
      setLocked(null);
      toast("info", "That drop is gone — burned, expired or shredded.");
      return null;
    },
    [locked, toast]
  );

  const handleDelete = useCallback(
    (id: string) => {
      const target = dropsRef.current.find((d) => d.id === id);
      persist(dropsRef.current.filter((d) => d.id !== id));
      if (target) void destroyDrop(target);
      if (sealed?.id === id) setSealed(null);
      toast("info", "Drop shredded — its PIN is dead everywhere.");
    },
    [persist, sealed, toast]
  );

  /* ------- owner status: who opened what, what arrived, which drops are gone ------- */
  useEffect(() => {
    let running = false;
    const check = async () => {
      if (running) return;
      running = true;
      try {
        const mine = dropsRef.current.filter((d) => d.remote && d.owner && !isExpired(d));
        if (mine.length === 0) return;
        const results = await Promise.all(mine.map(async (d) => [d, await fetchOwnerStatus(d)] as const));
        let next = dropsRef.current;
        for (const [d, st] of results) {
          if (st === "offline") continue;
          if (st === "gone") {
            next = next.filter((x) => x.id !== d.id);
            toast("info", `Drop ••${d.pin.slice(-4)} is gone from the cloud vault — burned, limit reached or expired.`);
          } else if (d.type === "inbox") {
            if (!st.filled) continue;
            const arrived = await openOwnInbox(d);
            if (!arrived) continue;
            next = next.map((x) => (x.id === d.id ? arrived : x));
            toast("success", `Something arrived in your inbox ••${d.pin.slice(-4)} — open it from your vault.`);
          } else if (st.opens !== d.opens) {
            next = next.map((x) => (x.id === d.id ? { ...x, opens: st.opens, expiresAt: st.expiresAt } : x));
            toast("success", `Drop ••${d.pin.slice(-4)} was opened (${st.opens}×).`);
          }
        }
        if (next !== dropsRef.current) persist(next);
      } finally {
        running = false;
      }
    };
    void check();
    // Each check costs the vault a request per drop: re-check when the tab comes
    // back, and poll only while an inbox of ours is open and waiting.
    const onVisible = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => {
      const waiting = dropsRef.current.some((d) => d.type === "inbox" && d.owner && !isExpired(d));
      if (waiting && document.visibilityState === "visible") void check();
    }, 10_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [persist, toast]);

  const ownerOpen = useCallback(
    (drop: Drop) => {
      void attemptOpen(drop.pin).then((v) => {
        if (v.status === "expired" || v.status === "unknown" || v.status === "offline") {
          toast("error", "That drop can't be opened anymore.");
        }
      });
    },
    [attemptOpen, toast]
  );

  const totalOpens = drops.reduce((s, d) => s + d.opens, 0);
  const sizeKb = (vaultSizeBytes(drops) / 1024).toFixed(1);
  const stats = useInView<HTMLDivElement>();
  const tickerItems = drops.slice(0, 8);

  return (
    <div className="app-shell relative font-body text-fog">
      <div className="noise-overlay" />

      {/* ambient glows + drifting digits */}
      <div className="ambient pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -left-40 -top-40 h-[34rem] w-[34rem] rounded-full bg-gold/[0.07] blur-[110px]" />
        <div className="absolute -right-32 top-1/3 h-[28rem] w-[28rem] rounded-full bg-mint/[0.05] blur-[100px]" />
        <div className="absolute bottom-0 left-1/4 h-[22rem] w-[22rem] rounded-full bg-fern/[0.06] blur-[90px]" />
        {DRIFT_DIGITS.map((d, i) => (
          <span
            key={i}
            className={`animate-drift absolute font-mono text-7xl font-bold ${d.cls}`}
            style={{ left: d.left, top: d.top, animationDelay: d.delay, animationDuration: d.dur }}
          >
            {d.ch}
          </span>
        ))}
      </div>

      {/* ================= header ================= */}
      <header className="app-header sticky top-0 z-[100] border-b border-line/80 bg-ink/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <a href="#terminal" className="group flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gold text-ink shadow-[0_0_24px_-4px_rgba(233,180,76,0.6)] transition-transform group-hover:-rotate-6">
              <IconLock width={19} height={19} strokeWidth={2.1} />
            </span>
            <span className="font-display text-xl font-extrabold tracking-tight text-fog">
              Pin<span className="text-gold">Drop</span>
            </span>
          </a>
          <nav className="hidden items-center gap-1 font-mono text-[11px] font-semibold tracking-[0.16em] text-sage sm:flex">
            <a href="#terminal" className="rounded-md px-3 py-2 transition-colors hover:bg-moss hover:text-brass">TERMINAL</a>
            <a href="#seal" className="rounded-md px-3 py-2 transition-colors hover:bg-moss hover:text-brass">SEAL</a>
            <a href="#vault" className="rounded-md px-3 py-2 transition-colors hover:bg-moss hover:text-brass">
              VAULT{drops.length > 0 && <span className="ml-1.5 rounded-full bg-gold/20 px-1.5 py-0.5 text-[10px] text-brass">{drops.length}</span>}
            </a>
          </nav>
          <span className="hidden items-center gap-1.5 rounded-full border border-mint/30 bg-mint/10 px-3 py-1.5 font-mono text-[10px] font-semibold tracking-[0.14em] text-mint md:flex">
            <IconGlobe width={12} height={12} />
            NO ACCOUNT · WORKS ANYWHERE
          </span>
        </div>
      </header>

      <main className="relative z-10">
        {/* ================= terminal ================= */}
        <section id="terminal" className="mx-auto max-w-6xl scroll-mt-20 px-4 pb-16 pt-10 sm:px-6 sm:pt-16">
          <div className="grid items-start gap-10 lg:grid-cols-[1.08fr_0.92fr] lg:gap-12">
            {/* min-w-0: the w-max ticker would otherwise stretch this column and push the keypad off-screen */}
            <div className="min-w-0">
              <Reveal>
                <p className="flex items-center gap-2.5 font-mono text-[11px] font-semibold tracking-[0.28em] text-gold">
                  <IconTerminal width={15} height={15} />
                  PINDROP // PEER-TO-PIN VAULT
                </p>
                <h1 className="mt-4 font-display text-[2.6rem] font-extrabold leading-[1.02] tracking-tight sm:text-6xl lg:text-[4.2rem]">
                  Seal anything.
                  <br />
                  Share <span className="text-outline-gold">six digits.</span>
                </h1>
              </Reveal>
              <Reveal delay={120}>
                <p className="mt-5 max-w-[54ch] text-base leading-relaxed text-sage sm:text-lg">
                  Notes, links, and batches of files — drop them in and get a <strong className="font-semibold text-fog">6-digit PIN</strong>. Anyone,
                  anywhere can punch the digits into this terminal and the drop pops open. Every drop self-destructs, can burn
                  on first open, and wrong guesses get locked out.
                </p>
              </Reveal>

              <Reveal delay={200}>
                <div ref={stats.ref} className="mt-8 flex flex-wrap gap-x-10 gap-y-5">
                  <div>
                    <p className="font-mono text-3xl font-bold text-brass sm:text-4xl">
                      <CountUp target={drops.length} started={stats.inView} />
                    </p>
                    <p className="mt-1 font-mono text-[10px] font-semibold tracking-[0.2em] text-fern">DROPS IN VAULT</p>
                  </div>
                  <div>
                    <p className="font-mono text-3xl font-bold text-brass sm:text-4xl">
                      <CountUp target={totalOpens} started={stats.inView} />
                    </p>
                    <p className="mt-1 font-mono text-[10px] font-semibold tracking-[0.2em] text-fern">TIMES UNLOCKED</p>
                  </div>
                  <div>
                    <p className="font-mono text-3xl font-bold text-brass sm:text-4xl">
                      {sizeKb}
                      <span className="text-lg">KB</span>
                    </p>
                    <p className="mt-1 font-mono text-[10px] font-semibold tracking-[0.2em] text-fern">LOCAL FOOTPRINT</p>
                  </div>
                </div>
              </Reveal>

              {/* activity ticker */}
              <Reveal delay={280}>
                <div className="mt-9 overflow-hidden rounded-lg border border-line bg-pine/70">
                  <div className="flex items-center">
                    <span className="z-10 flex shrink-0 items-center gap-2 border-r border-line bg-moss px-4 py-2.5 font-mono text-[10px] font-bold tracking-[0.2em] text-gold">
                      <span className="h-1.5 w-1.5 animate-glowpulse rounded-full bg-gold" />
                      YOUR DROPS
                    </span>
                    <div className="relative flex-1 overflow-hidden">
                      {tickerItems.length === 0 ? (
                        <p className="px-4 py-2.5 font-mono text-[11px] tracking-[0.14em] text-fern">
                          QUIET SO FAR — SEAL YOUR FIRST DROP ↓
                        </p>
                      ) : (
                        <div className="animate-ticker flex w-max items-center whitespace-nowrap">
                          {[...tickerItems, ...tickerItems].map((d, i) => (
                            <span key={i} className="flex items-center px-5 py-2.5 font-mono text-[11px] tracking-[0.1em] text-sage">
                              <span className="text-gold">▸</span>
                              <span className="ml-2 font-semibold text-fog">{TYPE_LABEL[d.type].toUpperCase()}</span>
                              <span className="ml-2 max-w-[16ch] truncate">“{d.title}”</span>
                              <span className="ml-2 text-brass">••{d.pin.slice(-4)}</span>
                              <span className="ml-2 text-fern">{timeAgo(d.createdAt)}</span>
                              <span className="ml-5 text-line">|</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </Reveal>
            </div>

            <Reveal delay={160} className="lg:sticky lg:top-24">
              <Keypad onAttempt={attemptOpen} autoPin={autoPin} autoNonce={autoNonce} />
              <p className="mt-4 flex items-start gap-2.5 px-2 text-sm leading-relaxed text-sage">
                <span className="mt-0.5 shrink-0 text-gold">
                  <IconKey width={16} height={16} />
                </span>
                Got digits from someone? Punch them in — it unlocks on the sixth press. The terminal checks this
                browser's shelf first, then the cloud vault.
              </p>
            </Reveal>
          </div>
        </section>

        {/* ================= seal ================= */}
        <section id="seal" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16 sm:px-6">
          <Reveal className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] font-semibold tracking-[0.28em] text-gold">01 · SEAL</p>
              <h2 className="mt-2 font-display text-3xl font-extrabold tracking-tight sm:text-5xl">
                Drop something in
              </h2>
            </div>
            <p className="max-w-[40ch] text-sm leading-relaxed text-sage">
              Pick a payload, set a fuse if you want, hit seal. Files ride the anonymous relays one
              after another; the PIN lands on your receipt instantly.
            </p>
          </Reveal>
          <Reveal delay={120}>
            <SealStation
              takenPins={new Set(drops.map((d) => d.pin))}
              seal={handleSeal}
              onError={(m) => toast("error", m)}
              sealed={sealed}
              onDismissReceipt={() => setSealed(null)}
              inboxTarget={inboxTarget}
              onCancelInbox={() => setInboxTarget(null)}
              shared={shared}
            />
          </Reveal>
        </section>

        {/* ================= vault ================= */}
        <section id="vault" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16 sm:px-6">
          <Reveal className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="flex items-center gap-2 font-mono text-[11px] font-semibold tracking-[0.28em] text-gold">
                <IconVaultDoor width={15} height={15} /> 02 · YOUR VAULT
              </p>
              <h2 className="mt-2 font-display text-3xl font-extrabold tracking-tight sm:text-5xl">
                Everything you've sealed
              </h2>
            </div>
            <span className="rounded-full border border-line bg-pine px-4 py-2 font-mono text-[11px] font-semibold tracking-[0.16em] text-sage">
              {drops.length} DROP{drops.length === 1 ? "" : "S"} · {sizeKb}KB ON DEVICE
            </span>
          </Reveal>
          <VaultList drops={drops} onOpen={ownerOpen} onDelete={handleDelete} />
        </section>

        {/* ================= how it works ================= */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <Reveal className="mb-10">
            <p className="font-mono text-[11px] font-semibold tracking-[0.28em] text-gold">THE WHOLE TRICK</p>
            <h2 className="mt-2 max-w-[26ch] font-display text-3xl font-extrabold tracking-tight sm:text-5xl">
              Three moves, any distance
            </h2>
          </Reveal>
          <div className="divide-y divide-line border-y border-line">
            {[
              {
                n: "01",
                icon: <IconLock width={22} height={22} />,
                title: "Seal it",
                body: "Paste a note, a link, or drop in a whole batch of files. PinDrop mints a random 6-digit PIN, uploads the files, and publishes the drop to the cloud vault under that PIN. Pick a fuse (1 hour to 7 days) and how many opens it allows — one means it burns on first read.",
                offset: "lg:pl-0",
              },
              {
                n: "02",
                icon: <IconShare width={22} height={22} />,
                title: "Share the digits",
                body: "Say them, text them, write them on a napkin. Six digits are the whole handover — every PinDrop reads the same vault, so nothing has to be set up on the other end. The drop itself never travels with the PIN.",
                offset: "lg:pl-16",
              },
              {
                n: "03",
                icon: <IconUnlock width={22} height={22} />,
                title: "Anyone opens it",
                body: "They visit PinDrop, type six digits, and the terminal fetches the drop from the cloud vault — same city or across the planet. Copy the note, open the link, download every file. Wrong PIN? The machine shakes it off and waits.",
                offset: "lg:pl-32",
              },
            ].map((row, i) => (
              <Reveal key={row.n} delay={i * 130}>
                <div className={`group flex flex-col gap-5 py-8 transition-colors hover:bg-pine/50 sm:flex-row sm:items-start sm:gap-8 ${row.offset}`}>
                  <span className="font-mono text-5xl font-bold text-line transition-colors group-hover:text-gold sm:text-6xl">
                    {row.n}
                  </span>
                  <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-start sm:gap-6">
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-line bg-moss text-gold transition-transform group-hover:-rotate-6 group-hover:border-gold/50">
                      {row.icon}
                    </span>
                    <div>
                      <h3 className="font-display text-2xl font-bold text-fog">{row.title}</h3>
                      <p className="mt-2 max-w-[62ch] leading-relaxed text-sage">{row.body}</p>
                    </div>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ================= why strip ================= */}
        <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              {
                icon: <IconZap width={18} height={18} />,
                t: "Fast by design",
                b: "No accounts, no sign-up forms, no waiting rooms. Opening a drop is one lookup against the vault.",
              },
              {
                icon: <IconCloud width={18} height={18} />,
                t: "Here + anywhere",
                b: "A local shelf keeps your drops instant on this device, while the public vault keyed by PIN lets any browser anywhere pull the drop — no vault address to share, just the six digits.",
              },
              {
                icon: <IconFlame width={18} height={18} />,
                t: "Fuses & burns",
                b: "Every drop has a fuse, and an open limit if you want one. Both are enforced by the vault itself, so skipping this page doesn't keep a burned drop alive.",
              },
            ].map((c, i) => (
              <Reveal key={c.t} delay={i * 110} as="article">
                <div className="card-lift h-full rounded-xl border border-line bg-pine p-5">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-gold/12 text-gold">{c.icon}</span>
                  <h3 className="mt-3.5 font-display text-lg font-bold text-fog">{c.t}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-sage">{c.b}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </section>
      </main>

      {/* ================= footer ================= */}
      <footer className="relative z-10 border-t border-line bg-pine/60">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-4 py-10 sm:flex-row sm:items-center sm:px-6">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gold text-ink">
                <IconLock width={16} height={16} strokeWidth={2.1} />
              </span>
              <span className="font-display text-lg font-extrabold text-fog">
                Pin<span className="text-gold">Drop</span>
              </span>
            </div>
            <p className="mt-3 max-w-[60ch] font-mono text-[10px] leading-relaxed tracking-[0.06em] text-fern">
              HOW IT WORKS, HONESTLY: DROPS LIVE IN PINDROP'S STORE UNDER YOUR 6-DIGIT PIN — READABLE BY ANYONE
              WHO KNOWS IT, AND NOT ENCRYPTED. WRONG GUESSES ARE LOCKED OUT PER NETWORK AND EVERY DROP EXPIRES
              WITHIN 7 DAYS, BUT SIX DIGITS IS STILL ONLY A MILLION COMBINATIONS. FILES GO TO PINDROP STORAGE
              WHEN CONFIGURED, OTHERWISE TO FREE RELAYS (TMPFILES / LITTERBOX / GOFILE) THAT CAN SEE THEM.
              DON'T DROP REAL SECRETS — THE PIN IS THE ONLY LOCK.
            </p>
          </div>
          <a
            href="#terminal"
            className="flex items-center gap-2 rounded-lg border border-line px-4 py-2.5 font-mono text-[11px] font-semibold tracking-[0.16em] text-sage transition-colors hover:border-gold/50 hover:text-brass"
          >
            <IconShield width={14} height={14} />
            BACK TO THE TERMINAL ↑
          </a>
        </div>
      </footer>

      {locked && <UnlockModal pin={locked.pin} onUnlock={handleUnlock} onClose={() => setLocked(null)} />}
      {opened && (
        <OpenedModal drop={opened.drop} burned={opened.burned} via={opened.via} onClose={() => setOpened(null)} />
      )}
      <ToastHost toasts={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}

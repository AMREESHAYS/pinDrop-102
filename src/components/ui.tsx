import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import qrcode from "qrcode-generator";
import { IconCheck, IconCopy } from "./icons";

/* ---------- scroll reveal ---------- */

export function Reveal({
  children,
  className = "",
  delay = 0,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  as?: "div" | "section" | "li" | "article";
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  // Anything already on screen at mount is shown before the first paint.
  // Waiting for the observer would leave the whole first screen at opacity 0
  // for a frame or more — on a slow phone that reads as a blank page.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < (window.innerHeight || 0) && r.bottom > 0) setShown(true);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag
      ref={ref as never}
      className={`${shown ? "reveal-shown" : "reveal-hidden"} ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </Tag>
  );
}

/* ---------- count-up number ---------- */

export function CountUp({ target, started }: { target: number; started: boolean }) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (!started) return;
    let raf = 0;
    const t0 = performance.now();
    const dur = 900;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      setVal(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [started, target]);
  return <>{val}</>;
}

/* ---------- copy button ---------- */

export function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied",
  className = "",
  onCopied,
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    onCopied?.();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <button
      type="button"
      onClick={doCopy}
      className={`inline-flex items-center gap-1.5 transition-colors ${
        copied ? "text-mint" : ""
      } ${className}`}
      aria-label={label}
    >
      {copied ? <IconCheck width={15} height={15} /> : <IconCopy width={15} height={15} />}
      <span>{copied ? copiedLabel : label}</span>
    </button>
  );
}

/* ---------- toasts ---------- */

export type ToastKind = "success" | "error" | "info";
export interface Toast {
  id: number;
  kind: ToastKind;
  msg: string;
}

export function ToastHost({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="fixed bottom-5 right-5 z-[150] flex w-[calc(100vw-2.5rem)] max-w-sm flex-col gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={`animate-toast flex items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm font-medium shadow-xl shadow-black/40 backdrop-blur-sm ${
            t.kind === "success"
              ? "border-mint/40 bg-moss/95 text-mint"
              : t.kind === "error"
                ? "border-coral/40 bg-moss/95 text-coral"
                : "border-gold/40 bg-moss/95 text-brass"
          }`}
        >
          <span
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${
              t.kind === "success" ? "bg-mint" : t.kind === "error" ? "bg-coral" : "bg-gold"
            }`}
          />
          <span className="font-body">{t.msg}</span>
        </button>
      ))}
    </div>
  );
}

/** Scannable QR for a share link. Dark on light: phone cameras misread inverted codes. */
export function QrCode({ text, size = 168 }: { text: string; size?: number }) {
  const path = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { d, view: n + 8 };
  }, [text]);
  return (
    <svg
      role="img"
      aria-label="QR code for the share link"
      viewBox={`0 0 ${path.view} ${path.view}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="rounded-md"
    >
      <rect width="100%" height="100%" fill="#f4f1e8" />
      <path d={path.d} fill="#0b120e" />
    </svg>
  );
}

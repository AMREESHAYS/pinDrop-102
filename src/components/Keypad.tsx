import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenVerdict } from "../lib/vault";
import { IconBackspace, IconUnlock } from "./icons";

type Status = "idle" | "typing" | "checking" | "found" | "unknown" | "expired" | "limited" | "inbox" | "filled" | "locked" | "offline";

const STATUS_LINE: Record<Status, { text: string; cls: string }> = {
  idle: { text: "AWAITING 6-DIGIT PIN", cls: "text-sage" },
  typing: { text: "KEYING…", cls: "text-brass" },
  checking: { text: "REACHING CLOUD VAULT…", cls: "text-mint animate-pulse" },
  found: { text: "TUMBLERS ALIGNED — DROP OPEN", cls: "text-mint" },
  unknown: { text: "UNKNOWN PIN — TRY AGAIN", cls: "text-ember" },
  expired: { text: "THAT DROP HAS EXPIRED", cls: "text-gold" },
  offline: { text: "CAN'T REACH THE CLOUD VAULT", cls: "text-ember" },
  limited: { text: "TOO MANY WRONG PINS — WAIT 10 MIN", cls: "text-ember" },
  inbox: { text: "INBOX FOUND — SEAL BELOW TO SEND INTO IT", cls: "text-mint" },
  filled: { text: "THAT INBOX ALREADY GOT ITS DELIVERY", cls: "text-gold" },
  locked: { text: "PASSWORD-LOCKED — ENTER THE PASSWORD", cls: "text-gold" },
};

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"];

interface Props {
  onAttempt: (pin: string) => Promise<OpenVerdict>;
  autoPin: string | null;
  autoNonce: number;
}

export function Keypad({ onAttempt, autoPin, autoNonce }: Props) {
  const [buffer, setBuffer] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [shake, setShake] = useState(false);
  const timers = useRef<number[]>([]);
  const busy = status === "checking" || status === "typing";

  const clearTimers = () => {
    timers.current.forEach(window.clearTimeout);
    timers.current = [];
  };
  useEffect(() => clearTimers, []);

  const reset = useCallback((delay = 2400) => {
    timers.current.push(
      window.setTimeout(() => {
        setBuffer("");
        setStatus("idle");
      }, delay)
    );
  }, []);

  const attempt = useCallback(
    async (pin: string) => {
      setStatus("checking");
      let verdict: OpenVerdict;
      try {
        verdict = await onAttempt(pin);
      } catch {
        verdict = { status: "offline" };
      }
      if (verdict.status === "ok") {
        setStatus("found");
        reset(2600);
      } else {
        setStatus(verdict.status);
        if (verdict.status === "unknown" || verdict.status === "offline") {
          setShake(true);
          timers.current.push(window.setTimeout(() => setShake(false), 550));
        }
        reset();
      }
    },
    [onAttempt, reset]
  );
  const attemptRef = useRef(attempt);
  useEffect(() => {
    attemptRef.current = attempt;
  }, [attempt]);

  const press = useCallback(
    (digit: string) => {
      if (busy) return;
      if (buffer.length >= 6) return;
      const next = buffer + digit;
      setBuffer(next);
      if (next.length === 6) {
        setStatus("typing");
        timers.current.push(window.setTimeout(() => void attemptRef.current(next), 140));
      }
    },
    [buffer, busy]
  );

  const backspace = useCallback(() => {
    if (busy) return;
    setBuffer((b) => b.slice(0, -1));
  }, [busy]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (/^\d$/.test(e.key)) press(e.key);
      if (e.key === "Backspace") backspace();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press, backspace]);

  /* auto-type from a share link — keyed only on the nonce so internal
     vault changes can't retrigger the sequence */
  useEffect(() => {
    if (!autoPin || autoNonce === 0) return;
    clearTimers();
    setBuffer("");
    setStatus("typing");
    autoPin.split("").forEach((d, i) => {
      timers.current.push(
        window.setTimeout(() => setBuffer((b) => b + d), 350 + i * 130)
      );
    });
    timers.current.push(
      window.setTimeout(() => void attemptRef.current(autoPin), 350 + autoPin.length * 130 + 300)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoNonce]);

  const line = STATUS_LINE[status];

  return (
    <div className="keypad-shell rounded-2xl p-4 sm:p-7" aria-label="PIN terminal">
      {/* door header */}
      <div className="flex items-center justify-between border-b border-line/70 pb-4">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-ember shadow-[0_0_8px_rgba(229,93,82,0.8)]" />
          <span className="h-2.5 w-2.5 rounded-full bg-gold shadow-[0_0_8px_rgba(233,180,76,0.8)]" />
          <span className={`h-2.5 w-2.5 rounded-full ${status === "found" ? "bg-mint shadow-[0_0_10px_rgba(111,224,174,0.9)]" : "bg-mint/40"}`} />
        </div>
        <p className="font-mono text-[10px] font-bold tracking-[0.34em] text-sage">VAULT DOOR · 06</p>
      </div>

      {/* PIN slots */}
      <div
        className={`mt-7 flex justify-center gap-1.5 sm:gap-3 ${shake ? "animate-shake" : ""}`}
        role="status"
      >
        {Array.from({ length: 6 }).map((_, i) => {
          const filled = i < buffer.length;
          return (
            <span
              key={i}
              className={`pin-slot flex h-12 min-w-0 flex-1 basis-0 items-center justify-center rounded-lg border font-mono text-xl font-bold transition-all duration-150 sm:h-14 sm:text-2xl ${
                status === "found"
                  ? "border-mint/70 bg-mint/15 text-mint shadow-[0_0_18px_-2px_rgba(111,224,174,0.45)]"
                  : status === "unknown" || status === "offline"
                  ? "border-ember/70 bg-ember/10 text-ember"
                  : status === "expired"
                  ? "border-gold/70 bg-gold/10 text-gold"
                  : filled
                  ? "slot-pop border-gold/60 bg-gold/10 text-brass"
                  : status === "checking"
                  ? "animate-glowpulse border-mint/50 text-mint"
                  : "border-line bg-pine text-transparent"
              }`}
            >
              {filled ? "●" : status === "checking" ? "·" : "·"}
            </span>
          );
        })}
      </div>

      {/* status line */}
      <p className={`mt-4 min-h-[1.1rem] text-center font-mono text-[11px] font-semibold tracking-[0.26em] ${line.cls}`}>
        {line.text}
      </p>

      {/* keys */}
      <div className="mx-auto mt-5 grid w-full max-w-[300px] grid-cols-3 gap-2 sm:gap-3">
        {KEYS.map((k, i) =>
          k === "" ? (
            <span key={i} />
          ) : k === "⌫" ? (
            <button
              key={i}
              type="button"
              onClick={backspace}
              aria-label="Delete digit"
              className="keycap flex items-center justify-center text-sage hover:text-ember"
            >
              <IconBackspace width={22} height={22} />
            </button>
          ) : (
            <button key={i} type="button" onClick={() => press(k)} className="keycap font-mono text-xl font-semibold">
              {k}
            </button>
          )
        )}
      </div>

      <div className="mt-5 flex items-center justify-center gap-2 text-[11px] font-medium tracking-wide text-fern">
        <IconUnlock width={14} height={14} />
        <span>Unlocks on the sixth digit — local vault first, then the cloud.</span>
      </div>
    </div>
  );
}

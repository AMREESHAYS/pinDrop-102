import { useEffect, useState, type FormEvent } from "react";
import { IconKey, IconX } from "./icons";

interface Props {
  pin: string;
  /** resolves to an error message, or null once the drop is open */
  onUnlock: (password: string) => Promise<string | null>;
  onClose: () => void;
}

export function UnlockModal({ pin, onUnlock, onClose }: Props) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    const err = await onUnlock(password);
    setBusy(false);
    if (err) {
      setError(err);
      setPassword("");
    }
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-ink/85 p-4 backdrop-blur-sm"
      onClick={() => !busy && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="unlock-title"
    >
      <form
        onSubmit={(e) => void submit(e)}
        onClick={(e) => e.stopPropagation()}
        className="modal-in w-full max-w-sm rounded-xl border border-gold/40 bg-pine p-5 shadow-[0_40px_80px_-20px_rgba(0,0,0,0.8)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-gold/12 text-gold">
              <IconKey width={18} height={18} />
            </span>
            <div>
              <p className="font-mono text-[10px] font-bold tracking-[0.24em] text-gold">PIN {pin} · LOCKED</p>
              <h3 id="unlock-title" className="font-display text-lg font-bold text-fog">
                Enter the password
              </h3>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="rounded-md border border-line p-1.5 text-sage transition-colors hover:border-ember/60 hover:text-ember"
          >
            <IconX width={15} height={15} />
          </button>
        </div>

        <label className="mt-5 block">
          <span className="sr-only">Password</span>
          <input
            type="password"
            autoFocus
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            className="w-full rounded-lg border border-line bg-ink/60 px-3.5 py-3 text-sm text-fog focus:border-gold/60 focus:outline-none"
          />
        </label>
        <p role="alert" className="mt-2 min-h-[1.25rem] font-mono text-[11px] tracking-wide text-ember">
          {error}
        </p>
        <p className="font-mono text-[10px] leading-relaxed tracking-[0.08em] text-fern">
          DECRYPTED ON THIS DEVICE. A WRONG PASSWORD DOESN'T BURN THE DROP, BUT IT COUNTS AS A WRONG GUESS.
        </p>
        <button
          type="submit"
          disabled={!password || busy}
          className="mt-4 w-full rounded-lg bg-gold py-3 font-display font-extrabold tracking-wide text-ink transition-opacity disabled:opacity-40"
        >
          {busy ? "UNLOCKING…" : "UNLOCK"}
        </button>
      </form>
    </div>
  );
}

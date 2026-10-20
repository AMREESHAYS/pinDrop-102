import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  buildOfflineLink,
  buildShareLink,
  FILE_MAX,
  FILE_MAX_LABEL,
  dropFiles,
  formatBytes,
  type BatchProgress,
  generatePin,
  NOTE_MAX,
  totalBytes,
  uid,
  uploadFiles,
  type Drop,
  type DropType,
  type FileMeta,
} from "../lib/vault";
import { PASSWORD_MIN } from "../lib/lock";
import { r2Enabled, resumableBytes } from "../lib/r2";
import { CopyButton, QrCode } from "./ui";
import { IconDownload, IconFile, IconFlame, IconLink, IconNote, IconUpload, IconX } from "./icons";

const TABS: { type: DropType; label: string; icon: (p: { width: number; height: number }) => ReactNode }[] = [
  { type: "note", label: "Note", icon: (p) => <IconNote {...p} /> },
  { type: "link", label: "Link", icon: (p) => <IconLink {...p} /> },
  { type: "file", label: "File", icon: (p) => <IconFile {...p} /> },
  { type: "inbox", label: "Receive", icon: (p) => <IconDownload {...p} /> },
];

const EXPIRY_OPTIONS = [
  { label: "1H", ms: 36e5 },
  { label: "24H", ms: 864e5 },
  { label: "7D", ms: 7 * 864e5 },
];

/** 1 is burn-after-read; null is no limit (the fuse still applies). */
const OPEN_OPTIONS: { label: string; n: number | null }[] = [
  { label: "1 · BURN", n: 1 },
  { label: "5", n: 5 },
  { label: "25", n: 25 },
  { label: "∞", n: null },
];

type Phase = "idle" | "uploading" | "sealing";
const NO_PROGRESS: BatchProgress = { done: 0, total: 0, name: "", sent: 0, bytes: 0 };

interface Props {
  takenPins: Set<string>;
  seal: (draft: Drop, password?: string) => Promise<Drop | null>;
  onError: (msg: string) => void;
  sealed: Drop | null;
  onDismissReceipt: () => void;
  /** someone else's inbox PIN: what's sealed goes there instead of under a new PIN */
  inboxTarget: { pin: string; title: string } | null;
  onCancelInbox: () => void;
  /** files/text handed over by the OS share sheet (PWA share target) */
  shared: Incoming | null;
}

export interface Incoming {
  files: File[];
  text: string;
}

export function SealStation({ takenPins, seal, onError, sealed, onDismissReceipt, inboxTarget, onCancelInbox, shared }: Props) {
  const [tab, setTab] = useState<DropType>("note");
  const [note, setNote] = useState("");
  const [link, setLink] = useState("");
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [expiry, setExpiry] = useState(EXPIRY_OPTIONS[1].ms);
  const [maxOpens, setMaxOpens] = useState<number | null>(null);
  const [password, setPassword] = useState("");
  const canLock = !inboxTarget && tab !== "inbox";
  const usePassword = canLock && password.length > 0;
  const passwordShort = usePassword && password.length < PASSWORD_MIN;
  const burn = maxOpens === 1;
  const [r2On, setR2On] = useState<boolean | null>(null);
  useEffect(() => {
    void r2Enabled().then(setR2On);
  }, []);
  useEffect(() => {
    if (inboxTarget && tab === "inbox") setTab("note");
  }, [inboxTarget, tab]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<BatchProgress>(NO_PROGRESS);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const busy = phase !== "idle";
  const noteCount = note.length;

  const filesSize = useMemo(() => totalBytes(files), [files]);
  /** bytes already banked by an interrupted run of the same file */
  const resumable = useMemo(() => files.map((f) => resumableBytes(f)), [files]);

  const pct =
    phase === "uploading" && progress.bytes > 0
      ? Math.min(100, Math.round((progress.sent / progress.bytes) * 100))
      : null;

  /** Add a batch, skipping oversized files and ones already staged. */
  const addFiles = (incoming: FileList | File[] | null | undefined) => {
    const list = Array.from(incoming || []);
    if (list.length === 0) return;
    const tooBig = list.filter((f) => f.size > FILE_MAX);
    const ok = list.filter((f) => f.size <= FILE_MAX);
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...ok.filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
    if (tooBig.length) {
      onError(
        tooBig.length === 1
          ? `${tooBig[0].name} is ${formatBytes(tooBig[0].size)} — the relay caps at ${FILE_MAX_LABEL}.`
          : `${tooBig.length} files exceed the ${FILE_MAX_LABEL} relay cap and were skipped.`
      );
    }
  };

  /** Pasted or shared content: files go to the File tab, a lone URL to Link, other text to Note. */
  const takeIn = (incoming: Incoming) => {
    if (incoming.files.length) {
      // Pasted screenshots all arrive as "image.png" — rename so they don't dedupe each other away.
      addFiles(incoming.files.map((f, i) => (f.name === "image.png" ? new File([f], `pasted-${Date.now()}-${i}.png`, { type: f.type }) : f)));
      setTab("file");
      return;
    }
    const text = incoming.text.trim();
    if (!text) return;
    if (/^https?:\/\/\S+$/i.test(text)) {
      setLink(text);
      setTab("link");
    } else {
      setNote((n) => (n ? `${n}\n${text}` : text).slice(0, NOTE_MAX));
      setTab("note");
    }
  };
  const takeInRef = useRef(takeIn);
  takeInRef.current = takeIn;

  useEffect(() => {
    if (shared) takeInRef.current(shared);
  }, [shared]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (busy || !e.clipboardData) return;
      const files = Array.from(e.clipboardData.files);
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      // Text pasted into a field is the field's business; files are always ours.
      if (!files.length && typing) return;
      e.preventDefault();
      takeInRef.current({ files, text: e.clipboardData.getData("text") });
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [busy]);

  const removeFile = (i: number) => setFiles((prev) => prev.filter((_, n) => n !== i));

  const clearFiles = () => {
    setFiles([]);
    if (fileInput.current) fileInput.current.value = "";
  };

  const valid =
    (tab === "note" && note.trim().length > 0) ||
    (tab === "link" && link.trim().length > 0) ||
    (tab === "file" && files.length > 0) ||
    (tab === "inbox" && !inboxTarget);
  const ready = valid && !passwordShort;

  const handleSeal = async () => {
    if (!ready || busy) return;
    let pin = generatePin();
    let guard = 0;
    while (takenPins.has(pin) && guard++ < 8) pin = generatePin();

    // 1 — relay the files first (the drop JSON only carries the URLs)
    let relayed: FileMeta[] | undefined;
    if (tab === "file" && files.length) {
      setPhase("uploading");
      setProgress({ done: 0, total: files.length, name: files[0].name, sent: 0, bytes: files[0].size });
      const { uploaded, failed } = await uploadFiles(files, setProgress);
      if (uploaded.length === 0) {
        onError("Both file relays refused the upload — check your connection and try again.");
        setPhase("idle");
        return;
      }
      if (failed.length) {
        onError(`Sealed without ${failed.length} file${failed.length === 1 ? "" : "s"} the relays refused: ${failed.join(", ")}`);
      }
      relayed = uploaded;
    }

    const draft: Drop = {
      id: uid(),
      pin,
      type: tab,
      title:
        title.trim() ||
        (tab === "note"
          ? "Sealed note"
          : tab === "link"
          ? "Shared link"
          : tab === "inbox"
          ? "Inbox"
          : relayed && relayed.length > 1
          ? `${relayed.length} files`
          : relayed?.[0]?.name || "Sealed file"),
      createdAt: Date.now(),
      expiresAt: Date.now() + expiry,
      burnAfterRead: burn || undefined,
      maxOpens: maxOpens && maxOpens > 1 ? maxOpens : undefined,
      opens: 0,
      payload: {
        text: tab === "note" ? note : undefined,
        link: tab === "link" ? link.trim() : undefined,
        files: relayed,
      },
    };

    // 2 — publish to the cloud vault + shelve locally
    setPhase("sealing");
    try {
      const result = await seal(draft, usePassword ? password : undefined);
      if (result) {
        setPassword("");
        setNote("");
        setLink("");
        setTitle("");
        clearFiles();
      }
    } finally {
      setPhase("idle");
      setProgress(NO_PROGRESS);
    }
  };

  const sealedFiles = sealed ? dropFiles(sealed) : [];
  const shareLink = sealed ? buildShareLink(sealed) : "";
  const offlineLink = sealed ? buildOfflineLink(sealed) : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
      {/* ------------ form ------------ */}
      <div className="min-w-0 rounded-xl border border-line bg-pine/70 p-4 sm:p-7">
        {inboxTarget && (
          <div className="mb-5 flex items-start justify-between gap-3 rounded-lg border border-mint/50 bg-mint/10 p-3.5">
            <p className="font-mono text-[11px] leading-relaxed tracking-[0.1em] text-mint">
              SENDING INTO INBOX ••{inboxTarget.pin.slice(-4)}
              {inboxTarget.title ? ` · “${inboxTarget.title}”` : ""}
              <br />
              <span className="text-sage">WHAT YOU SEAL GOES TO ITS OWNER ONLY. ONE DELIVERY PER INBOX.</span>
            </p>
            <button
              type="button"
              onClick={onCancelInbox}
              disabled={busy}
              aria-label="Stop sending into this inbox"
              className="shrink-0 rounded-md border border-line p-1.5 text-sage transition-colors hover:border-ember/60 hover:text-ember"
            >
              <IconX width={13} height={13} />
            </button>
          </div>
        )}

        {/* tabs */}
        <div className="flex w-full flex-wrap gap-1.5 rounded-lg border border-line bg-ink/60 p-1.5 sm:w-max">
          {TABS.filter((t) => !(inboxTarget && t.type === "inbox")).map((t) => (
            <button
              key={t.type}
              type="button"
              disabled={busy}
              onClick={() => setTab(t.type)}
              className={`flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 font-mono text-xs font-bold tracking-[0.14em] transition-all sm:flex-none sm:px-4 ${
                tab === t.type
                  ? "bg-gold text-ink shadow-[0_0_16px_-4px_rgba(233,180,76,0.7)]"
                  : "text-sage hover:bg-moss hover:text-fog"
              }`}
            >
              {t.icon({ width: 14, height: 14 })}
              {t.label.toUpperCase()}
            </button>
          ))}
        </div>

        <label className="mt-5 block">
          <span className="font-mono text-[10px] font-bold tracking-[0.2em] text-fern">LABEL (OPTIONAL)</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value.slice(0, 60))}
            disabled={busy}
            placeholder="e.g. WiFi password, grandma's recipe, the contract"
            className="mt-1.5 w-full rounded-lg border border-line bg-ink/60 px-3.5 py-2.5 text-sm text-fog placeholder:text-fern/70 focus:border-gold/60 focus:outline-none"
          />
        </label>

        <div className="mt-4">
          {tab === "inbox" && (
            <p className="rounded-lg border border-dashed border-line bg-ink/40 p-4 text-sm leading-relaxed text-sage">
              Need something from someone? Open an inbox and give them the PIN. They type it on any PinDrop,
              seal a note, link or files, and it lands here — readable by you alone, not by anyone else who
              learns the PIN. One delivery per inbox.
            </p>
          )}
          {tab === "note" && (
            <div>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
                disabled={busy}
                rows={7}
                placeholder="Paste the secret, the note, the snippet… anything you want handed over."
                className="w-full resize-y rounded-lg border border-line bg-ink/60 px-3.5 py-3 text-sm leading-relaxed text-fog placeholder:text-fern/70 focus:border-gold/60 focus:outline-none"
              />
              <p className={`mt-1 text-right font-mono text-[10px] tracking-wider ${noteCount > NOTE_MAX - 500 ? "text-gold" : "text-fern"}`}>
                {noteCount.toLocaleString()} / {NOTE_MAX.toLocaleString()} CHARS
              </p>
            </div>
          )}
          {tab === "link" && (
            <input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              disabled={busy}
              placeholder="https://anything.example/secret-doc"
              className="w-full rounded-lg border border-line bg-ink/60 px-3.5 py-3 text-sm text-fog placeholder:text-fern/70 focus:border-gold/60 focus:outline-none"
            />
          )}
          {tab === "file" && (
            <div className="space-y-2.5">
              {files.length > 0 && (
                <>
                  <div className="flex items-center justify-between px-0.5">
                    <p className="font-mono text-[10px] font-bold tracking-[0.2em] text-fern">
                      {files.length} FILE{files.length === 1 ? "" : "S"} · {formatBytes(filesSize)}
                    </p>
                    <button
                      type="button"
                      onClick={clearFiles}
                      disabled={busy}
                      className="font-mono text-[10px] font-bold tracking-[0.16em] text-sage transition-colors hover:text-ember disabled:opacity-40"
                    >
                      CLEAR ALL
                    </button>
                  </div>
                  <ul className="max-h-64 space-y-2 overflow-y-auto">
                    {files.map((f, i) => (
                      <li
                        key={`${f.name}:${f.size}:${i}`}
                        className="flex items-center justify-between gap-3 rounded-lg border border-mint/40 bg-mint/[0.06] px-3.5 py-2.5"
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-mint/15 text-mint">
                            <IconFile width={17} height={17} />
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-fog">{f.name}</p>
                            <p className="font-mono text-[11px] text-sage">
                              {formatBytes(f.size)} ·{" "}
                              {resumable[i] > 0 ? (
                                <span className="text-mint">
                                  resumes at {Math.round((resumable[i] / f.size) * 100)}%
                                </span>
                              ) : (
                                "relay-ready"
                              )}
                            </p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeFile(i)}
                          disabled={busy}
                          className="shrink-0 rounded-md border border-line p-2 text-sage transition-colors hover:border-ember/60 hover:text-ember"
                          aria-label={`Remove ${f.name}`}
                        >
                          <IconX width={14} height={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  addFiles(e.dataTransfer.files);
                }}
                disabled={busy}
                className={`flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-4 transition-all ${
                  files.length ? "py-5" : "py-9"
                } ${dragging ? "border-gold bg-gold/10" : "border-line hover:border-gold/60 hover:bg-moss/60"}`}
              >
                <IconUpload width={files.length ? 20 : 26} height={files.length ? 20 : 26} />
                <span className="text-sm font-semibold text-fog">
                  {files.length ? "Add more files" : "Drop files here or click to browse"}
                </span>
                <span className="text-center font-mono text-[11px] text-fern">
                  any type · pick, drop or paste as many as you like · up to {FILE_MAX_LABEL} each
                </span>
              </button>
            </div>
          )}
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => addFiles(e.target.files)}
          />
        </div>

        {canLock && (
          <label className="mt-5 block">
            <span className="font-mono text-[10px] font-bold tracking-[0.2em] text-fern">PASSWORD (OPTIONAL)</span>
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              aria-describedby="pw-hint"
              aria-invalid={passwordShort || undefined}
              placeholder="Encrypts the drop in this browser — send it separately from the PIN"
              className="mt-1.5 w-full rounded-lg border border-line bg-ink/60 px-3.5 py-2.5 text-sm text-fog placeholder:text-fern/70 focus:border-gold/60 focus:outline-none"
            />
            <span id="pw-hint" className={`mt-1 block font-mono text-[10px] tracking-wider ${passwordShort ? "text-ember" : "text-fern"}`}>
              {passwordShort
                ? `AT LEAST ${PASSWORD_MIN} CHARACTERS`
                : usePassword
                ? "THE VAULT STORES ONLY CIPHERTEXT. LOSE THE PASSWORD AND NOBODY CAN OPEN IT — NOT EVEN YOU, FROM ANOTHER DEVICE."
                : "WITHOUT ONE, THE PIN ALONE OPENS IT."}
            </span>
            {usePassword && tab === "file" && (
              <span className="mt-1 block font-mono text-[10px] tracking-wider text-gold">
                LOCKS THE FILE NAMES AND LINKS, NOT THE FILE BYTES — THE STORAGE HOST CAN STILL READ THOSE.
              </span>
            )}
          </label>
        )}

        {/* fuse + open limit — an inbox's owner already chose these */}
        {!inboxTarget && (
        <>
        <div className="mt-5 flex flex-wrap items-start gap-x-6 gap-y-4">
          <div>
            <p className="font-mono text-[10px] font-bold tracking-[0.2em] text-fern">SELF-DESTRUCT</p>
            <div className="mt-1.5 flex gap-1.5">
              {EXPIRY_OPTIONS.map((o) => (
                <button
                  key={o.label}
                  type="button"
                  disabled={busy}
                  aria-pressed={expiry === o.ms}
                  onClick={() => setExpiry(o.ms)}
                  className={`rounded-md border px-3 py-1.5 font-mono text-[11px] font-bold tracking-wider transition-colors ${
                    expiry === o.ms ? "border-gold/70 bg-gold/15 text-brass" : "border-line text-sage hover:border-gold/40"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="flex items-center gap-1.5 font-mono text-[10px] font-bold tracking-[0.2em] text-fern">
              <IconFlame width={12} height={12} /> OPENS ALLOWED
            </p>
            <div className="mt-1.5 flex gap-1.5">
              {OPEN_OPTIONS.map((o) => (
                <button
                  key={o.label}
                  type="button"
                  disabled={busy}
                  aria-pressed={maxOpens === o.n}
                  onClick={() => setMaxOpens(o.n)}
                  className={`rounded-md border px-3 py-1.5 font-mono text-[11px] font-bold tracking-wider transition-colors ${
                    maxOpens === o.n
                      ? o.n === 1
                        ? "border-ember/70 bg-ember/15 text-ember"
                        : "border-gold/70 bg-gold/15 text-brass"
                      : "border-line text-sage hover:border-gold/40"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <p className="mt-3 font-mono text-[10px] leading-relaxed tracking-[0.08em] text-fern">
          EVERY DROP SELF-DESTRUCTS — 7 DAYS AT MOST. A PIN THAT LIVES FOREVER IS A PIN SOMEONE EVENTUALLY GUESSES.
        </p>
        </>
        )}

        {tab === "file" && (
          <p className="mt-3 font-mono text-[10px] leading-relaxed tracking-[0.08em] text-fern">
            {r2On
              ? "UP TO 50 GB PER FILE, UPLOADED IN 8 MB PARTS THAT RESUME WHERE THEY STOPPED — CLOSE THE TAB MID-FILE AND RE-ADD IT LATER."
              : "FILES GO TO FREE THIRD-PARTY RELAYS: TMPFILES (≤100 MB, KEPT 48H), LITTERBOX (≤1 GB, 72H), GOFILE (BIGGER, DOWNLOAD PAGE ONLY). NO RESUME, AND THE FUSE IS CUT TO THE RELAY'S LIFETIME. THE RELAYS CAN READ WHAT YOU UPLOAD."}
          </p>
        )}

        {/* progress strip while busy */}
        {busy && (
          <div className="mt-5">
            <div className="flex items-center justify-between gap-3 font-mono text-[11px] font-bold tracking-[0.2em] text-mint">
              <span className={pct === null ? "animate-pulse" : ""}>
                {phase === "uploading"
                  ? `RELAYING ${Math.min(progress.done + 1, progress.total)}/${progress.total}…`
                  : "PUBLISHING TO CLOUD VAULT…"}
              </span>
              <span className="shrink-0 tabular-nums">
                {phase === "uploading" && pct !== null ? `${pct}%` : pinPreview}
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink/70">
              {pct === null ? (
                <div className="animate-slide h-full rounded-full bg-gradient-to-r from-gold via-mint to-gold" />
              ) : (
                <div
                  className="h-full rounded-full bg-gradient-to-r from-gold to-mint transition-[width] duration-200"
                  style={{ width: `${pct}%` }}
                />
              )}
            </div>
            {phase === "uploading" && progress.name && (
              <p className="mt-1.5 flex justify-between gap-3 font-mono text-[10px] tracking-wider text-fern">
                <span className="truncate">{progress.name}</span>
                {progress.bytes > 0 && (
                  <span className="shrink-0 tabular-nums">
                    {formatBytes(progress.sent)} / {formatBytes(progress.bytes)}
                  </span>
                )}
              </p>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => void handleSeal()}
          disabled={!ready || busy}
          className="mt-6 w-full rounded-lg bg-gold py-3.5 font-display text-lg font-extrabold tracking-wide text-ink shadow-[0_10px_30px_-10px_rgba(233,180,76,0.55)] transition-all hover:-translate-y-0.5 hover:shadow-[0_14px_36px_-8px_rgba(233,180,76,0.7)] active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none disabled:hover:translate-y-0"
        >
          {busy
            ? phase === "uploading"
              ? `RELAYING ${Math.min(progress.done + 1, progress.total)}/${progress.total}${pct === null ? "" : ` · ${pct}%`}…`
              : "SEALING…"
            : inboxTarget
            ? `SEND INTO INBOX ••${inboxTarget.pin.slice(-4)}`
            : tab === "inbox"
            ? "OPEN AN INBOX · MINT MY PIN"
            : usePassword
            ? burn
              ? "SEAL IT · LOCKED · BURN ON OPEN"
              : "SEAL IT · PASSWORD-LOCKED"
            : burn
            ? "SEAL IT · BURN ON OPEN"
            : "SEAL IT · MINT MY PIN"}
        </button>
      </div>

      {/* ------------ receipt ------------ */}
      <div className="flex min-w-0 flex-col">
        {sealed ? (
          <div key={sealed.id} className="paper-rise flex-1">
            <div className="receipt relative flex h-full flex-col rounded-lg border border-line bg-[#0e1611] p-5 sm:p-6">
              <span className="absolute right-5 top-5 rotate-12 rounded border-2 border-mint/70 px-2 py-1 font-mono text-[10px] font-bold tracking-[0.2em] text-mint stamp-in">
                {sealed.remote ? "SEALED · CLOUD" : "SEALED · LOCAL"}
              </span>
              <p className="font-mono text-[10px] font-bold tracking-[0.3em] text-gold">PINDROP RECEIPT</p>
              <h3 className="mt-3 truncate font-display text-2xl font-bold text-fog">{sealed.title}</h3>
              <dl className="mt-2 space-y-1 font-mono text-[11px] tracking-wider text-sage">
                <div className="flex gap-2">
                  <dt className="text-fern">TYPE</dt>
                  <dd>
                    {sealed.type.toUpperCase()}
                    {sealedFiles.length
                      ? ` · ${sealedFiles.length} FILE${sealedFiles.length === 1 ? "" : "S"} · ${formatBytes(totalBytes(sealedFiles))}`
                      : ""}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-fern">FUSE</dt>
                  <dd>{sealed.expiresAt ? new Date(sealed.expiresAt).toLocaleString() : "NONE"}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-fern">OPENS</dt>
                  <dd>
                    {sealed.type === "inbox"
                      ? "YOU ALONE, ONCE FILLED"
                      : sealed.burnAfterRead
                      ? "1 · BURNS ON OPEN"
                      : sealed.maxOpens
                      ? `${sealed.maxOpens} MAX`
                      : "UNLIMITED UNTIL THE FUSE"}
                  </dd>
                </div>
                {sealed.locked && (
                  <div className="flex gap-2">
                    <dt className="text-fern">LOCK</dt>
                    <dd className="text-brass">PASSWORD · NOT STORED — SEND IT SEPARATELY</dd>
                  </div>
                )}
              </dl>

              <div className="my-5 border-t border-dashed border-line" />

              <p className="text-center font-mono text-[10px] font-bold tracking-[0.3em] text-fern">YOUR PIN</p>
              <div className="mt-3 flex justify-center gap-2">
                {sealed.pin.split("").map((d, i) => (
                  <span
                    key={i}
                    className="flex h-12 w-10 items-center justify-center rounded-md border border-gold/50 bg-gold/10 font-mono text-xl font-bold text-brass"
                    style={{ animation: `pinReveal 0.35s ${0.5 + i * 0.09}s both` }}
                  >
                    {d}
                  </span>
                ))}
              </div>

              <div className="mt-5 space-y-2.5">
                <div className="flex gap-2">
                  <CopyButton text={sealed.pin} className="btn-solid" label="COPY PIN" />
                  <CopyButton text={shareLink} className="btn-ghost" label="COPY SHARE LINK" />
                </div>
                {sealed.remote && (
                  <div className="flex items-center gap-4 rounded-lg border border-line bg-ink/40 p-3">
                    <QrCode text={shareLink} size={112} />
                    <p className="font-mono text-[10px] leading-relaxed tracking-[0.08em] text-sage">
                      SCAN WITH A PHONE CAMERA — IT OPENS THIS PINDROP AND TYPES THE PIN FOR YOU.
                    </p>
                  </div>
                )}
                {offlineLink && (
                  <CopyButton
                    text={offlineLink}
                    label="COPY OFFLINE LINK — PAYLOAD RIDES IN THE URL"
                    className="btn-ghost w-full"
                  />
                )}
              </div>

              <p className="mt-4 font-mono text-[10px] leading-relaxed tracking-[0.06em] text-fern">
                {sealed.remote && sealed.type === "inbox"
                  ? "GIVE THIS PIN (OR THE QR) TO WHOEVER IS SENDING YOU SOMETHING. KEEP THIS TAB OPEN OR COME BACK LATER — WHAT THEY SEND SHOWS UP IN YOUR VAULT."
                  : sealed.remote
                  ? "SEND THE LINK — OR JUST THE DIGITS ONCE THEY'VE OPENED ANY PINDROP LINK. WORKS ON ANY DEVICE, ANY DISTANCE."
                  : "CLOUD VAULT UNREACHABLE — STORED ON THIS DEVICE ONLY. RETRY LATER TO PUBLISH IT."}
              </p>
              <button
                type="button"
                onClick={onDismissReceipt}
                className="mt-4 self-start font-mono text-[11px] font-bold tracking-[0.2em] text-sage underline-offset-4 transition-colors hover:text-brass hover:underline"
              >
                ✕ DISMISS RECEIPT
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col justify-center rounded-xl border border-dashed border-line bg-pine/40 p-8 text-center">
            <p className="font-mono text-[11px] font-bold tracking-[0.26em] text-gold">NO RECEIPT YET</p>
            <p className="mx-auto mt-3 max-w-[30ch] text-sm leading-relaxed text-sage">
              Seal something and your PIN receipt lands here — with a share link that opens the
              drop on any device.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

const pinPreview = "PIN MINTING";

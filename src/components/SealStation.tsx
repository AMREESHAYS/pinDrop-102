import { useMemo, useRef, useState, type ReactNode } from "react";
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
import { resumableBytes } from "../lib/r2";
import { CopyButton } from "./ui";
import { IconFile, IconFlame, IconLink, IconNote, IconUpload, IconX } from "./icons";

const TABS: { type: DropType; label: string; icon: (p: { width: number; height: number }) => ReactNode }[] = [
  { type: "note", label: "Note", icon: (p) => <IconNote {...p} /> },
  { type: "link", label: "Link", icon: (p) => <IconLink {...p} /> },
  { type: "file", label: "File", icon: (p) => <IconFile {...p} /> },
];

const EXPIRY_OPTIONS = [
  { label: "1H", ms: 36e5 },
  { label: "24H", ms: 864e5 },
  { label: "7D", ms: 7 * 864e5 },
];

type Phase = "idle" | "uploading" | "sealing";
const NO_PROGRESS: BatchProgress = { done: 0, total: 0, name: "", sent: 0, bytes: 0 };

interface Props {
  takenPins: Set<string>;
  seal: (draft: Drop) => Promise<Drop | null>;
  onError: (msg: string) => void;
  sealed: Drop | null;
  onDismissReceipt: () => void;
}

export function SealStation({ takenPins, seal, onError, sealed, onDismissReceipt }: Props) {
  const [tab, setTab] = useState<DropType>("note");
  const [note, setNote] = useState("");
  const [link, setLink] = useState("");
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [expiry, setExpiry] = useState<number | null>(null);
  const [burn, setBurn] = useState(false);
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

  const removeFile = (i: number) => setFiles((prev) => prev.filter((_, n) => n !== i));

  const clearFiles = () => {
    setFiles([]);
    if (fileInput.current) fileInput.current.value = "";
  };

  const valid =
    (tab === "note" && note.trim().length > 0) ||
    (tab === "link" && link.trim().length > 0) ||
    (tab === "file" && files.length > 0);

  const handleSeal = async () => {
    if (!valid || busy) return;
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
          : relayed && relayed.length > 1
          ? `${relayed.length} files`
          : relayed?.[0]?.name || "Sealed file"),
      createdAt: Date.now(),
      expiresAt: expiry ? Date.now() + expiry : undefined,
      burnAfterRead: burn || undefined,
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
      const result = await seal(draft);
      if (result) {
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
        {/* tabs */}
        <div className="flex w-full gap-1.5 rounded-lg border border-line bg-ink/60 p-1.5 sm:w-max">
          {TABS.map((t) => (
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
                  any type · pick as many as you like · up to {FILE_MAX_LABEL} each · relayed anonymously
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

        {/* fuse + burn */}
        <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-4">
          <div>
            <p className="font-mono text-[10px] font-bold tracking-[0.2em] text-fern">SELF-DESTRUCT</p>
            <div className="mt-1.5 flex gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => setExpiry(null)}
                className={`rounded-md border px-3 py-1.5 font-mono text-[11px] font-bold tracking-wider transition-colors ${
                  expiry === null ? "border-gold/70 bg-gold/15 text-brass" : "border-line text-sage hover:border-gold/40"
                }`}
              >
                NEVER
              </button>
              {EXPIRY_OPTIONS.map((o) => (
                <button
                  key={o.label}
                  type="button"
                  disabled={busy}
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
          <label className={`flex cursor-pointer select-none items-center gap-2.5 ${busy ? "opacity-50" : ""}`}>
            <input type="checkbox" checked={burn} disabled={busy} onChange={(e) => setBurn(e.target.checked)} className="peer sr-only" />
            <span className="relative h-6 w-11 shrink-0 rounded-full border border-line bg-ink/60 transition-colors peer-checked:border-ember/60 peer-checked:bg-ember/20">
              <span className={`absolute left-0.5 top-0.5 h-[18px] w-[18px] rounded-full bg-sage transition-transform peer-checked:translate-x-0 ${burn ? "translate-x-5 bg-ember" : ""}`} />
            </span>
            <span className="flex items-center gap-1.5 font-mono text-[11px] font-bold tracking-wider text-sage">
              <IconFlame width={13} height={13} /> BURN AFTER FIRST OPEN
            </span>
          </label>
        </div>

        {tab === "file" && (
          <p className="mt-3 font-mono text-[10px] leading-relaxed tracking-[0.08em] text-fern">
            UP TO 50 GB PER FILE. WITH PINDROP STORAGE CONFIGURED, UPLOADS GO IN 8 MB PARTS AND
            RESUME WHERE THEY STOPPED — CLOSE THE TAB MID-FILE AND RE-ADD IT LATER. OTHERWISE FILES
            FALL BACK TO THE FREE RELAYS (TMPFILES 48H / GOFILE ~10 DAYS), WHICH CANNOT RESUME.
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
          disabled={!valid || busy}
          className="mt-6 w-full rounded-lg bg-gold py-3.5 font-display text-lg font-extrabold tracking-wide text-ink shadow-[0_10px_30px_-10px_rgba(233,180,76,0.55)] transition-all hover:-translate-y-0.5 hover:shadow-[0_14px_36px_-8px_rgba(233,180,76,0.7)] active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none disabled:hover:translate-y-0"
        >
          {busy
            ? phase === "uploading"
              ? `RELAYING ${Math.min(progress.done + 1, progress.total)}/${progress.total}${pct === null ? "" : ` · ${pct}%`}…`
              : "SEALING…"
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
                  <dt className="text-fern">BURN</dt>
                  <dd>{sealed.burnAfterRead ? "AFTER FIRST OPEN" : "OFF"}</dd>
                </div>
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
                {offlineLink && (
                  <CopyButton
                    text={offlineLink}
                    label="COPY OFFLINE LINK — PAYLOAD RIDES IN THE URL"
                    className="btn-ghost w-full"
                  />
                )}
              </div>

              <p className="mt-4 font-mono text-[10px] leading-relaxed tracking-[0.06em] text-fern">
                {sealed.remote
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

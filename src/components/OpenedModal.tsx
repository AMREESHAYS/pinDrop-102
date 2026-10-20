import { useEffect, useState } from "react";
import {
  BLOB_DOWNLOAD_MAX,
  dropFiles,
  formatBytes,
  isDirectLink,
  totalBytes,
  TYPE_LABEL,
  type Drop,
  type FileMeta,
} from "../lib/vault";
import { CopyButton } from "./ui";
import { IconCheck, IconDownload, IconFile, IconFlame, IconLink, IconNote, IconX } from "./icons";

interface Props {
  drop: Drop;
  burned: boolean;
  via?: "local" | "cloud";
  onClose: () => void;
}

const RELAY_LABEL: Record<FileMeta["host"], string> = {
  r2: "PinDrop storage",
  tmpfiles: "tmpfiles relay",
  litterbox: "litterbox relay",
  gofile: "gofile relay",
};

function normalizeLink(l: string): string {
  return /^https?:\/\//i.test(l) ? l : `https://${l}`;
}

type DlState = "idle" | "busy" | "done" | "handed";

/** Inline preview for media the browser can show safely: <img>/<video>/<audio> never run scripts. */
function Preview({ file }: { file: FileMeta }) {
  if (!isDirectLink(file)) return null;
  const mime = file.mime || "";
  const cls = "mt-3 max-h-64 w-full rounded-md bg-ink object-contain";
  if (mime.startsWith("image/")) return <img src={file.fileUrl} alt={file.name} loading="lazy" className={cls} />;
  if (mime.startsWith("video/")) return <video src={file.fileUrl} controls preload="metadata" className={cls} />;
  if (mime.startsWith("audio/")) return <audio src={file.fileUrl} controls preload="none" className="mt-3 w-full" />;
  return null;
}

export function OpenedModal({ drop, burned, via, onClose }: Props) {
  const files = dropFiles(drop);
  const [dl, setDl] = useState<Record<string, DlState>>({});
  const [allBusy, setAllBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  /** Hand the URL to the browser and let it stream to disk. */
  const openInTab = (file: FileMeta) => {
    window.open(file.fileUrl, "_blank", "noopener");
    setDl((s) => ({ ...s, [file.fileUrl]: "handed" }));
  };

  const download = async (file: FileMeta) => {
    if (dl[file.fileUrl] === "busy") return;
    // Blob-downloading reads the whole file into memory to keep its filename.
    // That is fine for a small file and kills the tab for a large one, and a
    // gofile URL is a landing page rather than the bytes.
    if (!isDirectLink(file) || file.size > BLOB_DOWNLOAD_MAX) {
      openInTab(file);
      return;
    }
    setDl((s) => ({ ...s, [file.fileUrl]: "busy" }));
    try {
      const res = await fetch(file.fileUrl);
      if (!res.ok) throw new Error("fetch");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      setDl((s) => ({ ...s, [file.fileUrl]: "done" }));
    } catch {
      // Relay blocked the cross-origin read — hand the tab over instead.
      openInTab(file);
    }
  };

  /* Sequential — browsers throttle (and Android blocks) a burst of saves. */
  const downloadAll = async () => {
    if (allBusy) return;
    setAllBusy(true);
    for (const f of files) await download(f);
    setAllBusy(false);
  };

  const anyHanded = files.some((f) => dl[f.fileUrl] === "handed");

  const icon =
    drop.type === "note" ? (
      <IconNote width={20} height={20} />
    ) : drop.type === "link" ? (
      <IconLink width={20} height={20} />
    ) : (
      <IconFile width={20} height={20} />
    );

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-ink/85 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Unlocked drop: ${drop.title}`}
    >
      <div
        className="modal-in w-full max-w-lg rounded-xl border border-gold/40 bg-pine shadow-[0_40px_80px_-20px_rgba(0,0,0,0.8)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-mint/12 text-mint">
              {icon}
            </span>
            <div className="min-w-0">
              <p className="font-mono text-[10px] font-bold tracking-[0.24em] text-mint">
                UNLOCKED · PIN {drop.pin}
                {via === "cloud" && <span className="ml-2 rounded bg-gold/15 px-1.5 py-0.5 text-[9px] text-brass">FROM CLOUD</span>}
                {via === "local" && <span className="ml-2 rounded bg-mint/15 px-1.5 py-0.5 text-[9px] text-mint">YOUR PREVIEW · NOT COUNTED</span>}
              </p>
              <h3 className="truncate font-display text-lg font-bold text-fog">{drop.title}</h3>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md border border-line p-1.5 text-sage transition-colors hover:border-ember/60 hover:text-ember"
          >
            <IconX width={15} height={15} />
          </button>
        </div>

        {/* body */}
        <div className="modal-body overflow-y-auto px-5 py-4">
          {drop.type === "note" && (
            <pre className="whitespace-pre-wrap break-words font-body text-sm leading-relaxed text-fog">
              {drop.payload.text}
            </pre>
          )}
          {drop.type === "link" && (
            <a
              href={normalizeLink(drop.payload.link || "")}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all font-mono text-sm text-brass underline decoration-gold/40 underline-offset-4 transition-colors hover:text-gold"
            >
              {drop.payload.link}
            </a>
          )}
          {drop.type === "file" && files.length > 0 && (
            <ul className="space-y-2.5">
              {files.map((f) => {
                const state = dl[f.fileUrl] || "idle";
                return (
                  <li key={f.fileUrl} className="rounded-lg border border-line bg-ink/50 px-4 py-3.5">
                  <div className="flex items-center gap-3.5">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-gold/12 text-gold">
                      <IconFile width={20} height={20} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-fog">{f.name}</p>
                      <p className="font-mono text-[11px] text-sage">
                        {formatBytes(f.size)} · via {RELAY_LABEL[f.host]}
                        {state === "handed" && <span className="text-gold"> · opened in a new tab</span>}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void download(f)}
                      disabled={state === "busy" || allBusy}
                      aria-label={`Download ${f.name}`}
                      className="shrink-0 rounded-md border border-line p-2.5 text-sage transition-colors hover:border-gold/50 hover:text-brass disabled:opacity-50"
                    >
                      {state === "done" ? <IconCheck width={15} height={15} /> : <IconDownload width={15} height={15} />}
                    </button>
                  </div>
                  <Preview file={f} />
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* actions */}
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-4">
          {drop.type === "note" && <CopyButton text={drop.payload.text || ""} label="Copy note" />}
          {drop.type === "link" && (
            <>
              <CopyButton text={drop.payload.link || ""} label="Copy link" />
              <a
                href={normalizeLink(drop.payload.link || "")}
                target="_blank"
                rel="noopener noreferrer"
                className="btn flex items-center gap-2 rounded-lg border border-line px-4 py-2.5 font-mono text-xs font-semibold tracking-wider text-sage transition-all hover:-translate-y-0.5 hover:border-gold/50 hover:text-brass"
              >
                OPEN <IconLink width={13} height={13} />
              </a>
            </>
          )}
          {drop.type === "file" && files.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => void downloadAll()}
                disabled={allBusy}
                className="btn-solid flex items-center gap-2 rounded-lg bg-gold px-4 py-2.5 font-mono text-xs font-bold tracking-wider text-ink transition-all hover:-translate-y-0.5 disabled:opacity-60"
              >
                {allBusy
                  ? "FETCHING…"
                  : files.length === 1
                  ? "DOWNLOAD"
                  : `DOWNLOAD ALL · ${files.length}`}
                <IconDownload width={13} height={13} />
              </button>
              {anyHanded && (
                <span className="font-mono text-[10px] tracking-wider text-gold">
                  LARGE FILES OPEN IN A NEW TAB — SAVE THEM FROM THERE
                </span>
              )}
            </>
          )}
          <span className="ml-auto font-mono text-[10px] tracking-[0.18em] text-fern">
            {TYPE_LABEL[drop.type].toUpperCase()}
            {files.length > 1 ? ` · ${files.length} FILES · ${formatBytes(totalBytes(files))}` : ""} · OPENED{" "}
            {drop.opens}×
          </span>
        </div>

        {/* burn banner */}
        {burned && (
          <div className="flex items-center gap-2.5 border-t border-ember/40 bg-ember/10 px-5 py-3">
            <IconFlame width={16} height={16} />
            <p className="font-mono text-[11px] font-semibold tracking-[0.14em] text-ember">
              THAT WAS THE LAST OPEN — THE PIN IS DEAD. SAVE EVERYTHING BEFORE YOU CLOSE THIS.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

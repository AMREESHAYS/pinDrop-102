import { Fragment, useState } from "react";
import {
  buildShareLink,
  dropFiles,
  expiryLabel,
  formatBytes,
  isExpired,
  totalBytes,
  timeAgo,
  TYPE_LABEL,
  type Drop,
} from "../lib/vault";
import { CopyButton } from "./ui";
import {
  IconCloud,
  IconEye,
  IconEyeOff,
  IconFile,
  IconFlame,
  IconKey,
  IconLink,
  IconNote,
  IconTrash,
  IconUnlock,
} from "./icons";

interface Props {
  drops: Drop[];
  onOpen: (drop: Drop) => void;
  onDelete: (id: string) => void;
}

const typeIcon = (t: Drop["type"]) =>
  t === "note" ? (
    <IconNote width={18} height={18} />
  ) : t === "link" ? (
    <IconLink width={18} height={18} />
  ) : (
    <IconFile width={18} height={18} />
  );

function DropCard({
  drop,
  onOpen,
  onDelete,
  delay,
}: {
  drop: Drop;
  onOpen: (d: Drop) => void;
  onDelete: (id: string) => void;
  delay: number;
}) {
  const [revealed, setRevealed] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const expired = isExpired(drop);
  const soon = !expired && !!drop.expiresAt && drop.expiresAt - Date.now() < 36e5;

  const files = dropFiles(drop);
  const meta =
    drop.type === "note"
      ? `${(drop.payload.text || "").length.toLocaleString()} chars`
      : drop.type === "link"
      ? (drop.payload.link || "").replace(/^https?:\/\//, "").slice(0, 42)
      : files.length
      ? `${files.length} file${files.length === 1 ? "" : "s"} · ${formatBytes(totalBytes(files))}`
      : "file";

  return (
    <div
      className="card-rise group rounded-xl border border-line bg-pine/70 p-4 transition-all hover:-translate-y-0.5 hover:border-gold/40 hover:shadow-[0_16px_40px_-18px_rgba(233,180,76,0.35)]"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
              drop.type === "note"
                ? "bg-gold/12 text-gold"
                : drop.type === "link"
                ? "bg-mint/12 text-mint"
                : "bg-ember/12 text-ember"
            }`}
          >
            {typeIcon(drop.type)}
          </span>
          <div className="min-w-0">
            <p className="truncate font-display text-base font-bold text-fog">{drop.title}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] font-semibold tracking-[0.14em] text-fern">
              <span>{TYPE_LABEL[drop.type].toUpperCase()}</span>
              <span className="text-line">·</span>
              <span className="truncate">{meta}</span>
              <span className="text-line">·</span>
              <span>{timeAgo(drop.createdAt)}</span>
            </p>
          </div>
        </div>
        {drop.remote ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full border border-mint/30 bg-mint/10 px-2 py-1 font-mono text-[9px] font-bold tracking-[0.14em] text-mint">
            <IconCloud width={11} height={11} /> CLOUD
          </span>
        ) : (
          <span className="shrink-0 rounded-full border border-gold/30 bg-gold/10 px-2 py-1 font-mono text-[9px] font-bold tracking-[0.14em] text-brass">
            LOCAL
          </span>
        )}
      </div>

      {/* PIN row */}
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <span className="rounded-lg border border-line bg-ink/60 px-3 py-1.5 font-mono text-sm font-bold tracking-[0.3em] text-brass">
          {revealed ? drop.pin : "••••••"}
        </span>
        <button
          type="button"
          onClick={() => setRevealed((r) => !r)}
          aria-label={revealed ? "Hide PIN" : "Reveal PIN"}
          className="rounded-md border border-line p-2 text-sage transition-colors hover:border-gold/50 hover:text-brass"
        >
          {revealed ? <IconEyeOff width={14} height={14} /> : <IconEye width={14} height={14} />}
        </button>
        <CopyButton text={drop.pin} className="btn-chip" label="PIN" />

        <span className="ml-auto flex flex-wrap items-center gap-2 font-mono text-[10px] font-semibold tracking-wider">
          {drop.burnAfterRead && (
            <span className="flex items-center gap-1 rounded-full border border-ember/40 bg-ember/10 px-2 py-1 text-ember">
              <IconFlame width={10} height={10} /> BURN
            </span>
          )}
          {expired ? (
            <span className="rounded-full border border-ember/40 bg-ember/10 px-2 py-1 text-ember">EXPIRED</span>
          ) : drop.expiresAt ? (
            <span
              className={`rounded-full border px-2 py-1 ${
                soon ? "animate-glowpulse border-gold/50 bg-gold/10 text-gold" : "border-line text-sage"
              }`}
            >
              ⏳ {expiryLabel(drop)}
            </span>
          ) : (
            <span className="rounded-full border border-line px-2 py-1 text-fern">∞ NO FUSE</span>
          )}
        </span>
      </div>

      {/* actions */}
      <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-line/70 pt-3">
        <button
          type="button"
          onClick={() => onOpen(drop)}
          className="flex items-center gap-1.5 rounded-md bg-moss px-3 py-1.5 font-mono text-[11px] font-bold tracking-wider text-mint transition-all hover:-translate-y-0.5 hover:bg-mint/15"
        >
          <IconUnlock width={12} height={12} /> OPEN
        </button>
        <CopyButton text={buildShareLink(drop)} className="btn-chip" label="SHARE LINK" />
        <span className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[10px] tracking-wider text-fern">{drop.opens} OPEN{drop.opens === 1 ? "" : "S"}</span>
          {confirm ? (
            <Fragment>
              <button
                type="button"
                onClick={() => onDelete(drop.id)}
                className="rounded-md bg-ember px-2.5 py-1.5 font-mono text-[11px] font-bold text-ink"
              >
                SHRED?
              </button>
              <button
                type="button"
                onClick={() => setConfirm(false)}
                className="rounded-md border border-line px-2 py-1.5 font-mono text-[11px] text-sage"
              >
                KEEP
              </button>
            </Fragment>
          ) : (
            <button
              type="button"
              onClick={() => setConfirm(true)}
              aria-label="Shred drop"
              className="rounded-md border border-line p-1.5 text-sage transition-colors hover:border-ember/60 hover:text-ember"
            >
              <IconTrash width={13} height={13} />
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

export function VaultList({ drops, onOpen, onDelete }: Props) {
  if (drops.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-xl border border-dashed border-line bg-pine/40 px-6 py-14 text-center">
        <span className="text-fern">
          <IconKey width={34} height={34} />
        </span>
        <p className="mt-4 font-mono text-xs font-bold tracking-[0.24em] text-sage">VAULT EMPTY</p>
        <p className="mt-2 max-w-[38ch] text-sm leading-relaxed text-fern">
          Nothing sealed yet. Drop a note, link or file into the Seal Station and your first PIN
          will land here.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {drops.map((d, i) => (
        <DropCard key={d.id} drop={d} onOpen={onOpen} onDelete={onDelete} delay={i * 70} />
      ))}
    </div>
  );
}

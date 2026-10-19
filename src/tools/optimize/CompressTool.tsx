import { useEffect, useRef, useState } from "react";
import { Dropzone } from "../../components/files/Dropzone";
import { PdfFileList } from "../../components/files/PdfFileList";
import { Alert, ErrorAlert } from "../../components/ui/Alerts";
import { Checkbox, ChoiceCards, Segmented } from "../../components/ui/Field";
import { Icon } from "../../components/ui/Icon";
import { LocalNote, Panel } from "../../components/tool/Panel";
import { ProcessPanel } from "../../components/tool/ProcessPanel";
import { ResultPanel } from "../../components/tool/ResultPanel";
import { type SavingsRow, SavingsTable } from "../../components/tool/SavingsTable";
import { useEngineAvailable } from "../../hooks/useCapabilities";
import { useAcceptHandoff } from "../../hooks/useHandoff";
import { useJob } from "../../hooks/useJob";
import { type PdfItem, toPdfInput, toPdfSource, usePdfFiles } from "../../hooks/usePdfFiles";
import { compressOnServer } from "../../lib/api";
import { AppError, toAppError } from "../../lib/errors";
import { baseName, formatBytes, percentSaved, plural } from "../../lib/format";
import type { CompressLevel } from "../../lib/pdf/compress";
import { FLATTEN_SETTINGS, renderPagesAsJpeg } from "../../lib/pdf/flatten";
import type { OutputFile } from "../../lib/pdf/types";
import { runOperation } from "../../lib/worker/client";
import type { ToolProps } from "../types";

type Level = CompressLevel | "pictures" | "server";
type Preset = "screen" | "ebook" | "printer";
type Progress = (fraction: number, message?: string) => void;

interface FileOutcome {
  name: string;
  originalBytes: number;
  /** The compressed file; `null` when nothing smaller could be made (the original is kept) or it failed. */
  file: OutputFile | null;
  notes: string[];
  error?: string;
}

interface Batch {
  outcomes: FileOutcome[];
  level: Level;
}

const LEVELS: readonly { value: Level; title: string; tag?: string; description: string }[] = [
  {
    value: "lossless",
    title: "Lossless clean-up",
    description: "Rewrites the file more compactly and merges duplicate fonts and images. Nothing visible changes, but many PDFs have little to give.",
  },
  {
    value: "balanced",
    title: "Recommended",
    tag: "Best for most files",
    description: "Shrinks oversized images to 150 dpi and saves photos as JPEG at quality 70. Looks the same on screen, and is fine for email and everyday printing.",
  },
  {
    value: "strong",
    title: "Strong",
    description: "Images down to 96 dpi at lower JPEG quality. Much smaller, but fine detail in photos and small print in scans may soften.",
  },
  {
    value: "pictures",
    title: "Convert pages to pictures",
    description: "Turns every page into a JPEG picture. Often the smallest result for scans and graphics-heavy files, but text can no longer be selected, searched or copied, and links and form fields stop working.",
  },
];

async function compressOne(item: PdfItem, level: CompressLevel, progress: Progress, signal: AbortSignal): Promise<FileOutcome> {
  const result = await runOperation("compress", { input: toPdfInput(item), options: { level } }, { signal, onProgress: progress });
  return { name: item.name, originalBytes: result.originalBytes, file: result.smaller ? result.file : null, notes: result.notes };
}

const PRESET_DPI: Record<Preset, number> = { screen: 72, ebook: 150, printer: 300 };

/** Ghostscript on the self-hosted server. Its answer is checked like any other result, and only kept when it is really smaller. */
async function serverOne(item: PdfItem, preset: Preset, progress: Progress, signal: AbortSignal): Promise<FileOutcome> {
  const bytes = await compressOnServer({ name: item.name, bytes: item.bytes as Uint8Array }, preset, { signal, onProgress: (fraction, message) => progress(fraction * 0.9, message) });
  progress(0.92, "Checking the result");
  const probe = await runOperation("probe", { bytes }, { signal });
  if (probe.state !== "ok" || probe.pageCount !== item.pageCount) {
    throw new AppError("VERIFICATION_FAILED", "The server returned a file that does not match the original (it is damaged or has a different number of pages), so it was discarded.", { fileName: item.name });
  }
  const smaller = bytes.length <= item.size * 0.99;
  return {
    name: item.name,
    originalBytes: item.size,
    file: smaller ? { name: `${baseName(item.name)}_compressed.pdf`, bytes, mime: "application/pdf", pageCount: probe.pageCount } : null,
    notes: smaller
      ? [`Compressed by Ghostscript on your server (${preset}: images at about ${PRESET_DPI[preset]} dpi). The PDF was deleted from the server right after.`]
      : ["Ghostscript could not make this file smaller, so your original is kept."],
  };
}

async function picturesOne(item: PdfItem, progress: Progress, signal: AbortSignal): Promise<FileOutcome> {
  const pages = await renderPagesAsJpeg(toPdfSource(item), { ...FLATTEN_SETTINGS, signal }, { onProgress: (fraction, message) => progress(fraction * 0.8, message) });
  const file = await runOperation("assemblePageImages", { pages, name: `${baseName(item.name)}_compressed.pdf` }, { signal, onProgress: (fraction, message) => progress(0.8 + fraction * 0.2, message) });
  const smaller = file.bytes.length <= item.size * 0.99;
  return {
    name: item.name,
    originalBytes: item.size,
    file: smaller ? file : null,
    notes: smaller
      ? [`All ${plural(pages.length, "page")} ${pages.length === 1 ? "was" : "were"} converted to pictures at ${FLATTEN_SETTINGS.dpi} dpi. Text can no longer be selected or searched.`]
      : ["Turning the pages into pictures would not make this file smaller, so your original is kept."],
  };
}

export default function CompressTool({ tool }: ToolProps) {
  const files = usePdfFiles({ multiple: true });
  useAcceptHandoff(files.addBytes);
  const job = useJob<Batch>();
  const [level, setLevel] = useState<Level>("balanced");
  const [preset, setPreset] = useState<Preset>("ebook");
  const [understood, setUnderstood] = useState(false);
  const ghostscript = useEngineAvailable("ghostscript");
  const heading = useRef<HTMLHeadingElement>(null);

  const finished = job.state.phase === "done";
  useEffect(() => {
    if (finished) heading.current?.focus();
  }, [finished]);

  const allReady = files.items.length > 0 && files.items.every((item) => item.status === "ready");
  const totalBytes = files.ready.reduce((sum, item) => sum + item.size, 0);
  const anyProtected = files.ready.some((item) => item.encrypted);
  const needsPassword = files.ready.some((item) => item.encrypted && item.password);
  // The server cannot open a PDF that needs a password, so that mode is offered only when none of the files do.
  const serverOffered = ghostscript === true;
  const serverUsable = serverOffered && !needsPassword;
  const effectiveLevel: Level = level === "server" && !serverUsable ? "balanced" : level;
  const canRun = allReady && !files.busy && (effectiveLevel !== "pictures" || understood);

  const run = () =>
    job.run(async ({ signal, onProgress }) => {
      const targets = files.ready;
      const outcomes: FileOutcome[] = [];
      for (const [index, item] of targets.entries()) {
        const progress: Progress = (fraction, message) => onProgress((index + fraction) / targets.length, targets.length > 1 ? `File ${index + 1} of ${targets.length}: ${message ?? item.name}` : message);
        try {
          outcomes.push(
            effectiveLevel === "pictures"
              ? await picturesOne(item, progress, signal)
              : effectiveLevel === "server"
                ? await serverOne(item, preset, progress, signal)
                : await compressOne(item, effectiveLevel, progress, signal),
          );
        } catch (error) {
          const failure = toAppError(error);
          if (failure.code === "CANCELLED") throw failure;
          outcomes.push({ name: item.name, originalBytes: item.size, file: null, notes: [], error: failure.message });
        }
      }
      return { outcomes, level: effectiveLevel };
    });

  const startOver = () => {
    job.reset();
    files.clear();
    setUnderstood(false);
  };

  if (job.state.phase === "running") {
    return <ProcessPanel title="Compressing…" fraction={job.state.fraction} message={job.state.message} onCancel={job.cancel} />;
  }

  if (job.state.phase === "done") {
    const { outcomes, level: usedLevel } = job.state.result;
    const rows: SavingsRow[] = outcomes.map((outcome) => ({
      name: outcome.name,
      before: outcome.originalBytes,
      after: outcome.file ? outcome.file.bytes.length : null,
      error: outcome.error,
      notes: outcome.notes,
    }));
    const made = outcomes.filter((outcome): outcome is FileOutcome & { file: OutputFile } => outcome.file !== null);
    const before = outcomes.reduce((sum, outcome) => sum + (outcome.error ? 0 : outcome.originalBytes), 0);
    const after = outcomes.reduce((sum, outcome) => sum + (outcome.error ? 0 : (outcome.file?.bytes.length ?? outcome.originalBytes)), 0);
    const failures = outcomes.filter((outcome) => outcome.error).length;
    const table = <SavingsTable rows={rows} caption={outcomes.length === 1 ? "Before and after" : "Before and after, per file"} />;

    if (made.length === 0) {
      const canGoStronger = usedLevel === "lossless" || usedLevel === "balanced";
      return (
        <div className="result" data-testid="result-panel">
          <div className="result__head">
            <span className="result__check" style={{ background: "var(--info-soft)", color: "var(--info)" }}>
              <Icon name="info" size={28} strokeWidth={2.5} />
            </span>
            <div>
              <h2 className="result__title" ref={heading} tabIndex={-1} data-testid="no-reduction">
                {failures === outcomes.length ? "Nothing could be compressed" : outcomes.length === 1 ? "This PDF could not be made smaller" : "None of these PDFs could be made smaller"}
              </h2>
              <p className="result__sub">{failures === outcomes.length ? "See the reason for each file below." : "They are already compact at this level, so no new file was created and your originals are untouched."}</p>
            </div>
          </div>
          {table}
          <div className="result__actions">
            {canGoStronger && failures < outcomes.length && (
              <button
                type="button"
                className="btn btn--primary btn--lg"
                onClick={() => {
                  setLevel(usedLevel === "lossless" ? "balanced" : "strong");
                  job.reset();
                }}
              >
                Try the {usedLevel === "lossless" ? "recommended" : "strong"} level
              </button>
            )}
            <button type="button" className="btn btn--secondary btn--lg" onClick={job.reset}>
              Change options
            </button>
            <button type="button" className="btn btn--ghost btn--lg" onClick={startOver}>
              Start over
            </button>
          </div>
        </div>
      );
    }

    return (
      <ResultPanel
        title={made.length === 1 ? "Your compressed PDF is ready" : `${made.length} compressed PDFs are ready`}
        subtitle={`${formatBytes(before)} became ${formatBytes(after)}.`}
        files={made.map((outcome) => outcome.file)}
        stats={[
          { label: "Original", value: formatBytes(before) },
          { label: "Compressed", value: formatBytes(after) },
          { label: "Saved", value: `${percentSaved(before, after)}%  (${formatBytes(before - after)})`, good: true },
        ]}
        notes={
          <>
            {failures > 0 && (
              <Alert tone="warning" title={`${plural(failures, "file")} could not be compressed`}>
                <p>The others finished. The reason for each file is in the table.</p>
              </Alert>
            )}
            {made.length < outcomes.length - failures && <Alert tone="info">Files that could not be made smaller are not included in the download. Your originals are unchanged.</Alert>}
            {anyProtected && <Alert tone="info">The compressed copies are not password-protected. Use Protect PDF to add a password again.</Alert>}
            {table}
          </>
        }
        zipName="compressed-pdfs.zip"
        onReset={startOver}
        onBack={job.reset}
        nextTools={["protect", "merge", "split"]}
      />
    );
  }

  if (files.items.length === 0) {
    return (
      <Dropzone
        extensions={tool.accept}
        multiple
        pickLabel={tool.pickLabel}
        onFiles={files.addFiles}
        rejections={files.rejections}
        onDismissRejections={files.clearRejections}
        note={<LocalNote />}
      />
    );
  }

  return (
    <div className="tool-layout tool-layout--side">
      <div className="tool-layout__main">
        {job.state.phase === "error" && <ErrorAlert error={job.state.error} onDismiss={job.reset} />}
        <PdfFileList items={files.items} onMove={files.move} onRemove={files.remove} onUnlock={files.unlock} onReplace={files.replace} sortable={false} label="PDFs to compress" />
        <Dropzone compact extensions={tool.accept} multiple pickLabel={tool.pickLabel} onFiles={files.addFiles} rejections={files.rejections} onDismissRejections={files.clearRejections} />
      </div>

      <aside className="tool-layout__side">
        <Panel title="Compress">
          <p className="panel__note" data-testid="compress-summary">
            {plural(files.items.length, "file")} · {formatBytes(totalBytes)}
          </p>
          <ChoiceCards<Level>
            name="compression-level"
            legend="Compression level"
            value={effectiveLevel}
            onChange={(next) => {
              setLevel(next);
              if (next !== "pictures") setUnderstood(false);
            }}
            options={[
              ...LEVELS.map((option) => ({ value: option.value, title: option.title, tag: option.tag, description: option.description, testId: `level-${option.value}`, disabled: false })),
              ...(serverOffered
                ? [
                    {
                      value: "server" as const,
                      title: "Stronger (Ghostscript on your server)",
                      tag: undefined,
                      testId: "level-server",
                      disabled: !serverUsable,
                      description: serverUsable
                        ? "Uses Ghostscript on the server you run, which can shrink some scans and complicated files further. The PDF is uploaded to your server and deleted right after."
                        : "Not available for a PDF you opened with a password: the server cannot open it.",
                    },
                  ]
                : []),
            ]}
          />
          {effectiveLevel === "server" && (
            <Segmented<Preset>
              name="gs-preset"
              legend="Ghostscript preset"
              value={preset}
              onChange={setPreset}
              options={[
                { value: "screen", label: "Smallest (72 dpi)" },
                { value: "ebook", label: "Balanced (150 dpi)" },
                { value: "printer", label: "Best quality (300 dpi)" },
              ]}
            />
          )}
          {effectiveLevel === "pictures" && (
            <Alert tone="warning" title="This changes what the PDF is">
              <Checkbox checked={understood} onChange={setUnderstood} label="I understand that text, links and form fields will be flattened into pictures." />
            </Alert>
          )}
          {anyProtected && <Alert tone="info">Protected files are opened with the password you entered. The compressed copy is not protected.</Alert>}
          {files.items.length > 0 && !allReady && !files.busy && <Alert tone="warning">Open, repair or remove the files that have a problem before compressing.</Alert>}
          <div className="action-bar">
            <button type="button" className="btn btn--primary btn--lg" disabled={!canRun} onClick={run} data-testid="compress-button">
              <Icon name="compress" size={22} />
              {files.items.length > 1 ? `Compress ${files.items.length} PDFs` : "Compress PDF"}
            </button>
            <div className="action-bar__row">
              <button type="button" className="btn btn--ghost btn--sm" onClick={files.clear}>
                Remove all
              </button>
            </div>
          </div>
        </Panel>
      </aside>
    </div>
  );
}

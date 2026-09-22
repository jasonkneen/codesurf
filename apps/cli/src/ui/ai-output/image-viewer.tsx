// ImageViewer — metadata panel + ASCII fallback lines for an image
// attachment. Ported from termcast's image-viewer.tsx in reduced form: the
// full termcast version sends Kitty / iTerm2 / Sixel graphics protocol
// escape sequences via `services/image-protocol`, which codesurf doesn't
// currently implement. So this port shows the metadata + fallback frame;
// wiring real graphics support is a follow-up that slots in via the
// `renderPreview` callback (default stub just reports success/failure).

import { useEffect, useState } from "react";
import { hostFiles } from "../host-files.js";
import type { Theme } from "../theme";
import { AgentPanel, PanelPill } from "./panel-frame";

export type ImageFitMode = "contain" | "cover" | "actual";
export type ImageViewerMode = "inline" | "popup";

export interface ImageAttachment {
  id: string;
  name: string;
  path?: string;
  mime?: string;
  size?: number;
  /** Rough pixel dimensions if known — used only for the fallback frame. */
  width?: number;
  height?: number;
}

export interface ImageViewerProps {
  t: Theme;
  attachment: ImageAttachment;
  mode?: ImageViewerMode;
  title?: string;
  fit?: ImageFitMode;
  autoPreview?: boolean;
  statusLabel?: string;
  onRequestPopup?: () => void;
  onRequestInline?: () => void;
  /** Hook for wiring terminal graphics protocols later. Return true if the
   *  request was delivered, false if the terminal can't render directly. */
  renderPreview?: (attachment: ImageAttachment, opts: { mode: ImageViewerMode; fit: ImageFitMode }) => boolean;
}

type PreviewState = "idle" | "sent" | "fallback" | "opened" | "open-failed" | "no-path";

const FIT_MODES: ImageFitMode[] = ["contain", "cover", "actual"];

function formatBytes(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes)) return "unknown size";
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function shortenPath(path?: string): string {
  if (!path) return "(no path)";
  if (path.length <= 48) return path;
  return `…${path.slice(-47)}`;
}

function isImage(attachment: ImageAttachment): boolean {
  if (attachment.mime) return attachment.mime.startsWith("image/");
  const ext = attachment.name.split(".").pop()?.toLowerCase();
  return !!ext && ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext);
}

function buildFallbackLines(attachment: ImageAttachment, fit: ImageFitMode): string[] {
  const width = attachment.width ?? 0;
  const height = attachment.height ?? 0;
  const dim = width && height ? `${width}×${height}` : "dimensions unknown";
  return [
    `[${attachment.name}]`,
    `fit: ${fit}  ·  ${dim}  ·  ${formatBytes(attachment.size)}`,
    "(terminal graphics preview not wired; see renderPreview prop)",
  ];
}

export function ImageViewer({
  t,
  attachment,
  mode = "inline",
  title = "image viewer",
  fit,
  autoPreview = false,
  statusLabel,
  onRequestPopup,
  onRequestInline,
  renderPreview,
}: ImageViewerProps) {
  const effectiveFit = fit ?? (mode === "popup" ? "contain" : "contain");
  const [activeFit, setActiveFit] = useState<ImageFitMode>(effectiveFit);
  const [showDetails, setShowDetails] = useState(mode === "popup");
  const [previewState, setPreviewState] = useState<PreviewState>("idle");

  useEffect(() => {
    setActiveFit(effectiveFit);
  }, [effectiveFit]);

  useEffect(() => {
    setShowDetails(mode === "popup");
  }, [mode]);

  useEffect(() => {
    if (!autoPreview) return;
    const ok = renderPreview?.(attachment, { mode, fit: activeFit }) ?? false;
    setPreviewState(ok ? "sent" : "fallback");
  }, [attachment, autoPreview, mode, activeFit, renderPreview]);

  function triggerPreview(): void {
    const ok = renderPreview?.(attachment, { mode, fit: activeFit }) ?? false;
    setPreviewState(ok ? "sent" : "fallback");
  }

  function triggerOpen(): void {
    if (!attachment.path) {
      setPreviewState("no-path");
      return;
    }
    const ok = hostFiles.open(attachment.path);
    setPreviewState(ok ? "opened" : "open-failed");
  }

  const fallbackLines = buildFallbackLines(attachment, activeFit);
  const previewStatus =
    previewState === "sent"
      ? "preview requested"
      : previewState === "fallback"
        ? "fallback only"
        : previewState === "opened"
          ? "opened in system viewer"
          : previewState === "open-failed"
            ? "could not launch viewer"
            : previewState === "no-path"
              ? "no file path to open"
              : (statusLabel ?? (mode === "popup" ? "popup fit" : "inline fit"));

  return (
    <AgentPanel
      t={t}
      title={title}
      meta={`${attachment.mime ?? "image/*"}  ${formatBytes(attachment.size)}`}
      statusLabel={previewStatus}
      statusColor={previewState === "fallback" ? t.accent : t.accent}
    >
      <box flexDirection="column">
        <text fg={t.text} wrapMode="none">
          <b>{attachment.name}</b>
        </text>
        <text fg={t.textMuted}>{shortenPath(attachment.path)}</text>

        <box flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
          {FIT_MODES.map((option) => (
            <PanelPill
              key={option}
              t={t}
              label={option}
              fg={activeFit === option ? t.background : undefined}
              bg={activeFit === option ? t.accent : undefined}
              bold={activeFit === option}
              onSelect={() => setActiveFit(option)}
            />
          ))}
          <PanelPill
            t={t}
            label="Preview"
            fg={renderPreview ? t.background : t.textMuted}
            bg={renderPreview ? t.diffAddedFg : undefined}
            onSelect={triggerPreview}
          />
          {/* System-viewer escape hatch — works on every platform/terminal as
              long as the attachment has a real filesystem path. Until inline
              graphics-protocol support lands, this is the most useful action. */}
          <PanelPill
            t={t}
            label="Open"
            fg={attachment.path ? t.background : t.textMuted}
            bg={attachment.path ? t.accent : undefined}
            bold={!!attachment.path}
            onSelect={triggerOpen}
          />
          <PanelPill t={t} label={showDetails ? "Hide info" : "Show info"} onSelect={() => setShowDetails((c) => !c)} />
          {mode === "inline" && onRequestPopup && <PanelPill t={t} label="Popup" onSelect={onRequestPopup} />}
          {mode === "popup" && onRequestInline && <PanelPill t={t} label="Inline" onSelect={onRequestInline} />}
        </box>

        <box
          flexDirection="column"
          marginTop={1}
          border
          borderStyle="rounded"
          borderColor={t.border}
          backgroundColor={t.backgroundPanel}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
        >
          {!isImage(attachment) ? (
            <text fg={t.accent}>This attachment is not typed as an image. Metadata view only.</text>
          ) : (
            <box flexDirection="column">
              {fallbackLines.map((line, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static fallback message lines, fixed positional content
                <text key={`${attachment.id}-fallback-${index}`} fg={index === 0 ? t.text : t.textMuted}>
                  {line}
                </text>
              ))}
              {previewState === "sent" && (
                <text fg={t.diffAddedFg}>Preview request was sent to the terminal graphics layer.</text>
              )}
              {previewState === "opened" && <text fg={t.diffAddedFg}>Opened in system viewer.</text>}
              {previewState === "open-failed" && <text fg={t.diffRemovedFg}>Failed to launch system viewer.</text>}
              {previewState === "no-path" && (
                <text fg={t.diffRemovedFg}>No filesystem path on this attachment — cannot open externally.</text>
              )}
            </box>
          )}
        </box>

        {showDetails && (
          <box flexDirection="column" marginTop={1}>
            <text fg={t.textMuted}>{`path: ${attachment.path ?? "not available"}`}</text>
            <text fg={t.textMuted}>{`mime: ${attachment.mime ?? "unknown"}`}</text>
            <text fg={t.textMuted}>{`size: ${formatBytes(attachment.size)}`}</text>
            {attachment.width && attachment.height && (
              <text fg={t.textMuted}>{`dimensions: ${attachment.width}×${attachment.height}`}</text>
            )}
          </box>
        )}
      </box>
    </AgentPanel>
  );
}

export function makeExampleImageViewer(): ImageAttachment {
  return {
    id: "att-1",
    name: "screenshot-2026-04-19.png",
    path: "/Users/jkneen/Desktop/screenshot-2026-04-19.png",
    mime: "image/png",
    size: 482_301,
    width: 1_920,
    height: 1_080,
  };
}

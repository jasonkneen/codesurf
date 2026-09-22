// FPS / performance overlay — a small top-right box showing live renderer
// stats. Opt-in via the `render.fpsOverlay` feature flag (toggle in /flags).
//
// WHY THIS EXISTS / HOW TO READ IT
// --------------------------------
// OpenTUI renders ON DEMAND — it only paints when something requests a render.
// So at idle the healthy state is ~0 paints/sec. The two numbers that reveal
// wasted GPU/CPU work are:
//   • paints/s — actual paints per second, computed from the renderer's
//                monotonic frameId. >0 while you're sitting idle means SOMETHING
//                is forcing continuous redraws (a stuck animation/poll). Shown
//                in warn color when elevated at rest.
//   • live     — renderer.liveRequestCount: how many requestLive() calls are
//                currently un-dropped. >0 means a component pinned the renderer
//                into continuous-render mode (e.g. an inline image) and hasn't
//                released it. Shown in warn color when >0.
//
// This component is a passive observer: it NEVER calls requestLive itself (that
// would force the very continuous rendering it's trying to measure). It just
// reads getStats()/frameId on a slow timer and updates its own local state, so
// it re-renders only itself — never the App.

import { useRenderer } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import type { Theme } from "../theme";

const REFRESH_MS = 500;
const WARN = "#f97316"; // orange — elevated paints/sec or live>0
const COL_W = 17; // fixed row width so every cell is painted (no overlay bleed)

interface FpsStats {
  fps: number;
  paintsPerSec: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  live: number;
  frameId: number;
  targetFps: number;
  maxFps: number;
}

function fmtMs(n: number): string {
  return Number.isFinite(n) && n > 0 ? n.toFixed(1) : "—";
}

export function FpsOverlay({ t }: { t: Theme }) {
  const renderer = useRenderer();
  const [stats, setStats] = useState<FpsStats | null>(null);
  const lastFrameIdRef = useRef(0);
  const lastTimeRef = useRef(0);

  useEffect(() => {
    if (!renderer) return;
    // Enable sampling; reset on unmount so the renderer drops the overhead.
    renderer.setGatherStats(true);
    lastFrameIdRef.current = renderer.frameId ?? 0;
    lastTimeRef.current = Date.now();

    const id = setInterval(() => {
      const s = renderer.getStats();
      const now = Date.now();
      const frameId = renderer.frameId ?? 0;
      const dtSec = Math.max(0.001, (now - lastTimeRef.current) / 1000);
      // Real paints/sec from the monotonic frame counter — the honest
      // "are we redrawing when we shouldn't be" signal.
      const paintsPerSec = Math.max(0, Math.round((frameId - lastFrameIdRef.current) / dtSec));
      lastFrameIdRef.current = frameId;
      lastTimeRef.current = now;
      setStats({
        fps: Math.round(s.fps ?? 0),
        paintsPerSec,
        avgMs: s.averageFrameTime,
        minMs: s.minFrameTime,
        maxMs: s.maxFrameTime,
        live: renderer.liveRequestCount ?? 0,
        frameId,
        targetFps: renderer.targetFps ?? 0,
        maxFps: renderer.maxFps ?? 0,
      });
    }, REFRESH_MS);

    return () => {
      clearInterval(id);
      renderer.setGatherStats(false);
      renderer.resetStats();
    };
  }, [renderer]);

  if (!stats) return null;

  const bg = t.backgroundPanel;
  const paintsColor = stats.paintsPerSec > 5 ? WARN : t.textMuted;
  const liveColor = stats.live > 0 ? WARN : t.textMuted;
  const pad = (s: string) => (s.length >= COL_W ? s.slice(0, COL_W) : s + " ".repeat(COL_W - s.length));

  const rows: Array<{ id: string; text: string; fg: string }> = [
    { id: "hdr", text: "perf", fg: t.textMuted },
    { id: "fps", text: `fps      ${stats.fps}`, fg: t.text },
    { id: "paints", text: `paints/s ${stats.paintsPerSec}`, fg: paintsColor },
    { id: "frame", text: `frame    ${fmtMs(stats.avgMs)}ms`, fg: t.text },
    { id: "minmax", text: `min/max  ${fmtMs(stats.minMs)}/${fmtMs(stats.maxMs)}`, fg: t.textMuted },
    { id: "live", text: `live     ${stats.live}`, fg: liveColor },
    { id: "cap", text: `cap      ${stats.targetFps}/${stats.maxFps}`, fg: t.textMuted },
  ];

  return (
    <box
      position="absolute"
      right={1}
      top={0}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={t.border}
      backgroundColor={bg}
      paddingLeft={1}
      paddingRight={1}
    >
      {rows.map((row) => (
        <text key={row.id} bg={bg} fg={row.fg} wrapMode="none">
          {pad(row.text)}
        </text>
      ))}
    </box>
  );
}

// Shimmer — muted placeholder for streaming text, with an animated trailing
// dot cycle. Ported from termcast's ai-elements/shimmer (TextShimmer).
// Termcast uses a wave-highlight via LoadingText; codesurf doesn't have
// that yet, so this version cycles three dots as a minimal animation.

import { memo, useEffect, useState } from "react";
import type { Theme } from "../theme";

export const Shimmer = memo(function Shimmer({ t, children }: { t: Theme; children: string }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => (n + 1) % 4), 300);
    return () => clearInterval(id);
  }, []);
  const dots = ".".repeat(tick);
  return (
    <text fg={t.textMuted} wrapMode="none">
      {children}
      {dots}
    </text>
  );
});

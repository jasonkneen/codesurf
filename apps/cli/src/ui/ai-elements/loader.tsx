// Loader — braille-frame spinner. Ported from termcast's ai-elements/loader.
// Termcast uses its own useAnimationTick; codesurf doesn't have a global
// tick yet, so this implementation uses a local interval. Cheap enough for
// one-off streaming indicators.

import { useEffect, useState } from "react";
import type { Theme } from "../theme";

const FRAMES = ["◐", "◓", "◑", "◒"];

export function Loader({ t }: { t: Theme }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 150);
    return () => clearInterval(id);
  }, []);
  return (
    <box flexDirection="row" height={1} paddingLeft={2} marginBottom={1}>
      <text fg={t.accent} wrapMode="none">
        {FRAMES[tick % FRAMES.length]}
      </text>
    </box>
  );
}

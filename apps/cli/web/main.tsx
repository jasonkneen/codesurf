// Web entry for the phase 5 front.
//
// Two modes, one bundle:
//   - parity scenes (`?scene=widgets|markdown|composer`) — the P0/P1/P2
//     captures. The grid is fixed so a comparison at two widths compares
//     nothing.
//   - live (`?node=ws://host:port`) — P3. A curated composer + transcript
//     against a running `codesurf node`. The full TUI App is not mounted;
//     see src/ui-web/live/app.tsx.
import { createRoot } from "react-dom/client";
import { LiveApp } from "../src/ui-web/live/app.js";
import { nodeUrlFromSearch, sessionIdFromSearch } from "../src/ui-web/live/url.js";
import { COMPOSER_COLUMNS, COMPOSER_ROWS, ComposerScene } from "../src/ui-web/parity/composer-fixture.js";
import { captureGrid } from "../src/ui-web/parity/dom-grid.js";
import { PARITY_COLUMNS, PARITY_ROWS, ParityScene } from "../src/ui-web/parity/fixture.js";
import { MARKDOWN_COLUMNS, MARKDOWN_ROWS, MarkdownParityScene } from "../src/ui-web/parity/markdown-fixture.js";

const host = document.getElementById("root");
if (!host) throw new Error("missing #root");

const node = nodeUrlFromSearch(window.location.search);
if (node) {
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.overflow = "hidden";
  document.title = "codesurf — live";
  createRoot(host).render(<LiveApp url={node} sessionId={sessionIdFromSearch(window.location.search)} />);
} else {
  const SCENES = {
    widgets: { Scene: ParityScene, columns: PARITY_COLUMNS, rows: PARITY_ROWS },
    markdown: { Scene: MarkdownParityScene, columns: MARKDOWN_COLUMNS, rows: MARKDOWN_ROWS },
    composer: { Scene: ComposerScene, columns: COMPOSER_COLUMNS, rows: COMPOSER_ROWS },
  } as const;

  type SceneId = keyof typeof SCENES;

  const requested = new URLSearchParams(window.location.search).get("scene") ?? "widgets";
  const scene = SCENES[requested as SceneId];
  if (!scene) throw new Error(`unknown scene "${requested}" (have ${Object.keys(SCENES).join(", ")})`);

  host.style.width = `calc(${scene.columns} * 1ch)`;
  host.style.height = `calc(${scene.rows} * var(--row))`;

  createRoot(host).render(<scene.Scene />);

  declare global {
    interface Window {
      __codesurfParity?: () => ReturnType<typeof captureGrid>;
    }
  }

  window.__codesurfParity = () => captureGrid(host, scene.columns, scene.rows);
}

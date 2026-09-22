// The parity scenes, and the grid each is captured at.
//
// Shared by both capture scripts and the comparator so a scene is declared in
// exactly one place — a scene captured at two different sizes compares nothing,
// and that is an easy mistake to make across three files.

export const SCENES = [
  {
    id: "widgets",
    label: "ai-output widgets",
    module: "src/ui-web/parity/fixture.js",
    export: "ParityScene",
    columns: 100,
    rows: 70,
    // Static scene: the first frame is the final one.
    settleWhen: /Build plan/,
  },
  {
    id: "markdown",
    label: "markdown renderer",
    module: "src/ui-web/parity/markdown-fixture.js",
    export: "MarkdownParityScene",
    columns: 70,
    rows: 40,
    // The markdown renderable paints only once the worker delivers highlights
    // (drawUnstyledText: false), so the frame is blank until then. How long
    // that takes varies with the machine and the Bun version — a fixed sleep
    // silently captured an empty grid when the worker got slower.
    settleWhen: /Heading one/,
  },
];

export function sceneById(id) {
  const found = SCENES.find((scene) => scene.id === id);
  if (!found) throw new Error(`unknown scene: ${id} (have ${SCENES.map((s) => s.id).join(", ")})`);
  return found;
}

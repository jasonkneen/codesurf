// The markdown parity scene.
//
// Same contract as ./fixture.tsx: one module, both hosts. This one drives
// `src/ui/markdown.tsx` — the real component, with the real theme-built
// SyntaxStyle — so the terminal renders through OpenTUI's tree-sitter markdown
// renderable and the browser through src/ui-web/markdown.
//
// The sample covers every construct the transcript actually produces: headings,
// emphasis, inline code, both list kinds with nesting, a blockquote, a fenced
// code block, a table, a rule, and a link.

import { Markdown } from "../../ui/markdown.js";
import { getTheme } from "../../ui/themes/catalog.js";

/** Narrower and taller than the widget scene: markdown is a tall, thin thing. */
export const MARKDOWN_COLUMNS = 70;
export const MARKDOWN_ROWS = 40;

export const MARKDOWN_SAMPLE = `# Heading one

Some **bold** and *italic* and \`inline code\`.

## Heading two

- first item
- second item
  - nested item

1. ordered one
2. ordered two

> a block quote

\`\`\`ts
const x: number = 42;
function hi(name: string) { return "hello " + name; }
\`\`\`

| col a | col b |
|-------|-------|
| one   | two   |
| three | four  |

---

A [link](https://example.com) and a trailing paragraph.`;

const t = getTheme("dark");

export function MarkdownParityScene() {
  return (
    <box flexDirection="column" paddingLeft={1}>
      <Markdown content={MARKDOWN_SAMPLE} t={t} />
    </box>
  );
}

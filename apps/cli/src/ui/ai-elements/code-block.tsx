// CodeBlock — fenced code renderer routed through grok's Markdown so syntax
// highlighting + monospace layout come for free. Ported from termcast's
// ai-elements/code-block.

import { memo } from "react";
import { Markdown } from "../markdown";
import type { Theme } from "../theme";

export interface CodeBlockProps {
  t: Theme;
  code: string;
  language?: string;
}

export const CodeBlock = memo(function CodeBlock({ t, code, language = "" }: CodeBlockProps) {
  const fence = "```";
  const content = `${fence}${language}\n${code}\n${fence}`;
  return <Markdown content={content} t={t} />;
});

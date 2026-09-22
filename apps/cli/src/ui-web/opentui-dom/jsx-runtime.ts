// jsx-runtime.ts — maps OpenTUI intrinsic tags to the DOM components so real
// components (which use lowercase <box>/<text>/<b>/… via @opentui/react's jsx)
// render to DOM. Unknown tags fall through to React.

import type { Key } from "react";
import { Fragment, jsx as reactJsx, jsxs as reactJsxs } from "react/jsx-runtime";
import { B, Box, Markdown, Span, Text, U } from "./elements.js";
import { ScrollBox } from "./scrollbox.js";
import { Textarea } from "./textarea.js";

const registry: Record<string, unknown> = {
  box: Box,
  text: Text,
  span: Span,
  b: B,
  u: U,
  scrollbox: ScrollBox,
  markdown: Markdown,
  textarea: Textarea,
};

type JsxArgs = [type: unknown, props: Record<string, unknown> | null, key?: unknown];

export function jsx(...args: JsxArgs): ReturnType<typeof reactJsx> {
  const [type] = args;
  if (typeof type === "string" && registry[type]) {
    return reactJsx(registry[type] as never, args[1], args[2] as string | number | bigint | bigint | undefined);
  }
  return reactJsx(type as never, args[1], args[2] as Key | undefined);
}

export function jsxs(...args: JsxArgs): ReturnType<typeof reactJsxs> {
  const [type] = args;
  if (typeof type === "string" && registry[type]) {
    return reactJsxs(registry[type] as never, args[1], args[2] as Key | undefined);
  }
  return reactJsxs(type as never, args[1], args[2] as Key | undefined);
}

export { Fragment };

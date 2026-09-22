// index.ts — the module `@opentui/react` is aliased to in the web build, exposing
// the DOM host surface the components actually import.

export { createElement } from "react";
export {
  B,
  Box,
  b,
  box,
  Markdown,
  markdown,
  ScrollBox,
  Span,
  scrollbox,
  span,
  Text,
  Textarea,
  text,
  textarea,
  U,
  u,
} from "./elements.js";
export { flushSync, useKeyboard, useRenderer, useTerminalDimensions } from "./hooks.js";
export { toKeyEvent, WebKeyEvent } from "./keys.js";

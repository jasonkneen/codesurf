/** @jsxImportSource react */
// elements.tsx — DOM host primitives. `box`/`text`/`span`/`b`/`u`/`scrollbox`/
// `markdown` become plain DOM elements styled via props-to-style.
//
// The pragma above is load-bearing, not tidiness. Without it this file compiles
// against ./jsx-runtime like the rest of the web build — and that runtime maps
// the tag `span` to this file's own Text. Text would then render <span>, which
// resolves back to Text, for ever: React's work loop builds fibers without
// recursing, so there is no stack overflow and no error. The tab simply hangs
// with a blank page and a silent console, which is exactly how it presented.
// Host DOM tags here must use React's runtime; only the component tree under
// src/ui goes through the mapping one.
import type { CSSProperties, ReactNode } from "react";
import { WebMarkdown } from "../markdown/web-markdown.js";
import { propsToStyle, whiteSpaceFor } from "./props-to-style.js";

type AnyProps = { children?: ReactNode } & Record<string, unknown>;

export function Box({ children, ...props }: AnyProps) {
  return <div style={propsToStyle(props as never)}>{children}</div>;
}
export const box = Box;

/**
 * `<text>` — a layout participant, not an inline run.
 *
 * In OpenTUI a text node is a renderable with its own box: it takes margins,
 * padding and a width, and it stacks with its siblings. `<span>` is the inline
 * thing that lives inside one. The first cut of this shim rendered both as a
 * bare styled <span>, which dropped every layout prop a `<text>` carried — the
 * reason panel rows sat at the wrong column in the first parity capture.
 */
export function Text({ children, ...props }: AnyProps) {
  const style = propsToStyle(props as never);
  // Its CONTENT is inline even though the element is a block: a <text> holds
  // spans that must flow on one line, so it cannot be a flex container itself.
  style.display = "block";
  style.whiteSpace = whiteSpaceFor(props.wrapMode as string | undefined);
  return <div style={style}>{children}</div>;
}
export const text = Text;

/** Inline runs: colour and weight only — they never affect layout. */
function inlineStyle(props: AnyProps, extra?: CSSProperties): CSSProperties {
  const s: CSSProperties = {};
  if (typeof props.fg === "string") s.color = props.fg;
  const background = props.bg ?? props.backgroundColor;
  if (typeof background === "string") s.backgroundColor = background;
  return { ...s, ...extra };
}

export function Span({ children, ...props }: AnyProps) {
  return <span style={inlineStyle(props)}>{children}</span>;
}
export const span = Span;

export function B({ children, ...props }: AnyProps) {
  return <strong style={inlineStyle(props, { fontWeight: 700 })}>{children}</strong>;
}
export const b = B;

export function U({ children, ...props }: AnyProps) {
  return <span style={inlineStyle(props, { textDecoration: "underline" })}>{children}</span>;
}
export const u = U;

// scrollbox lives in its own module: it is the one element with an imperative
// ref API (scrollTo / scrollTop / viewport, all in CELLS not pixels).
export { ScrollBox, scrollbox } from "./scrollbox.js";

// textarea likewise: the composer ref (plainText / setText / insertText /
// cursorOffset) is a facade over a real DOM <textarea>. See textarea.tsx.
export { Textarea, textarea } from "./textarea.js";

/**
 * `<markdown>` — a real renderer, not a stub.
 *
 * The P0 shim rendered content into a <pre>, which showed the raw source: every
 * `**marker**` and `|table|` visible, no theming. ../markdown parses to the same
 * line model the terminal lays out and paints it with the theme's own syntax
 * style. See docs/architecture/phase5-web-front.md §6.1.
 */
export function Markdown({ content, syntaxStyle, width, children }: AnyProps) {
  // Content arrives as a prop from src/ui/markdown.tsx; children is the shape a
  // hand-written `<markdown>text</markdown>` would take.
  const source = typeof content === "string" ? content : typeof children === "string" ? children : "";
  return <WebMarkdown content={source} syntaxStyle={syntaxStyle as never} width={width as number | undefined} />;
}
export const markdown = Markdown;

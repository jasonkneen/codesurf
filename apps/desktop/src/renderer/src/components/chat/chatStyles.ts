/** Chat tile CSS styles — extracted from ChatTile.tsx for maintainability. */
export const CHAT_TILE_STYLES = `
    /* Hide scrollbar on the messages pane (scroll still works) */
    .chat-messages::-webkit-scrollbar { display: none; }
    /* Chat markdown styles (Streamdown overrides) */
    .chat-md { line-height: 1.55; color: inherit; max-width: 100%; overflow: hidden; }
    .chat-md, .chat-md * { min-width: 0; }
    .chat-md > * { max-width: 100%; }
    .chat-md > *:first-child { margin-top: 0 !important; }
    .chat-md > *:last-child { margin-bottom: 0 !important; }
    .chat-md pre { max-width: 100%; overflow-x: auto; overflow-y: hidden; }
    .chat-md p, .chat-md .chat-md-p { margin: 0 0 8px; }
    .chat-md p:last-child, .chat-md .chat-md-p:last-child { margin-bottom: 0; }
    .chat-md h1 { font-size: 1.3em; font-weight: 700; margin: 12px 0 6px; color: inherit; }
    .chat-md h2 { font-size: 1.15em; font-weight: 600; margin: 10px 0 4px; color: inherit; }
    .chat-md h3 { font-size: 1.05em; font-weight: 600; margin: 8px 0 4px; color: inherit; }
    .chat-md strong { font-weight: 600; }
    .chat-md em { font-style: italic; }
    .chat-md code:not(pre code) {
      background: color-mix(in srgb, var(--color-muted-foreground) 18%, transparent); padding: 1px 5px; border-radius: 6px;
      font-family: "JetBrains Mono", "Fira Code", monospace; font-size: 0.88em;
      overflow-wrap: anywhere; word-break: break-word; white-space: normal;
      -webkit-box-decoration-break: clone; box-decoration-break: clone;
    }
    .chat-md pre { margin: 8px 0; border-radius: 12px; overflow: hidden; }
    .chat-md pre:first-child { margin-top: 0; }
    .chat-md pre:last-child { margin-bottom: 0; }
    .chat-md [data-streamdown="code-block"] { max-width: 100%; }
    .chat-md [data-streamdown="code-block-body"] { max-width: 100%; overflow-x: auto; overflow-y: hidden; }
    .chat-md code { max-width: 100%; }
    .chat-md ul, .chat-md ol { padding-left: 18px; margin: 6px 0; }
    .chat-md ul:first-child, .chat-md ol:first-child { margin-top: 0; }
    .chat-md ul:last-child, .chat-md ol:last-child { margin-bottom: 0; }
    .chat-md li { line-height: 1.55; margin-bottom: 2px; }
    .chat-md li > p, .chat-md li > .chat-md-p { margin: 0; }
    .chat-md a,
    .chat-md a:any-link,
    .chat-md a:visited { color: var(--chat-link-color, var(--cs-th-accent-base)) !important; opacity: 1; text-decoration: underline; text-underline-offset: 2px; }
    .chat-md a:hover,
    .chat-md a:focus-visible { color: var(--chat-link-hover-color, var(--cs-th-accent-base)) !important; opacity: 1; }
    .chat-md blockquote {
      border-left: 3px solid color-mix(in srgb, var(--color-muted-foreground) 45%, transparent); padding-left: 10px;
      margin: 6px 0; opacity: 0.85;
    }
    .chat-md hr { border: none; border-top: 1px solid color-mix(in srgb, var(--color-muted-foreground) 32%, transparent); margin: 10px 0; }
    .chat-md table {
      display: table; max-width: 100%; overflow: hidden; border-collapse: separate; border-spacing: 0;
      margin: 8px 0; width: 100%; font-size: 0.9em; table-layout: fixed;
      border: 0; border-radius: 0; box-shadow: none;
    }
    .chat-md th, .chat-md td {
      border: 0; padding: 8px 12px; text-align: left; vertical-align: top;
      overflow-wrap: anywhere; word-break: normal;
    }
    .chat-md th {
      font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
      color: var(--color-muted-foreground); background: color-mix(in srgb, var(--color-muted) 62%, transparent);
      border-bottom: 1px solid color-mix(in srgb, var(--color-muted-foreground) 22%, transparent);
    }
    .chat-md tbody tr + tr td { border-top: 1px solid color-mix(in srgb, var(--color-muted-foreground) 14%, transparent); }
    .chat-md th:first-child, .chat-md td:first-child { width: 22%; min-width: 120px; overflow-wrap: normal; }
`

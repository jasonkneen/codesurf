// Native Cordis plugin: Nerd Font icons.
//
// Opt-in (disabled by default). When enabled it binds the host's icon resolver
// so UI surfaces prefix labels with Nerd Font glyphs from the Private Use Area.
//
// **Terminal requirement:** the terminal must render a patched Nerd Font
// (JetBrainsMono, FiraCode, Hack, Meslo...). Stock fonts show empty boxes,
// which is why this is opt-in — the font cannot be detected from inside the
// terminal.
//
// The resolver is process-wide global state, so the effect that sets it is also
// what clears it: unmounting the plugin restores the previous rendering exactly.

import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";

const SETTING_KEY = "nerdIcons.enabled";

// Catalog keyed by lowercased semantic name. Glyphs are escaped (`\uXXXX`)
// so the source survives any encoding round-trip. Codepoints chosen from the
// FontAwesome v4 range (Nerd Fonts v1+) so older Nerd Font installs render
// them too.
const CATALOG: Record<string, string> = {
  // Shell / process
  bash: "\uf120", // terminal
  process_logs: "\uf15c", // file-text
  process_list: "\uf03a", // list
  process_stop: "\uf04d", // stop

  // File I/O
  read_file: "\uf15b", // file
  write_file: "\uf044", // pencil-square-o
  edit_file: "\uf044",

  // Search / navigation
  grep: "\uf002", // search
  lsp: "\uf02d", // book

  // Subagents / delegations
  task: "\uf135", // rocket
  delegate: "\uf135",
  delegation_read: "\uf135",
  delegation_list: "\uf135",

  // Schedules
  schedule_create: "\uf073", // calendar
  schedule_list: "\uf073",
  schedule_remove: "\uf073",
  schedule_read_log: "\uf073",
  schedule_daemon_status: "\uf013", // cog
  schedule_daemon_start: "\uf04b", // play
  schedule_daemon_stop: "\uf04d", // stop

  // Wallet / payments
  wallet_info: "\uf155", // dollar
  wallet_history: "\uf1da", // history
  fetch_payment_info: "\uf0d6", // money
  paid_request: "\uf0d6",

  // Media / search
  search_web: "\uf0ac", // globe
  search_x: "\uf099", // twitter
  generate_image: "\uf03e", // picture-o
  generate_video: "\uf03d", // film

  // Telegram
  telegram_send_file: "\uf1d8", // paper-plane

  // Statuses
  tool: "\uf0ad", // wrench
  tools: "\uf0ad",
  check: "\uf00c", // check
  error: "\uf00d", // times
  running: "\uf110", // spinner

  // Modes (mode label)
  agent: "\uf188", // bug-as-robot (FA v4 fallback; nf-fa-bug is universally shipped)
  plan: "\uf0ca", // list-ul
  todo: "\uf0ae", // tasks (todo-list affordance in the composer)
  ask: "\uf059", // question-circle

  // Footer / status chrome
  permission: "\uf023", // lock
  sandbox: "\uf21b", // shield (FA v4 — universal on Nerd Fonts)
  shell: "\uf120", // terminal (same as bash, intentional)
  cwd: "\uf07b", // folder
  model: "\uf2db", // microchip
  context_meter: "\uf080", // bar-chart
  progress_full: "\uf0c8", // square
  progress_empty: "\uf096", // square-o
  voice: "\uf130", // microphone
  queue: "\uf01c", // inbox
  stop: "\uf04d", // stop (interrupt bar action)

  // Brand / title bar
  codesurf: "\uf0e7", // bolt (claude-code title bar)

  // Modals / chrome
  palette: "\uf0c9", // bars (command palette / list of actions)
  extensions: "\uf12e", // puzzle-piece
  models: "\uf2db", // microchip (model picker title — same as model)
  session: "\uf1ea", // newspaper (session title)
  close: "\uf00d", // times
  search: "\uf002", // search (search inputs)
  hint: "\uf0eb", // lightbulb (hint text)

  // Disclosure chevrons (tool chip expand/collapse affordance)
  chevron_right: "\uf054", // chevron-right
  chevron_down: "\uf078", // chevron-down
};

const manifest: PluginManifest = {
  id: "builtin.icons.nerd-fonts",
  name: "Nerd Font icons",
  version: "0.1.0",
  description:
    "Render Nerd Font glyphs in the title bar, tool chips, and mode label. Requires the terminal font to be a patched Nerd Font (JetBrainsMono / FiraCode / Hack / Meslo / etc.). Off by default.",
  enabledByDefault: false,
  capabilities: ["commands", "settings"],
};

export const nerdIconsPlugin: CodesurfPlugin = {
  name: "codesurf-nerd-icons",
  manifest,
  inject: ["contributions", "settings", "icons"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: SETTING_KEY,
        title: "Nerd Font icons — enabled",
        description:
          "Render Nerd Font glyphs in the title bar, tool chips, and mode label. Requires the terminal font to be a patched Nerd Font.",
        type: "boolean",
        default: false,
      }),
    );

    // One effect owns the resolver and the subscription that keeps it in step
    // with the setting. Its disposer clears the resolver, so unmounting cannot
    // leave glyphs behind.
    ctx.effect(() => {
      const applyResolver = () => {
        const on = ctx.settings.get<boolean>(SETTING_KEY, false) ?? false;
        ctx.icons.setResolver(on ? (name: string) => CATALOG[name.toLowerCase()] ?? null : null);
      };
      applyResolver();
      const unsubscribe = ctx.settings.subscribe(SETTING_KEY, applyResolver);
      return () => {
        unsubscribe();
        ctx.icons.setResolver(null);
      };
    });

    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/nerd-icons",
        description: "Toggle Nerd Font icons on the title bar, tool chips, and mode label.",
        handler: () => {
          const on = ctx.settings.get<boolean>(SETTING_KEY, false) ?? false;
          const next = !on;
          ctx.settings.set(SETTING_KEY, next);
          ctx.toast.show({
            style: "info",
            title: next ? "Nerd Font icons on. Terminal must use a patched Nerd Font." : "Nerd Font icons off.",
          });
        },
      }),
    );
  },
};

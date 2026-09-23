#!/usr/bin/env bun
import { createRequire } from "node:module";
import { InvalidArgumentError, program } from "commander";
import * as dotenv from "dotenv";
import readline from "readline";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

import { Agent } from "./agent/agent";
import { completeDelegation, failDelegation, loadDelegation } from "./agent/delegations";
import { bootstrapPlugins } from "./core/plugins";
import { loadBuiltinPlugins } from "./core/plugins/builtin";
import {
  CODESURF_HOME,
  daemonBinaryAvailable,
  daemonClient,
  ensureDaemonRunning,
  getDaemonStatus,
  restartDaemon,
  stopDaemon,
  warmStartDaemon,
} from "./daemon/codesurf-daemon";
import type { NodeCommandOptions } from "./gateway/node-command";
import type { ServeOptions } from "./gateway/serve-command";
import { MODELS, normalizeModelId } from "./grok/models";
import {
  createHeadlessJsonlEmitter,
  type HeadlessOutputFormat,
  isHeadlessOutputFormat,
  renderHeadlessChunk,
  renderHeadlessPrelude,
} from "./headless/output";
import type { StartupTarget } from "./server/startup";
import { startScheduleDaemon } from "./tools/schedule";
import type { StreamChunk } from "./types/index";
import type { RuntimeMode } from "./ui/app-helpers";
import { loadBuiltinUiPlugins } from "./ui/screens";
import { processAtMentionsAsync } from "./utils/at-mentions.js";
import { runScriptManagedUninstall } from "./utils/install-manager";
import { installProcessGuards, setInteractiveUiActive } from "./utils/process-guards";
import {
  getApiKey,
  getBaseURL,
  getCurrentSandboxMode,
  getCurrentSandboxSettings,
  loadPaymentSettings,
  mergeSandboxSettings,
  rememberKnownServer,
  type SandboxMode,
  type SandboxSettings,
  savePaymentSettings,
  saveUserSettings,
} from "./utils/settings";
import { runUpdate } from "./utils/update-checker";
import {
  getWorkspaceTrustDecision,
  isShuruSandboxSupported,
  resolveWorkspaceTrustPromptAnswer,
  saveWorkspaceTrustDecision,
} from "./utils/workspace-trust";
import { buildVerifyPrompt, getVerifyCliError } from "./verify/entrypoint";

dotenv.config();

const exitCleanlyOnSigterm = () => {
  process.exit(0);
};

process.on("SIGTERM", exitCleanlyOnSigterm);

installProcessGuards();

async function startInteractive(
  apiKey: string | undefined,
  baseURL: string,
  model: string | undefined,
  maxToolRounds: number,
  batchApi: boolean,
  sandboxMode: SandboxMode,
  sandboxSettings: SandboxSettings,
  target: StartupTarget,
  session?: string,
  initialMessage?: string,
) {
  // Kick off the codesurfd HTTP daemon in the background so it's warm by the
  // time any panel (skills, sessions, dreaming) needs it. Never blocks TUI
  // boot; failures are swallowed (daemon-backed features will surface their
  // own errors when invoked).
  void warmStartDaemon({
    onError: (err) => {
      // Stay silent on a missing binary — the user may not have the daemon
      // installed (e.g. running from source without the file: dep). For real
      // failures, log to stderr so it shows up after the TUI exits.
      if (!/binary not found|Unable to locate codesurfd/.test(err.message)) {
        process.stderr.write(`[codesurfd] warm start failed: ${err.message}\n`);
      }
    },
  });

  await bootstrapPlugins([...(await loadBuiltinPlugins()), ...(await loadBuiltinUiPlugins())]);
  const agent = new Agent(apiKey, baseURL, model, maxToolRounds, {
    session: session ?? "latest",
    sandboxMode,
    sandboxSettings,
    batchApi,
  });
  const { createCliRenderer } = await import("@opentui/core");
  const { createRoot } = await import("@opentui/react");
  const { createElement } = await import("react");
  const { App } = await import("./ui/app");

  // Node fronts (--connect and the server-mode picker) authenticate with the
  // machine-local node token.
  (await import("./relay/server-discovery")).installNodeTokenResolver();

  // Decide the runtime mode from the attach result, so a failed attach never
  // leaves the footer claiming a server.
  let remoteFront: import("./relay/session-stream").RemoteFront | undefined;
  let runtimeMode: RuntimeMode = { kind: "local" };
  if (target.kind === "server") {
    try {
      const { openRemoteFront } = await import("./server/attach");
      remoteFront = await openRemoteFront(target.url, { cwd: process.cwd(), sandboxMode });
      runtimeMode = { kind: "server", url: target.url, name: target.name };
      if (target.remember) rememberKnownServer(target.url, target.name);
      const label = target.name ? ` (${target.name})` : "";
      process.stderr.write(`codesurf session: attached to ${target.url}${label} (session ${remoteFront.sessionId})\n`);
    } catch (_err) {
      process.stderr.write(`codesurf: could not attach to ${target.url} — running serverless\n`);
      remoteFront = undefined;
    }
  } else if (target.notice) {
    process.stderr.write(`codesurf: ${target.notice}\n`);
  }
  if (!remoteFront) process.stderr.write("codesurf session: local (serverless \u2014 same engine capabilities)\n");

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 60,
    useKittyKeyboard: {
      disambiguate: true,
      alternateKeys: true,
    },
    useMouse: true,
    enableMouseMovement: true,
    // Stray background rejections (e.g. a Telegram polling conflict) must not
    // pop OpenTUI's debug console over the UI and steal keyboard focus.
    // Errors still land in the console buffer and ~/.codesurf/crash.log, and
    // are viewable if the user opens the console manually.
    openConsoleOnError: false,
  });

  const onExit = () => {
    remoteFront?.client.close();
    void agent.cleanup().finally(() => {
      renderer.destroy();
      process.exit(0);
    });
  };

  setInteractiveUiActive(true);

  createRoot(renderer).render(
    createElement(App, {
      agent,
      remoteFront,
      startupConfig: {
        apiKey,
        baseURL,
        model: agent.getModel(),
        modelAdapterId: agent.getModelAdapterId(),
        maxToolRounds,
        sandboxMode,
        sandboxSettings,
        runtimeMode,
        version: packageJson.version,
      },
      initialMessage,
      onExit,
    }),
  );
}

async function runHeadless(
  prompt: string,
  apiKey: string,
  baseURL: string,
  model: string | undefined,
  maxToolRounds: number,
  batchApi: boolean,
  sandboxMode: SandboxMode,
  sandboxSettings: SandboxSettings,
  format: HeadlessOutputFormat,
  session?: string,
) {
  await bootstrapPlugins([...(await loadBuiltinPlugins()), ...(await loadBuiltinUiPlugins())]);
  const agent = new Agent(apiKey, baseURL, model, maxToolRounds, {
    session,
    sandboxMode,
    sandboxSettings,
    batchApi,
  });
  const prelude = renderHeadlessPrelude(format, agent.getSessionId() || undefined);
  if (prelude.stdout) process.stdout.write(prelude.stdout);
  if (prelude.stderr) process.stderr.write(prelude.stderr);

  try {
    const { enhancedMessage } = await processAtMentionsAsync(prompt, process.cwd());

    if (format === "json") {
      const { observer, consumeChunk, flush } = createHeadlessJsonlEmitter(agent.getSessionId() || undefined);
      for await (const chunk of agent.processMessage(enhancedMessage, observer)) {
        const writes = consumeChunk(chunk);
        if (writes.stdout) process.stdout.write(writes.stdout);
        if (writes.stderr) process.stderr.write(writes.stderr ?? "");
      }
      const tail = flush();
      if (tail.stdout) process.stdout.write(tail.stdout);
      if (tail.stderr) process.stderr.write(tail.stderr ?? "");
      return;
    }

    for await (const chunk of agent.processMessage(enhancedMessage)) {
      const writes = renderHeadlessChunk(chunk);
      if (writes.stdout) process.stdout.write(writes.stdout);
      if (writes.stderr) process.stderr.write(writes.stderr);
    }
  } finally {
    await agent.cleanup();
  }
}

/** Mode-2 headless front: route a prompt to a codesurf node's session over WS,
 *  streaming live chunks back. The node owns the session — killing this front
 *  does not cancel the turn. */
async function runRemoteHeadless(
  url: string,
  prompt: string,
  format: HeadlessOutputFormat,
  sandboxMode: SandboxMode,
): Promise<void> {
  const { SessionStreamClient, runRemoteTurn } = await import("./relay/session-stream");
  (await import("./relay/server-discovery")).installNodeTokenResolver();
  const client = new SessionStreamClient(url);
  const textOf = (chunk: StreamChunk): string =>
    chunk?.type === "content" && typeof chunk.content === "string" ? chunk.content : "";
  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ mode: "wire", url, prompt })}\n`);
  }
  await client.connect();
  const session = await client.createSession({ cwd: process.cwd(), sandboxMode });
  if (format !== "json") process.stderr.write(`\n[codesurf: wire session ${session} on ${url}]\n`);
  try {
    await runRemoteTurn(client, session, prompt, {
      onChunk: (chunk) => {
        const t = textOf(chunk);
        if (t) process.stdout.write(t);
      },
    });
  } catch (error) {
    client.close();
    process.stderr.write(`\ncodesurf: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ event: "session_done", session })}\n`);
  } else {
    process.stdout.write("\n");
  }
  client.close();
}

function changeDirectoryOrExit(directory: string | undefined) {
  if (!directory) {
    return;
  }

  try {
    process.chdir(directory);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Cannot change to directory ${directory}: ${msg}`);
    process.exit(1);
  }
}

type CliOptions = Record<string, string | boolean | undefined>;

function stringOption(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function resolveCliSandboxMode(value: string | boolean | undefined): SandboxMode | undefined {
  if (value === true) return "shuru";
  if (value === false) return "off";
  return undefined;
}

function hasExplicitSandboxOption(options: CliOptions): boolean {
  return options.sandbox === true || options.sandbox === false;
}

async function promptWorkspaceTrust(
  cwd: string,
  sandboxSupported = isShuruSandboxSupported(),
): Promise<ReturnType<typeof resolveWorkspaceTrustPromptAnswer>> {
  const message = sandboxSupported
    ? [
        "",
        `Grok has not been run in ${cwd} before.`,
        "",
        "Sandbox mode isolates agent shell commands in a Shuru microVM so",
        "untrusted repos cannot touch your host filesystem or network by default.",
        "",
        "Run grok in sandbox mode for this directory?",
        "",
        "  [Y] Yes, always in sandbox",
        "  [n] No, run on host",
        "  [s] Yes, this session only",
        "",
        "Choice [Y/n/s]: ",
      ].join("\n")
    : [
        "",
        `Grok has not been run in ${cwd} before.`,
        "",
        "Sandbox mode is only available on macOS Apple Silicon in this version.",
        "",
        "Run grok directly on the host for this directory?",
        "",
        "  [Y] Yes, remember host mode",
        "  [s] Yes, this session only",
        "",
        "Choice [Y/s]: ",
      ].join("\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(message, resolve);
    });
    return resolveWorkspaceTrustPromptAnswer(answer, sandboxSupported);
  } finally {
    rl.close();
  }
}

async function resolveWorkspaceTrustSandboxMode(sandboxMode: SandboxMode, options: CliOptions): Promise<SandboxMode> {
  if (sandboxMode === "shuru" || hasExplicitSandboxOption(options)) return sandboxMode;
  if (process.env.CODESURF_TRUST_WORKSPACE) return sandboxMode;

  const cwd = process.cwd();
  const saved = getWorkspaceTrustDecision(cwd);
  if (saved) return saved;
  if (!process.stdin.isTTY || !process.stderr.isTTY) return sandboxMode;

  const decision = await promptWorkspaceTrust(cwd);
  if (decision.remember) saveWorkspaceTrustDecision(cwd, decision.sandboxMode);
  return decision.sandboxMode;
}

/** One question on stderr, answered on stdin (before the TUI mounts). */
async function askOnStderr(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

async function runBackgroundDelegation(jobPath: string, options: CliOptions) {
  let output = "";
  let agent: Agent | undefined;

  try {
    const delegation = await loadDelegation(jobPath);
    const apiKey = stringOption(options.apiKey) || getApiKey();
    if (!apiKey) {
      throw new Error(
        "API key required. Set CODESURF_API_KEY, use --api-key, or save it to ~/.codesurf/user-settings.json.",
      );
    }

    const baseURL = stringOption(options.baseUrl) || getBaseURL();
    const explicitModel = stringOption(options.model) || delegation.model;
    const model = explicitModel ? normalizeModelId(explicitModel) : undefined;
    const maxToolRounds =
      parseInt(stringOption(options.maxToolRounds) || String(delegation.maxToolRounds), 10) || delegation.maxToolRounds;
    const sandboxMode = resolveCliSandboxMode(options.sandbox) || delegation.sandboxMode || getCurrentSandboxMode();
    const sandboxSettings = mergeSandboxSettings(getCurrentSandboxSettings(), delegation.sandboxSettings);
    await bootstrapPlugins([...(await loadBuiltinPlugins()), ...(await loadBuiltinUiPlugins())]);
    agent = new Agent(apiKey, baseURL, model, maxToolRounds, {
      persistSession: false,
      sandboxMode,
      sandboxSettings,
      batchApi: Boolean(delegation.batchApi ?? options.batchApi === true),
    });
    const result = await agent.runTaskRequest({
      agent: delegation.agent,
      description: delegation.description,
      prompt: delegation.prompt,
    });

    output = (result.output || "").trim();

    if (!result.success) {
      await failDelegation(jobPath, result.output || result.error || "Background delegation failed.", output);
      return;
    }

    await completeDelegation(jobPath, output, result.task?.summary);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await failDelegation(jobPath, msg, output);
    } catch {
      // Best effort — background tasks should fail silently if persistence is unavailable.
    }
    process.exit(1);
  } finally {
    await agent?.cleanup();
  }
}

function resolveConfig(options: CliOptions) {
  const apiKey = stringOption(options.apiKey) || getApiKey();
  const baseURL = stringOption(options.baseUrl) || getBaseURL();
  const explicitModel = stringOption(options.model);
  const model = explicitModel ? normalizeModelId(explicitModel) : undefined;
  const maxToolRounds = parseInt(stringOption(options.maxToolRounds) || "400", 10) || 400;
  const sandboxMode = resolveCliSandboxMode(options.sandbox) || getCurrentSandboxMode();

  const cliOverrides: SandboxSettings = {};
  if (options.allowNet === true) cliOverrides.allowNet = true;
  const allowHostValue = options.allowHost;
  if (Array.isArray(allowHostValue) && allowHostValue.length > 0) {
    cliOverrides.allowedHosts = allowHostValue as string[];
    if (!cliOverrides.allowNet) cliOverrides.allowNet = true;
  }
  const portValue = options.forwardPort;
  if (Array.isArray(portValue) && portValue.length > 0) {
    cliOverrides.ports = portValue as string[];
  }
  const sandboxSettings = mergeSandboxSettings(getCurrentSandboxSettings(), cliOverrides);

  if (typeof options.apiKey === "string") saveUserSettings({ apiKey: options.apiKey });
  if (typeof options.model === "string") saveUserSettings({ defaultModel: normalizeModelId(options.model) });

  return {
    apiKey,
    baseURL,
    model,
    maxToolRounds,
    sandboxMode,
    sandboxSettings,
  };
}

function requireApiKey(apiKey: string | undefined): string {
  if (!apiKey) {
    console.error(
      "Error: API key required. Set CODESURF_API_KEY env var, use --api-key, or save to ~/.codesurf/user-settings.json",
    );
    process.exit(1);
  }

  return apiKey;
}

function parseHeadlessOutputFormat(value: string): HeadlessOutputFormat {
  if (isHeadlessOutputFormat(value)) {
    return value;
  }

  throw new InvalidArgumentError(`Invalid headless format "${value}". Expected "text" or "json".`);
}

program
  .name("codesurf")
  .description("Codesurf — AI coding agent built with Bun and OpenTUI")
  .version(packageJson.version)
  .argument("[message...]", "Initial message to send")
  .option("-k, --api-key <key>", "Grok API key")
  .option("-u, --base-url <url>", "API base URL")
  .option("-m, --model <model>", "Model to use")
  .option("-d, --directory <dir>", "Working directory", process.cwd())
  .option("-p, --prompt <prompt>", "Run a single prompt headlessly")
  .option("--verify", "Run the built-in verify flow headlessly")
  .option("--format <format>", "Headless output format: text or json", parseHeadlessOutputFormat, "text")
  .option("--sandbox", "Run agent shell commands inside a Shuru sandbox")
  .option("--no-sandbox", "Run agent shell commands directly on the host")
  .option("--allow-net", "Enable network access inside the Shuru sandbox")
  .option("--allow-host <pattern>", "Restrict sandbox network to specific hosts (repeatable)", collect, [])
  .option("--forward-port <mapping>", "Forward a host port to sandbox guest (HOST:GUEST, repeatable)", collect, [])
  .option("-s, --session <id>", "Continue a saved session by id, or use 'latest' (interactive default)")
  .option("--background-task-file <path>", "Run a persisted background delegation")
  .option("--max-tool-rounds <n>", "Max tool execution rounds", "400")
  .option(
    "--connect <url>",
    "Attach this session to a codesurf node (ws://host:port, see `codesurf node`) instead of running locally",
  )
  .option("--serverless", "Run the agent in this process for this launch (skip the background server)")
  .option("--batch-api", "Use xAI Batch API for model calls (async, lower cost)")
  .option("--update", "Update codesurf to the latest version and exit")
  .action(async (message: string[], options) => {
    if (options.update) {
      console.log("Checking for updates...");
      const result = await runUpdate(packageJson.version);
      console.log(result.output);
      process.exit(result.success ? 0 : 1);
    }

    changeDirectoryOrExit(options.directory);

    if (options.backgroundTaskFile) {
      await runBackgroundDelegation(options.backgroundTaskFile, options);
      return;
    }

    const config = resolveConfig(options);

    if (options.verify) {
      const verifyError = getVerifyCliError({
        hasPrompt: Boolean(options.prompt),
        hasMessageArgs: message.length > 0,
      });
      if (verifyError) {
        console.error(verifyError);
        process.exit(1);
      }

      await runHeadless(
        buildVerifyPrompt(process.cwd()),
        requireApiKey(config.apiKey),
        config.baseURL,
        config.model,
        config.maxToolRounds,
        options.batchApi === true,
        config.sandboxMode,
        config.sandboxSettings,
        options.format,
        options.session,
      );
      return;
    }

    if (options.prompt) {
      if (options.connect) {
        await runRemoteHeadless(options.connect, options.prompt, options.format, config.sandboxMode);
        return;
      }
      await runHeadless(
        options.prompt,
        requireApiKey(config.apiKey),
        config.baseURL,
        config.model,
        config.maxToolRounds,
        options.batchApi === true,
        config.sandboxMode,
        config.sandboxSettings,
        options.format,
        options.session,
      );
      return;
    }

    const initialMessage = message.length > 0 ? message.join(" ") : undefined;
    config.sandboxMode = await resolveWorkspaceTrustSandboxMode(config.sandboxMode, options);
    const { resolveStartupServer } = await import("./server/startup");
    const target = await resolveStartupServer({
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      connect: options.connect,
      serverless: options.serverless === true,
      cliVersion: packageJson.version,
      ask: askOnStderr,
    });
    await startInteractive(
      config.apiKey,
      config.baseURL,
      config.model,
      config.maxToolRounds,
      options.batchApi === true,
      config.sandboxMode,
      config.sandboxSettings,
      target,
      options.session,
      initialMessage,
    );
  });

program
  .command("telegram-bridge")
  .description("Start the Telegram remote-control bridge without opening the TUI")
  .option("-k, --api-key <key>", "Grok API key")
  .option("-u, --base-url <url>", "API base URL")
  .option("-m, --model <model>", "Model to use")
  .option("-d, --directory <dir>", "Working directory", process.cwd())
  .option("--sandbox", "Run agent shell commands inside a Shuru sandbox")
  .option("--no-sandbox", "Run agent shell commands directly on the host")
  .option("--max-tool-rounds <n>", "Max tool execution rounds", "400")
  .option("--log-file <path>", "Bridge log file", "telegram-remote-bridge.log")
  .option("--pair-code-file <path>", "Pairing code file", "telegram-pair-code.txt")
  .action(async (options) => {
    const { runTelegramHeadlessBridge } = await import("./telegram/headless-bridge");
    changeDirectoryOrExit(options.directory);
    const config = resolveConfig(options);

    process.off("SIGTERM", exitCleanlyOnSigterm);
    let fatal = false;
    try {
      await runTelegramHeadlessBridge({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        model: config.model,
        maxToolRounds: config.maxToolRounds,
        sandboxMode: config.sandboxMode,
        sandboxSettings: config.sandboxSettings,
        logFile: options.logFile,
        pairCodeFile: options.pairCodeFile,
      });
    } catch (error) {
      // Polling died (409 conflict or a fatal poller error): exit non-zero so a
      // supervisor restarts the bridge instead of leaving a zombie process.
      fatal = true;
      console.error(`telegram-bridge: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      process.on("SIGTERM", exitCleanlyOnSigterm);
    }
    if (fatal) process.exit(1);
  });

program
  .command("models")
  .description("List available Grok models")
  .action(() => {
    console.log("\nAvailable Grok Models:\n");
    for (const m of MODELS) {
      const tags = [
        m.reasoning ? "reasoning" : "non-reasoning",
        m.multiAgent ? "multi-agent" : null,
        m.responsesOnly ? "responses-only" : null,
      ].filter(Boolean);
      const suffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
      console.log(`  \x1b[36m${m.id}\x1b[0m — ${m.name}${suffix}`);
      console.log(
        `    ${m.description} | ${formatContext(m.contextWindow)} context | $${m.inputPrice}/$${m.outputPrice} per 1M tokens`,
      );
      if ((m.aliases?.length ?? 0) > 0) {
        console.log(`    aliases: ${(m.aliases ?? []).join(", ")}`);
      }
    }
    console.log();
  });

program
  .command("update")
  .description("Update Codesurf to the latest release")
  .action(async () => {
    console.log("Checking for updates...");
    const result = await runUpdate(packageJson.version);
    console.log(result.output);
    process.exit(result.success ? 0 : 1);
  });

program
  .command("uninstall")
  .description("Remove a script-installed Codesurf binary and optional data")
  .option("--dry-run", "Show what would be removed without removing it")
  .option("--force", "Skip the confirmation prompt")
  .option("--keep-config", "Keep ~/.codesurf (or legacy ~/.grok) config files")
  .option("--keep-data", "Keep ~/.codesurf (or legacy ~/.grok) data files")
  .action(async (options) => {
    const result = await runScriptManagedUninstall({
      dryRun: options.dryRun === true,
      force: options.force === true,
      keepConfig: options.keepConfig === true,
      keepData: options.keepData === true,
    });
    console.log(result.output);
    process.exit(result.success ? 0 : 1);
  });

const walletCommand = program.command("wallet").description("Manage the local x402 wallet and payment settings");

walletCommand
  .command("init")
  .description("Generate a new wallet keypair and enable payments for the selected chain")
  .option("--chain <chain>", "Wallet chain: base or base-sepolia", "base-sepolia")
  .action(async (options) => {
    const { WalletManager } = await import("./wallet/manager");
    const selectedChain = options.chain === "base" ? "base" : "base-sepolia";
    const wallet = new WalletManager();
    const data = wallet.init(selectedChain);
    const current = loadPaymentSettings();
    savePaymentSettings({
      enabled: true,
      chain: data.chain,
      approval: current.approval,
    });

    console.log("\nWallet initialized.");
    console.log(`  Address: ${data.address}`);
    console.log(`  Chain:   ${data.chain}`);
    console.log(`  Created: ${data.createdAt}`);
    console.log("\nPayments have been enabled in ~/.codesurf/user-settings.json.");
  });

walletCommand
  .command("balance")
  .description("Show the current wallet balance")
  .action(async () => {
    const { WalletManager } = await import("./wallet/manager");
    const wallet = new WalletManager();
    const balance = await wallet.getBalance();
    console.log(`\nAddress: ${balance.address}`);
    console.log(`Chain:   ${balance.chain}`);
    console.log(`${balance.nativeSymbol}:     ${balance.nativeBalance}`);
    console.log(`USDC:    ${balance.usdcBalance}\n`);
  });

walletCommand
  .command("history")
  .description("Show recent x402 payment attempts")
  .option("--limit <n>", "Number of records to show", "20")
  .action(async (options) => {
    const { PaymentHistory } = await import("./payments/history");
    const limit = Number.parseInt(options.limit, 10) || 20;
    const history = new PaymentHistory().list(limit);

    if (history.length === 0) {
      console.log("\nNo payment history yet.\n");
      return;
    }

    console.log();
    for (const row of history) {
      console.log(`${row.createdAt}  ${row.status}`);
      console.log(`  ${row.method} ${row.url}`);
      console.log(`  ${row.amount} ${row.asset} on ${row.network}`);
      if (row.txHash) console.log(`  tx: ${row.txHash}`);
      console.log();
    }
  });

program
  .command("schedule-daemon")
  .alias("scheduler")
  .description("Start the codesurf schedule daemon to run cron-style scheduled tasks")
  .option("--background", "Detach and run in the background")
  .action(async (options) => {
    if (options.background) {
      const result = await startScheduleDaemon(process.cwd());
      console.log(
        result.alreadyRunning
          ? `Schedule daemon already running (pid: ${result.status.pid ?? "unknown"}).`
          : `Schedule daemon started in the background (pid: ${result.pid ?? "unknown"}).`,
      );
      return;
    }

    process.off("SIGTERM", exitCleanlyOnSigterm);
    const { SchedulerDaemon } = await import("./daemon/scheduler");
    const daemon = new SchedulerDaemon();
    await daemon.start();
  });

const daemonCmd = program
  .command("daemon")
  .description("Manage the codesurfd HTTP daemon (the shared backend used by both the desktop app and this TUI)");

daemonCmd
  .command("start")
  .description("Ensure the codesurfd HTTP daemon is running and report its status")
  .action(async () => {
    if (!daemonBinaryAvailable()) {
      console.error(
        "codesurfd binary not found. Install @codesurf/daemon (already a dependency of this package), or run from a checkout where the daemon source is available.",
      );
      process.exitCode = 1;
      return;
    }
    try {
      const info = await ensureDaemonRunning();
      console.log(`codesurfd running on http://127.0.0.1:${info.port} (pid ${info.pid}, started ${info.startedAt}).`);
    } catch (err) {
      console.error(`Failed to start codesurfd: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

daemonCmd
  .command("status")
  .description("Show whether codesurfd is currently running")
  .option("--json", "Emit machine-readable JSON")
  .action(async (options) => {
    const status = await getDaemonStatus();
    if (options.json) {
      console.log(JSON.stringify(status));
      return;
    }
    if (!status.running || !status.info) {
      console.log("codesurfd: not running");
      process.exitCode = 1;
      return;
    }
    const { pid, port, startedAt, appVersion, protocolVersion } = status.info;
    console.log(
      `codesurfd: running (pid ${pid}) on http://127.0.0.1:${port} since ${startedAt}; app=${appVersion ?? "unknown"} protocol=v${protocolVersion}`,
    );
  });

daemonCmd
  .command("stop")
  .description("Stop the codesurfd HTTP daemon. Affects the desktop app too if it's open.")
  .action(async () => {
    try {
      await stopDaemon();
      console.log("codesurfd stopped.");
    } catch (err) {
      console.error(`Failed to stop codesurfd: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

daemonCmd
  .command("restart")
  .description("Restart the codesurfd HTTP daemon")
  .action(async () => {
    try {
      const info = await restartDaemon();
      console.log(`codesurfd restarted on http://127.0.0.1:${info.port} (pid ${info.pid}).`);
    } catch (err) {
      console.error(`Failed to restart codesurfd: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

daemonCmd
  .command("ping")
  .description("Round-trip a /health request and report latency")
  .action(async () => {
    const start = Date.now();
    try {
      // request<unknown> hits /health via the same auth path as any client call
      await daemonClient.request("/health");
      console.log(`codesurfd /health OK in ${Date.now() - start}ms`);
    } catch (err) {
      console.error(`codesurfd /health FAILED: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

daemonCmd
  .command("repair-sessions")
  .description("Merge daemon jobs that were split into multiple upstream sessions for the same card/title")
  .option("--dry-run", "Show what would be patched without writing changes")
  .option("--home <dir>", "Codesurf home directory", CODESURF_HOME)
  .option("--workspace <dir>", "Only repair jobs for this workspace directory")
  .option("--card-id <id>", "Only repair jobs for this daemon card id")
  .action(async (options) => {
    const { repairSplitDaemonSessions } = await import("./daemon/session-repair");
    const result = repairSplitDaemonSessions({
      homeDir: String(options.home || CODESURF_HOME),
      dryRun: options.dryRun === true,
      workspaceDir: typeof options.workspace === "string" ? options.workspace : undefined,
      cardId: typeof options.cardId === "string" ? options.cardId : undefined,
    });

    const verb = result.dryRun ? "Would repair" : result.failures.length > 0 ? "Attempted repair of" : "Repaired";
    console.log(
      `${verb} ${result.groups.length} split session group(s); ${result.jobsPatched} job file(s), ${result.timelinesPatched} timeline file(s).`,
    );
    for (const group of result.groups) {
      console.log(
        `  ${group.cardId}  ${group.jobIds.length} jobs  ${group.sessionIds.length} sessions -> ${group.canonicalSessionId}`,
      );
      console.log(`    ${group.taskLabel}`);
    }
    if (result.failures.length > 0) {
      console.error(`Failed to patch ${result.failures.length} daemon metadata file(s):`);
      for (const failure of result.failures.slice(0, 10)) {
        console.error(`  ${failure.jobId} ${failure.kind}: ${failure.message}`);
      }
      if (result.failures.length > 10) {
        console.error(`  ... ${result.failures.length - 10} more`);
      }
      process.exitCode = 1;
    }
  });

// `server` = background engine nodes (`codesurf node`, detached). One named
// "default" on port 3948 unless you create more with --name.
function parsePortOption(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InvalidArgumentError(`Invalid port "${value}".`);
  return port;
}

function printServerLine(status: import("./server/lifecycle").ServerStatus, formatUptime: (ms: number) => string) {
  const { record } = status;
  console.log(
    `${record.name}  ${record.url}  pid ${record.pid}  up ${formatUptime(status.uptimeMs)}  ${status.reachable ? "reachable" : "NOT reachable"}`,
  );
}

const serverCmd = program
  .command("server")
  .description("Manage background CodeSurf servers (engine nodes the TUI attaches to)");

serverCmd
  .command("start")
  .description("Start a background server (the default one unless --name is given) and return to the shell")
  .option("--name <name>", "Server name", "default")
  .option("--port <port>", "Port to listen on (default: first free port from 3948)", parsePortOption)
  .action(async (options: { name: string; port?: number }) => {
    const { startServer } = await import("./server/lifecycle");
    const { logPath } = await import("./server/registry");
    try {
      const { record, started } = await startServer({
        name: options.name,
        port: options.port,
        cliVersion: packageJson.version,
      });
      rememberKnownServer(record.url, record.name);
      console.log(
        started
          ? `server "${record.name}" started on ${record.url} (pid ${record.pid}); log: ${logPath(record.name)}`
          : `server "${record.name}" already running on ${record.url} (pid ${record.pid})`,
      );
    } catch (err) {
      console.error(`Failed to start server "${options.name}": ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

serverCmd
  .command("stop")
  .description("Stop a background server (graceful SIGTERM, SIGKILL after a grace period)")
  .option("--name <name>", "Server name", "default")
  .option("--all", "Stop every registered server")
  .action(async (options: { name: string; all?: boolean }) => {
    const { stopServer } = await import("./server/lifecycle");
    const { listRecords } = await import("./server/registry");
    const names = options.all ? listRecords().map((r) => r.name) : [options.name];
    if (names.length === 0) console.log("no servers running");
    for (const name of names) {
      const result = await stopServer(name);
      if (!result.record) {
        console.log(`server "${name}" is not running`);
        continue;
      }
      console.log(`server "${name}" stopped (pid ${result.record.pid}${result.forced ? ", killed" : ""})`);
    }
  });

serverCmd
  .command("restart")
  .description("Restart a background server on the same port")
  .option("--name <name>", "Server name", "default")
  .option("--port <port>", "Port to listen on instead of the current one", parsePortOption)
  .action(async (options: { name: string; port?: number }) => {
    const { startServer, stopServer } = await import("./server/lifecycle");
    const { record: previous } = await stopServer(options.name);
    try {
      const { record } = await startServer({
        name: options.name,
        port: options.port ?? previous?.port,
        cliVersion: packageJson.version,
      });
      rememberKnownServer(record.url, record.name);
      console.log(`server "${record.name}" restarted on ${record.url} (pid ${record.pid})`);
    } catch (err) {
      console.error(`Failed to restart server "${options.name}": ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

serverCmd
  .command("status")
  .description("Show one background server (the default unless --name is given)")
  .option("--name <name>", "Server name", "default")
  .option("--json", "Emit machine-readable JSON")
  .action(async (options: { name: string; json?: boolean }) => {
    const { formatUptime, serverStatus } = await import("./server/lifecycle");
    const status = await serverStatus(options.name);
    if (options.json) {
      console.log(JSON.stringify(status ? { running: true, ...status } : { running: false, name: options.name }));
    } else if (status) {
      printServerLine(status, formatUptime);
    } else {
      console.log(`server "${options.name}": not running`);
    }
    if (!status?.reachable) process.exitCode = 1;
  });

serverCmd
  .command("list")
  .alias("ls")
  .description("List background servers")
  .option("--json", "Emit machine-readable JSON")
  .action(async (options: { json?: boolean }) => {
    const { formatUptime, listServers } = await import("./server/lifecycle");
    const servers = await listServers();
    if (options.json) {
      console.log(JSON.stringify(servers));
      return;
    }
    if (servers.length === 0) {
      console.log("no servers running (start one with `codesurf server start`)");
      return;
    }
    for (const status of servers) printServerLine(status, formatUptime);
  });

// `gateway`, not `serve`: next to `server` (background engine nodes) the old
// name read as the same thing. `serve` still works, hidden from help.
for (const [name, hidden] of [
  ["gateway", false],
  ["serve", true],
] as const) {
  program
    .command(name, { hidden })
    .description("Run the codesurf agent gateway (sessions/tool plane over HTTP/SSE)")
    .option("--port <port>", "Port to listen on", "3947")
    .option("--host <host>", "Bind address", "127.0.0.1")
    .option("--presentation <mode>", "Default tool presentation: native, code or both", "native")
    .option("-m, --model <model>", "Model to use")
    .option("-k, --api-key <key>", "API key")
    .option("-u, --base-url <url>", "API base URL")
    .option("--max-tool-rounds <n>", "Max tool execution rounds", "400")
    .action(async (options: ServeOptions) => {
      const { runServeCommand } = await import("./gateway/serve-command");
      // The gateway installs its own SIGTERM handler that drains agents and
      // closes the server; the global exit(0) would preempt it.
      process.off("SIGTERM", exitCleanlyOnSigterm);
      await runServeCommand(options);
    });
}

program
  .command("mcp")
  .description("Expose the codesurf gateway as an MCP server (stdio)")
  .option("--gateway-url <url>", "Gateway base URL (default: $CODESURF_GATEWAY_URL or http://127.0.0.1:3947)")
  .action(async (options: { gatewayUrl?: string }) => {
    const { runMcpCommand } = await import("./gateway/mcp-server");
    await runMcpCommand(options);
  });

program
  .command("node")
  .description("Run a codesurf engine node — owns sessions over WS, bound to the real Agent")
  .option("--port <port>", "Port to listen on", "3948")
  .option("--host <host>", "Bind address", "127.0.0.1")
  .option("-m, --model <model>", "Model to use")
  .option("-k, --api-key <key>", "API key")
  .option("-u, --base-url <url>", "API base URL")
  .option("--max-tool-rounds <n>", "Max tool execution rounds", "400")
  .option(
    "--allow-origin <origin>",
    "Browser origin allowed to connect, e.g. the live web front (repeatable)",
    collect,
    [],
  )
  .option("--auto-approve", "Approve every tool call when no front is attached to decide (default: deny)")
  .action(async (options: NodeCommandOptions) => {
    const { runNodeCommand } = await import("./gateway/node-command");
    // node installs its own SIGTERM handler (agent cleanup + server close).
    process.off("SIGTERM", exitCleanlyOnSigterm);
    await runNodeCommand(options);
  });

program.parse();

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`;
  return `${tokens / 1_000}K`;
}

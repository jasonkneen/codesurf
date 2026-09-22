import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createOpenPetsClient, type OpenPetsClient, type OpenPetsReaction } from "@open-pets/client";
import { Plugin } from "@opencode-ai/plugin/v2";

const CODEX_PETS_DIR = join(homedir(), ".codex", "pets");
const PLUGIN_DATA_DIR = join(homedir(), ".config", "opencode", "pet-plugin");
const SELECTED_PET_FILE = join(PLUGIN_DATA_DIR, "selected.json");

const ALLOWED_REACTIONS = [
  "idle",
  "thinking",
  "working",
  "editing",
  "running",
  "testing",
  "waiting",
  "waving",
  "success",
  "error",
  "celebrating",
] as const;

interface CodexPet {
  id: string;
  displayName: string;
  description: string;
  spritesheetPath: string;
  category?: string;
  frame?: { width: number; height: number; columns: number; rows: number };
  animations?: Record<string, { frames: number[]; fps: number; loop?: boolean; fallback?: string }>;
  source: "local";
}

interface OpenPetsPet {
  id: string;
  displayName: string;
  builtIn: boolean;
  broken: boolean;
  source: "openpets";
}

interface PetState {
  connected: boolean;
  unavailableReason: string | null;
  selectedPetId: string | null;
  currentReaction: OpenPetsReaction;
  leaseId: string | null;
  leaseExpiresAt: number | null;
  lastActivity: number;
}

function loadSelectedPet(): string | null {
  try {
    if (!existsSync(SELECTED_PET_FILE)) return null;
    const data = JSON.parse(readFileSync(SELECTED_PET_FILE, "utf8"));
    return typeof data.petId === "string" ? data.petId : null;
  } catch {
    return null;
  }
}

function saveSelectedPet(petId: string): void {
  try {
    if (!existsSync(PLUGIN_DATA_DIR)) mkdirSync(PLUGIN_DATA_DIR, { recursive: true });
    writeFileSync(SELECTED_PET_FILE, JSON.stringify({ petId, savedAt: Date.now() }, null, 2));
  } catch {}
}

function scanCodexPets(): CodexPet[] {
  if (!existsSync(CODEX_PETS_DIR)) return [];
  const pets: CodexPet[] = [];
  for (const dir of readdirSync(CODEX_PETS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const petJsonPath = join(CODEX_PETS_DIR, dir.name, "pet.json");
    if (!existsSync(petJsonPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(petJsonPath, "utf8"));
      pets.push({
        id: raw.id ?? dir.name,
        displayName: raw.displayName ?? dir.name,
        description: raw.description ?? "",
        spritesheetPath: raw.spritesheetPath ?? "spritesheet.webp",
        category: raw.category,
        frame: raw.frame,
        animations: raw.animations,
        source: "local",
      });
    } catch {}
  }
  return pets;
}

function mapToolToReaction(toolName: string): OpenPetsReaction {
  const map: Record<string, OpenPetsReaction> = {
    edit: "editing",
    write: "editing",
    patch: "editing",
    shell: "running",
    bash: "running",
    read: "thinking",
    grep: "thinking",
    glob: "thinking",
    task: "working",
    subagent: "working",
    webfetch: "thinking",
    websearch: "thinking",
    ls: "thinking",
  };
  return map[toolName] ?? "working";
}

const EVENT_REACTION_MAP: Record<string, OpenPetsReaction> = {
  "session.execution.started": "thinking",
  "session.text.started": "thinking",
  "session.reasoning.started": "thinking",
  "session.step.started": "thinking",
  "session.tool.called": "working",
  "session.tool.success": "success",
  "session.tool.failed": "error",
  "session.shell.started": "running",
  "session.execution.succeeded": "celebrating",
  "session.execution.failed": "error",
  "session.execution.interrupted": "idle",
  "session.idle": "idle",
  "session.compaction.started": "working",
  "session.compaction.ended": "idle",
  "session.step.ended": "waiting",
};

function txt(text: string) {
  return [{ type: "text" as const, text }];
}

export default Plugin.define({
  id: "opencode.pet",
  setup: async (ctx) => {
    const state: PetState = {
      connected: false,
      unavailableReason: null,
      selectedPetId: loadSelectedPet(),
      currentReaction: "idle",
      leaseId: null,
      leaseExpiresAt: null,
      lastActivity: Date.now(),
    };

    let openpetsClient: OpenPetsClient | null = null;
    try {
      openpetsClient = createOpenPetsClient();
      const status = await openpetsClient.status();
      state.connected = status.ok && status.appRunning;
      if (!state.connected) {
        state.unavailableReason = status.unavailableReason ?? "OpenPets not running";
      }
    } catch (e) {
      state.connected = false;
      state.unavailableReason = e instanceof Error ? e.message : "OpenPets unavailable";
    }

    async function sendReaction(reaction: OpenPetsReaction): Promise<void> {
      state.currentReaction = reaction;
      state.lastActivity = Date.now();
      if (!openpetsClient || !state.connected || !state.leaseId) return;
      try {
        await openpetsClient.react(reaction, { leaseId: state.leaseId });
      } catch {}
    }

    async function acquireLease(petId?: string): Promise<boolean> {
      if (!openpetsClient || !state.connected) return false;
      try {
        if (state.leaseId) {
          await openpetsClient.releaseLease(state.leaseId).catch(() => {});
          state.leaseId = null;
        }
        const lease = await openpetsClient.acquireLease({
          requestedPetId: petId ?? state.selectedPetId ?? undefined,
        });
        state.leaseId = lease.leaseId;
        state.leaseExpiresAt = lease.expiresAt;
        if (lease.actualTargetPetId) {
          state.selectedPetId = lease.actualTargetPetId;
          saveSelectedPet(lease.actualTargetPetId);
        }
        return true;
      } catch (e) {
        state.unavailableReason = e instanceof Error ? e.message : "lease failed";
        return false;
      }
    }

    if (state.connected) {
      await acquireLease();
    }

    const heartbeatTimer = setInterval(async () => {
      if (!openpetsClient || !state.connected || !state.leaseId) return;
      try {
        const hb = await openpetsClient.heartbeatLease(state.leaseId);
        state.leaseExpiresAt = hb.expiresAt;
      } catch {
        state.leaseId = null;
        await acquireLease();
      }
    }, 30_000);

    const idleTimer = setInterval(() => {
      const elapsed = Date.now() - state.lastActivity;
      if (elapsed > 8_000 && state.currentReaction !== "idle") {
        void sendReaction("idle");
      }
    }, 3_000);

    let eventStopped = false;
    try {
      const stream = await ctx.event.subscribe();
      if (stream && typeof stream[Symbol.asyncIterator] === "function") {
        (async () => {
          try {
            for await (const evt of stream) {
              if (eventStopped) break;
              const eventType = (evt as { type?: string }).type;
              if (!eventType) continue;
              const reaction = EVENT_REACTION_MAP[eventType];
              if (reaction) {
                void sendReaction(reaction);
              }
            }
          } catch {}
        })();
      }
    } catch {}

    await ctx.tool.hook("execute.before", (event) => {
      const toolName = (event as { tool?: string }).tool ?? "";
      void sendReaction(mapToolToReaction(toolName));
    });

    await ctx.tool.hook("execute.after", (event) => {
      const result = (event as { result?: unknown }).result;
      const isError = result != null && typeof result === "object" && "error" in result;
      void sendReaction(isError ? "error" : "success");
    });

    await ctx.tool.transform((tools) => {
      tools.add({
        name: "pet_list",
        description:
          "List all available pets from local Codex pet directory and OpenPets. Shows pet id, name, description, source, and which is currently selected.",
        jsonSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: async () => {
          const localPets = scanCodexPets();
          let openpetsPets: OpenPetsPet[] = [];
          if (openpetsClient && state.connected) {
            try {
              const result = await openpetsClient.listPets();
              openpetsPets = result.pets.map((p) => ({
                id: p.id,
                displayName: p.displayName,
                builtIn: p.builtIn,
                broken: p.broken,
                source: "openpets" as const,
              }));
            } catch {}
          }

          const seen = new Set<string>();
          const lines: string[] = ["=== Available Pets ===", ""];

          for (const pet of localPets) {
            seen.add(pet.id);
            const selected = pet.id === state.selectedPetId ? " ← active" : "";
            lines.push(`  [local]    ${pet.id} — ${pet.displayName}${selected}`);
            if (pet.description) lines.push(`             ${pet.description}`);
            const animCount = pet.animations ? Object.keys(pet.animations).length : 0;
            if (pet.frame) {
              lines.push(
                `             ${pet.frame.width}x${pet.frame.height} grid ${pet.frame.columns}x${pet.frame.rows}, ${animCount} animations`,
              );
            }
            lines.push("");
          }

          for (const pet of openpetsPets) {
            if (seen.has(pet.id)) {
              const selected = pet.id === state.selectedPetId ? " ← active" : "";
              if (selected) lines.push(`  [openpets] ${pet.id} — ${pet.displayName}${selected}`);
              continue;
            }
            seen.add(pet.id);
            const selected = pet.id === state.selectedPetId ? " ← active" : "";
            const status = pet.broken ? " (broken)" : pet.builtIn ? " (built-in)" : "";
            lines.push(`  [openpets] ${pet.id} — ${pet.displayName}${status}${selected}`);
            lines.push("");
          }

          if (localPets.length === 0 && openpetsPets.length === 0) {
            lines.push("  No pets found.");
          }

          lines.push("");
          lines.push(`OpenPets: ${state.connected ? "connected" : "disconnected"}`);
          if (state.unavailableReason) lines.push(`  (${state.unavailableReason})`);
          lines.push(`Current reaction: ${state.currentReaction}`);
          if (state.leaseId) lines.push(`Lease: ${state.leaseId.slice(0, 12)}…`);

          return {
            structured: {
              localPets: localPets.map((p) => ({ id: p.id, displayName: p.displayName, description: p.description })),
              openpetsPets,
              connected: state.connected,
              selectedPetId: state.selectedPetId,
              currentReaction: state.currentReaction,
            },
            content: txt(lines.join("\n")),
          };
        },
      });

      tools.add({
        name: "pet_select",
        description:
          "Select the active pet by id. If OpenPets is running, acquires a lease for the specified pet. The selection is persisted across sessions.",
        jsonSchema: {
          type: "object",
          properties: {
            petId: {
              type: "string",
              description: "The pet id to select (use pet_list to see available ids)",
            },
          },
          required: ["petId"],
          additionalProperties: false,
        },
        execute: async (rawInput: unknown) => {
          const input = rawInput as { petId: string };
          const petId = input.petId;
          const localPets = scanCodexPets();
          const localMatch = localPets.find(
            (p) => p.id === petId || p.displayName.toLowerCase() === petId.toLowerCase(),
          );
          const resolvedId = localMatch?.id ?? petId;

          state.selectedPetId = resolvedId;
          saveSelectedPet(resolvedId);

          const lines: string[] = [];
          let leased = false;

          if (state.connected && openpetsClient) {
            leased = await acquireLease(resolvedId);
            if (leased) {
              lines.push(`Selected pet: ${resolvedId}`);
              lines.push(`OpenPets lease acquired for ${resolvedId}`);
              await sendReaction("waving");
            } else {
              lines.push(`Selected pet: ${resolvedId} (saved locally)`);
              lines.push(`OpenPets lease failed — pet will activate when OpenPets is available`);
            }
          } else {
            lines.push(`Selected pet: ${resolvedId} (saved locally)`);
            if (localMatch) {
              lines.push(`Source: ~/.codex/pets/${resolvedId}`);
              const animCount = localMatch.animations ? Object.keys(localMatch.animations).length : 0;
              lines.push(`Animations: ${animCount} (${Object.keys(localMatch.animations ?? {}).join(", ")})`);
            }
            lines.push(`OpenPets not connected — pet selection will apply when OpenPets starts`);
          }

          return {
            structured: { petId: resolvedId, leased, connected: state.connected },
            content: txt(lines.join("\n")),
          };
        },
      });

      tools.add({
        name: "pet_download",
        description:
          "Download and install a pet from OpenPets by id. Requires OpenPets desktop app to be running. Use pet_list to see available pets for download.",
        jsonSchema: {
          type: "object",
          properties: {
            petId: {
              type: "string",
              description: "The pet id to download from OpenPets",
            },
          },
          required: ["petId"],
          additionalProperties: false,
        },
        execute: async (rawInput: unknown) => {
          const input = rawInput as { petId: string };
          if (!openpetsClient || !state.connected) {
            return {
              structured: { installed: false },
              content: txt("OpenPets is not running. Start the OpenPets desktop app first, then try again."),
            };
          }
          try {
            const result = await openpetsClient.installPet(input.petId);
            return {
              structured: { installed: true, petId: result.petId, displayName: result.displayName },
              content: txt(
                `Downloaded pet: ${result.displayName} (${result.petId})\nInstalled successfully via OpenPets.`,
              ),
            };
          } catch (e) {
            const msg = e instanceof Error ? e.message : "download failed";
            return {
              structured: { installed: false, error: msg },
              content: txt(`Failed to download pet: ${msg}`),
            };
          }
        },
      });

      tools.add({
        name: "pet_status",
        description:
          "Show current pet status: selected pet, current reaction, OpenPets connection, lease info, and local pet count.",
        jsonSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: async () => {
          const localPets = scanCodexPets();
          const lines: string[] = [
            "=== Pet Status ===",
            "",
            `Selected:       ${state.selectedPetId ?? "(none)"}`,
            `Reaction:       ${state.currentReaction}`,
            `OpenPets:       ${state.connected ? "connected" : "disconnected"}`,
          ];
          if (state.unavailableReason) lines.push(`  Reason:       ${state.unavailableReason}`);
          if (state.leaseId) {
            lines.push(`Lease:          ${state.leaseId.slice(0, 16)}…`);
            if (state.leaseExpiresAt) {
              const remaining = Math.max(0, state.leaseExpiresAt - Date.now());
              lines.push(`  Expires in:  ${Math.round(remaining / 1000)}s`);
            }
          }
          lines.push(`Local pets:     ${localPets.length} in ~/.codex/pets/`);
          lines.push("");
          if (state.selectedPetId) {
            const pet = localPets.find((p) => p.id === state.selectedPetId);
            if (pet) {
              lines.push(`Active pet details:`);
              lines.push(`  Name:        ${pet.displayName}`);
              lines.push(`  Description: ${pet.description}`);
              if (pet.frame)
                lines.push(
                  `  Frame:       ${pet.frame.width}x${pet.frame.height} (${pet.frame.columns}x${pet.frame.rows} grid)`,
                );
              if (pet.animations) {
                const anims = Object.entries(pet.animations).map(
                  ([name, a]) => `${name}(${a.frames.length}f@${a.fps}fps)`,
                );
                lines.push(`  Animations:  ${anims.join(", ")}`);
              }
            }
          }
          return {
            structured: {
              selectedPetId: state.selectedPetId,
              currentReaction: state.currentReaction,
              connected: state.connected,
              leaseId: state.leaseId,
              localPetCount: localPets.length,
            },
            content: txt(lines.join("\n")),
          };
        },
      });

      tools.add({
        name: "pet_react",
        description:
          "Manually trigger a pet reaction/animation. Valid reactions: idle, thinking, working, editing, running, testing, waiting, waving, success, error, celebrating.",
        jsonSchema: {
          type: "object",
          properties: {
            reaction: {
              type: "string",
              enum: ALLOWED_REACTIONS,
              description: "The reaction to trigger",
            },
          },
          required: ["reaction"],
          additionalProperties: false,
        },
        execute: async (rawInput: unknown) => {
          const input = rawInput as { reaction: OpenPetsReaction };
          await sendReaction(input.reaction);
          const text = state.connected
            ? `Pet reaction: ${input.reaction} (sent to OpenPets)`
            : `Pet reaction set to: ${input.reaction} (OpenPets not connected — will apply when connected)`;
          return {
            structured: { reaction: input.reaction, sent: state.connected },
            content: txt(text),
          };
        },
      });

      tools.add({
        name: "pet_say",
        description:
          "Make the pet say a message (displayed in the OpenPets desktop app as a speech bubble). Requires OpenPets to be running.",
        jsonSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "The message for the pet to say",
            },
            reaction: {
              type: "string",
              enum: ALLOWED_REACTIONS,
              description: "Optional reaction to accompany the message",
            },
          },
          required: ["message"],
          additionalProperties: false,
        },
        execute: async (rawInput: unknown) => {
          const input = rawInput as { message: string; reaction?: OpenPetsReaction };
          if (!openpetsClient || !state.connected) {
            return {
              structured: { said: false },
              content: txt("OpenPets is not running. Start the OpenPets desktop app to use pet_say."),
            };
          }
          try {
            await openpetsClient.say(input.message, {
              reaction: input.reaction,
              leaseId: state.leaseId ?? undefined,
            });
            return {
              structured: { said: true, message: input.message },
              content: txt(`Pet says: "${input.message}"`),
            };
          } catch (e) {
            const msg = e instanceof Error ? e.message : "say failed";
            return {
              structured: { said: false, error: msg },
              content: txt(`Failed: ${msg}`),
            };
          }
        },
      });
    });

    await ctx.command.transform((commands) => {
      commands.update("pet", (command) => {
        command.description = "Show pet status, list pets, or select a pet";
        command.template =
          "Use the pet_status tool to show the current pet status, then summarize the result concisely.";
      });
    });

    return async () => {
      eventStopped = true;
      clearInterval(heartbeatTimer);
      clearInterval(idleTimer);
      if (openpetsClient && state.connected && state.leaseId) {
        try {
          await openpetsClient.releaseLease(state.leaseId);
        } catch {}
      }
    };
  },
});

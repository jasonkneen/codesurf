// Pets builtin extension.
//
// Adds an animated ambient terminal pet (Kitty graphics) plus a `/pets`
// slash command for choosing, switching, or hiding it. Bundle format
// matches cursorbuddy / openclicky / hatch-pet (see
// builtin/pets/manifest.ts + builtin/pets/atlas.ts) — we scan the same
// $CODEX_HOME/pets directory those tools write to, plus ~/.grok/pets
// and ~/.codesurf/pets as overlay locations.
//
// On selection we slice the idle row out of the spritesheet into PNGs
// (via sharp, cached in ~/.grok/pets-cache) and hand the frame list to
// the renderer, which cycles them on the per-frame durations from the
// shared atlas. Switching pets tears down the previous one cleanly.

import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import { loadUserSettings, saveUserSettings } from "../../../utils/settings";
import type { AnimationRow } from "../builtin/pets/atlas";
import { extractRowFrames, type FrameSet } from "../builtin/pets/frames";
import { DISABLED_PET_ID, loadPetManifest, type PetManifest } from "../builtin/pets/manifest";
import { PETS_PICKER_SCREEN_ID, type PetsPickerProps, renderPetsPickerScreen } from "../builtin/pets/picker";
import { activateFrames, deactivatePet, getProtocolSupport, setRow, setRowTransient } from "../builtin/pets/renderer";

const DISABLE_ALIASES = new Set(["disable", "disabled", "off", "hide", "hidden", "none"]);

interface ResolveResult {
  ok: boolean;
  warning?: string;
  /** Display label for confirmation messages. */
  displayName?: string;
  /** True when we sliced a real spritesheet, false when we fell back to a static image. */
  animated?: boolean;
}

async function resolveAndActivate(petId: string | undefined): Promise<ResolveResult> {
  if (!petId || petId === DISABLED_PET_ID) {
    deactivatePet();
    return { ok: true };
  }

  const support = getProtocolSupport();
  if (support.protocol === "none") {
    deactivatePet();
    return { ok: false, warning: support.unsupportedReason ?? "terminal does not support Kitty graphics" };
  }

  const manifest = loadPetManifest(petId);
  if (!manifest) {
    deactivatePet();
    return { ok: false, warning: `pet "${petId}" not found in $CODEX_HOME/pets, ~/.grok/pets, or ~/.codesurf/pets` };
  }

  let frames: FrameSet;
  try {
    frames = await extractRowFrames(manifest, "idle");
  } catch (err) {
    deactivatePet();
    return {
      ok: false,
      warning: `failed to decode "${manifest.displayName}": ${(err as Error).message}`,
    };
  }

  // Row loader closure: scoped to this manifest, so a future setRow()
  // call (driven by host agent-state events, once exposed) re-uses the
  // same bundle. Returns null for non-canonical sources so the renderer
  // stays on the static fallback frames.
  const rowLoader = frames.fromSpritesheet
    ? async (row: AnimationRow) => {
        try {
          const next = await extractRowFrames(manifest, row);
          return next.fromSpritesheet ? next.frames : null;
        } catch {
          return null;
        }
      }
    : undefined;

  activateFrames(frames.frames, { row: "idle", rowLoader });
  return {
    ok: true,
    displayName: manifest.displayName,
    animated: frames.fromSpritesheet,
  };
}

function announceSuccess(petId: string, result: ResolveResult): string {
  if (petId === DISABLED_PET_ID) return "Pet hidden.";
  const name = result.displayName ?? petId;
  const suffix = result.animated ? "" : " (static, non-spritesheet image)";
  return `Pet set to "${name}".${suffix}`;
}

const manifest: PluginManifest = {
  id: "builtin.ui.pets",
  name: "Terminal Pets",
  version: "1.0.0",
  description:
    "Animated ambient terminal pet rendered via the Kitty graphics protocol. Shares pet bundles with cursorbuddy / openclicky / hatch-pet (default location: $CODEX_HOME/pets).",
  enabledByDefault: true,
  protected: false,
  capabilities: ["commands", "screens"],
};

export const petsPlugin: CodesurfPlugin = {
  name: "codesurf-pets",
  manifest,
  inject: ["contributions", "screens", "chat", "ui", "lifecycle", "hostEvents"],
  apply(ctx: PluginContext) {
    // Tear down the pet's terminal image state on process exit via the host's
    // aggregated exit handler (auto-removed on dispose) instead of a
    // per-module `process.once` listener.
    ctx.effect(() => ctx.lifecycle.onProcessExit(() => deactivatePet()));

    ctx.effect(() =>
      ctx.screens.registerScreen({
        id: PETS_PICKER_SCREEN_ID,
        label: "Pets Picker",
        // The picker renderer predates the plugin contract and takes the
        // host screen context; its shape is a superset of what we pass.
        render: (screenCtx) => renderPetsPickerScreen(screenCtx as never),
      }),
    );

    ctx.effect(async () =>
      ctx.contributions.registerCommand({
        name: "/pets",
        description: "Choose, switch, or hide the ambient terminal pet.",
        argsHint: "[disable | <pet-id>]",
        handler: async ({ args }) => {
          const trimmed = args.trim();
          const currentPetId = loadUserSettings().tuiPet;

          // Inline arg: `/pets disable` or `/pets <id>`.
          if (trimmed.length > 0) {
            const lower = trimmed.toLowerCase();
            const target = DISABLE_ALIASES.has(lower) ? DISABLED_PET_ID : trimmed;
            const result = await resolveAndActivate(target);
            if (!result.ok) {
              ctx.chat.appendAssistant(`/pets: ${result.warning ?? "could not activate"}`);
              return;
            }
            saveUserSettings({ tuiPet: target });
            ctx.chat.appendAssistant(announceSuccess(target, result));
            return;
          }

          // No inline arg: open the picker overlay.
          const support = getProtocolSupport();
          const warning = support.protocol === "none" ? support.unsupportedReason : undefined;
          const props: PetsPickerProps = {
            currentPetId,
            warning,
            onSelect: (petId) => {
              void (async () => {
                const result = await resolveAndActivate(petId);
                if (!result.ok) {
                  ctx.chat.appendAssistant(`/pets: ${result.warning ?? "could not activate"}`);
                  return;
                }
                saveUserSettings({ tuiPet: petId });
                ctx.chat.appendAssistant(announceSuccess(petId, result));
              })();
            },
          };
          ctx.ui.action({
            type: "open-screen",
            id: PETS_PICKER_SCREEN_ID,
            props,
          });
        },
      }),
    );

    // Restore the configured pet on activation. Fire-and-forget — a
    // missing-pet or decode failure shouldn't block other extensions.
    const configured = loadUserSettings().tuiPet;
    if (configured && configured !== DISABLED_PET_ID) {
      void resolveAndActivate(configured).then((result) => {
        if (!result.ok) {
          console.warn(`pets: ${result.warning ?? "could not restore configured pet"}`);
        }
      });
    }

    // Agent-event → animation row mapping.
    //
    // Persistent rows (setRow) move the pet between long-lived states:
    //   - "running"  : agent is processing a turn (user prompt submitted,
    //                  tools may be executing).
    //   - "idle"     : agent is waiting for input.
    //
    // Transient rows (setRowTransient) flash a reaction for ~2 s then
    // revert to whatever the current base row is:
    //   - "waving"   : welcome on session start, celebration on turn end.
    //   - "failed"   : turn-level error, or any tool failure during a turn.
    //
    // Each setRow is gated by renderer state, so subscriptions are safe
    // when no pet is active. Disposers run on extension shutdown so we
    // never leak listeners across hot-reload / extension cycles.
    const TRANSIENT_MS = 2_000;
    const disposers: Array<() => void> = [
      ctx.hostEvents.subscribe("SessionStart", () => {
        void setRowTransient("waving", TRANSIENT_MS);
      }),
      ctx.hostEvents.subscribe("UserPromptSubmit", () => {
        void setRow("running");
      }),
      ctx.hostEvents.subscribe("PostToolUseFailure", () => {
        void setRowTransient("failed", TRANSIENT_MS);
      }),
      ctx.hostEvents.subscribe("Stop", () => {
        // Reset base to idle first so the transient timer reverts to
        // idle (not back to "running" from the active turn).
        void setRow("idle").then(() => setRowTransient("waving", TRANSIENT_MS));
      }),
      ctx.hostEvents.subscribe("StopFailure", () => {
        void setRow("idle").then(() => setRowTransient("failed", TRANSIENT_MS));
      }),
    ];

    // One effect owns every event subscription plus the pet itself, so
    // unmounting the plugin unsubscribes and clears the terminal image.
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // a disposer error must not block the rest of shutdown
        }
      }
      deactivatePet();
    });
  },
};

// Re-export the manifest shape for downstream consumers (e.g. a future
// `/pets info <id>` introspection command).
export type { PetManifest };

import { useMemo } from "react";
import { getHostServices as kernelGetHostServices, useCommands, usePlugins } from "../../core/plugins";
import { useModalVisibility } from "../context/modal-context.js";
import type { SlashMenuItem } from "../slash-menu";

export function useSlashItems(): SlashMenuItem[] {
  const { showSlashMenu } = useModalVisibility();
  const commands = useCommands();
  const extensions = usePlugins();
  const kernelServices = kernelGetHostServices();

  const enabledExtIds = useMemo(
    () => new Set(extensions.filter((e) => e.enabled).map((e) => e.manifest.id)),
    [extensions],
  );

  const tierAItems = useMemo<SlashMenuItem[]>(
    () => [
      { id: "models", label: "models", description: "Select a model" },
      { id: "server", label: "server", description: "Connect to a server (user or project), or run serverless" },
    ],
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: kernelServices is a stable singleton facade
  const registryItems = useMemo<SlashMenuItem[]>(
    () =>
      commands
        .filter((c) => enabledExtIds.has(c.pluginId))
        .filter((c) => !c.hidden)
        .filter((c) => !c.visible || c.visible(kernelServices))
        .map((c) => ({
          id: c.name.replace(/^\//, ""),
          label: c.name.replace(/^\//, ""),
          description: c.description,
        })),
    [commands, enabledExtIds],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-scan on each menu open is intentional
  const dynamicCommands = useMemo<SlashMenuItem[]>(() => {
    if (!showSlashMenu) return [];
    return kernelServices.commands
      .listDynamic()
      .filter((c) => enabledExtIds.has(c.pluginId))
      .map((c) => ({
        id: c.name.replace(/^\//, ""),
        label: c.name.replace(/^\//, ""),
        description: c.description,
      }));
  }, [showSlashMenu]);

  return useMemo<SlashMenuItem[]>(() => {
    const seenIds = new Set<string>();
    return [...tierAItems, ...registryItems, ...dynamicCommands].filter((item) => {
      if (seenIds.has(item.id)) return false;
      seenIds.add(item.id);
      return true;
    });
  }, [tierAItems, registryItems, dynamicCommands]);
}

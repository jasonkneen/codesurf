import type { TextareaRenderable } from "@opentui/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { POPULAR_MCP_CATALOG } from "../../../mcp/catalog";
import { parseEnvLines, parseHeaderLines } from "../../../mcp/parse-headers";
import { buildMcpToolSet, type McpResourceContent, type McpResourceSummary } from "../../../mcp/runtime";
import { toMcpServerId, validateMcpServerConfig } from "../../../mcp/validate";
import { loadMcpServers, type McpRemoteTransport, type McpServerConfig, saveMcpServers } from "../../../utils/settings";
import { useModalVisibility } from "../../context/modal-context.js";
import { buildMcpBrowseRows, type McpServerStats } from "../../mcp-modal";
import { createEmptyMcpEditorDraft, type McpEditorDraft, type McpEditorField } from "../../mcp-modal-types";

export type McpDrillState =
  | { mode: "list" }
  | { mode: "resources"; serverId: string; serverLabel: string }
  | {
      mode: "viewer";
      serverId: string;
      serverLabel: string;
      resource: McpResourceSummary;
    };

export function useMcpActions() {
  const modal = useModalVisibility();

  const {
    setMcpServers,
    mcpServers,
    mcpSearchQueryRef,
    setMcpSearchQuery,
    setMcpModalIndex,
    setShowMcpModal,
    setShowMcpEditor,
    showMcpModal,
    showMcpEditor,
  } = modal;

  // ── Internal modal editor state ────────────────────────────────────────
  const [mcpEditorDraft, setMcpEditorDraft] = useState<McpEditorDraft>(createEmptyMcpEditorDraft());
  const [mcpEditorField, setMcpEditorField] = useState<McpEditorField>("transport");
  const [mcpEditorSyncKey, setMcpEditorSyncKey] = useState(0);
  const [mcpEditorError, setMcpEditorError] = useState<string | null>(null);
  const [editingMcpId, setEditingMcpId] = useState<string | null>(null);
  const [mcpServerStats, setMcpServerStats] = useState<Map<string, McpServerStats>>(() => new Map());
  const [mcpStatsLoading, setMcpStatsLoading] = useState(false);

  const [mcpDrillState, setMcpDrillState] = useState<McpDrillState>({ mode: "list" });
  const [mcpDrillResources, setMcpDrillResources] = useState<McpResourceSummary[]>([]);
  const [mcpDrillResourcesLoading, setMcpDrillResourcesLoading] = useState(false);
  const [mcpDrillResourceIndex, setMcpDrillResourceIndex] = useState(0);
  const [mcpDrillContent, setMcpDrillContent] = useState<McpResourceContent[] | null>(null);
  const [mcpDrillContentLoading, setMcpDrillContentLoading] = useState(false);
  const mcpDrillStateRef = useRef<McpDrillState>(mcpDrillState);
  const mcpLabelRef = useRef<TextareaRenderable>(null);
  const mcpUrlRef = useRef<TextareaRenderable>(null);
  const mcpHeadersRef = useRef<TextareaRenderable>(null);
  const mcpCommandRef = useRef<TextareaRenderable>(null);
  const mcpArgsRef = useRef<TextareaRenderable>(null);
  const mcpCwdRef = useRef<TextareaRenderable>(null);
  const mcpEnvRef = useRef<TextareaRenderable>(null);

  // ── MCP callbacks ──────────────────────────────────────────────────────

  const syncStoredMcpServers = useCallback(
    (servers: McpServerConfig[]) => {
      setMcpServers(servers);
      saveMcpServers(servers);
    },
    [setMcpServers],
  );

  const snapshotMcpEditorDraft = useCallback((): McpEditorDraft => {
    return {
      ...mcpEditorDraft,
      label: mcpLabelRef.current?.plainText ?? mcpEditorDraft.label,
      url: mcpUrlRef.current?.plainText ?? mcpEditorDraft.url,
      headersText: mcpHeadersRef.current?.plainText ?? mcpEditorDraft.headersText,
      command: mcpCommandRef.current?.plainText ?? mcpEditorDraft.command,
      argsText: mcpArgsRef.current?.plainText ?? mcpEditorDraft.argsText,
      cwd: mcpCwdRef.current?.plainText ?? mcpEditorDraft.cwd,
      envText: mcpEnvRef.current?.plainText ?? mcpEditorDraft.envText,
    };
  }, [mcpEditorDraft]);

  const openMcpModal = useCallback(() => {
    const latest = loadMcpServers();
    setMcpServers(latest);
    setMcpSearchQuery("");
    setMcpModalIndex(0);
    setShowMcpModal(true);
    setShowMcpEditor(false);
    setEditingMcpId(null);
    setMcpEditorError(null);
  }, [setShowMcpModal, setShowMcpEditor, setMcpSearchQuery, setMcpModalIndex, setMcpServers]);

  const openMcpEditor = useCallback(
    (draft: McpEditorDraft, editingId: string | null = null) => {
      setMcpEditorDraft(draft);
      setEditingMcpId(editingId);
      setMcpEditorField("transport");
      setMcpEditorError(null);
      setMcpEditorSyncKey((n) => n + 1);
      setShowMcpEditor(true);
      setShowMcpModal(true);
    },
    [setShowMcpEditor, setShowMcpModal],
  );

  const openCatalogMcp = useCallback(
    (entry: (typeof POPULAR_MCP_CATALOG)[number]) => {
      const existing = mcpServers.find((server) => toMcpServerId(server.id) === toMcpServerId(entry.id));
      if (existing) {
        openMcpEditor(
          {
            label: existing.label,
            transport: existing.transport,
            url: existing.url ?? "",
            headersText: Object.entries(existing.headers ?? {})
              .map(([key, value]) => `${key}: ${value}`)
              .join("\n"),
            command: existing.command ?? "",
            argsText: (existing.args ?? []).join("\n"),
            cwd: existing.cwd ?? "",
            envText: Object.entries(existing.env ?? {})
              .map(([key, value]) => `${key}=${value}`)
              .join("\n"),
          },
          existing.id,
        );
        return;
      }
      openMcpEditor({
        ...createEmptyMcpEditorDraft(),
        label: entry.name,
        transport: entry.starterTransport ?? "stdio",
      });
    },
    [mcpServers, openMcpEditor],
  );

  const editSavedMcp = useCallback(
    (server: McpServerConfig) => {
      openMcpEditor(
        {
          label: server.label,
          transport: server.transport,
          url: server.url ?? "",
          headersText: Object.entries(server.headers ?? {})
            .map(([key, value]) => `${key}: ${value}`)
            .join("\n"),
          command: server.command ?? "",
          argsText: (server.args ?? []).join("\n"),
          cwd: server.cwd ?? "",
          envText: Object.entries(server.env ?? {})
            .map(([key, value]) => `${key}=${value}`)
            .join("\n"),
        },
        server.id,
      );
    },
    [openMcpEditor],
  );

  const toggleSavedMcp = useCallback(
    (server: McpServerConfig) => {
      syncStoredMcpServers(
        mcpServers.map((item) => (item.id === server.id ? { ...item, enabled: !item.enabled } : item)),
      );
    },
    [mcpServers, syncStoredMcpServers],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: ref reads are intentional — avoids subscribing to nav context
  const deleteSavedMcp = useCallback(
    (server: McpServerConfig) => {
      syncStoredMcpServers(mcpServers.filter((item) => item.id !== server.id));
      const rows = buildMcpBrowseRows(mcpServers, POPULAR_MCP_CATALOG, mcpSearchQueryRef.current);
      setMcpModalIndex((idx) => Math.max(0, Math.min(idx, Math.max(0, rows.length - 2))));
    },
    [mcpServers, syncStoredMcpServers, setMcpModalIndex],
  );

  const submitMcpEditor = useCallback(() => {
    const draft: McpEditorDraft = {
      label: mcpLabelRef.current?.plainText || "",
      transport: mcpEditorDraft.transport,
      url: mcpUrlRef.current?.plainText || "",
      headersText: mcpHeadersRef.current?.plainText || "",
      command: mcpCommandRef.current?.plainText || "",
      argsText: mcpArgsRef.current?.plainText || "",
      cwd: mcpCwdRef.current?.plainText || "",
      envText: mcpEnvRef.current?.plainText || "",
    };

    const baseId = toMcpServerId(draft.label);
    const currentServers = loadMcpServers();

    const conflictingServer = currentServers.find((s) => s.id === baseId && s.id !== editingMcpId);
    if (conflictingServer) {
      setMcpEditorError(`Only one protocol is supported per MCP. Edit "${conflictingServer.label}" instead.`);
      return;
    }

    const id = editingMcpId ?? baseId;

    const server: McpServerConfig = {
      id,
      label: draft.label.trim(),
      enabled: true,
      transport: draft.transport,
      ...(draft.transport === "stdio"
        ? {
            command: draft.command.trim(),
            args: draft.argsText
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
            cwd: draft.cwd.trim() || undefined,
            env: Object.keys(parseEnvLines(draft.envText)).length ? parseEnvLines(draft.envText) : undefined,
          }
        : {
            url: draft.url.trim(),
            headers: Object.keys(parseHeaderLines(draft.headersText)).length
              ? parseHeaderLines(draft.headersText)
              : undefined,
            env: Object.keys(parseEnvLines(draft.envText)).length ? parseEnvLines(draft.envText) : undefined,
          }),
    };

    const validation = validateMcpServerConfig(server);
    if (!validation.ok) {
      setMcpEditorError(validation.error);
      return;
    }

    const nextServers = editingMcpId
      ? currentServers.map((item) =>
          item.id === editingMcpId ? { ...server, id: editingMcpId, enabled: item.enabled } : item,
        )
      : [...currentServers, server];
    saveMcpServers(nextServers);
    setMcpServers(nextServers);
    setShowMcpEditor(false);
    setEditingMcpId(null);
    setMcpEditorError(null);
    setMcpSearchQuery("");
    setMcpModalIndex(
      Math.max(
        0,
        nextServers.findIndex((item) => item.id === (editingMcpId ?? server.id)),
      ),
    );
  }, [mcpEditorDraft.transport, editingMcpId, setMcpSearchQuery, setMcpServers, setMcpModalIndex, setShowMcpEditor]);

  const cycleMcpEditorTransport = useCallback(
    (direction: 1 | -1 = 1) => {
      const draft = snapshotMcpEditorDraft();
      const order: Array<McpRemoteTransport | "stdio"> = ["stdio", "http", "sse"];
      const currentIndex = order.indexOf(draft.transport);
      const nextTransport = order[(currentIndex + direction + order.length) % order.length];
      const nextDraft = { ...draft, transport: nextTransport };
      setMcpEditorDraft(nextDraft);
      setMcpEditorField("transport");
      setMcpEditorSyncKey((n) => n + 1);

      if (!editingMcpId) return;

      const existing = mcpServers.find((server) => server.id === editingMcpId);
      if (!existing) return;

      const optimisticServer: McpServerConfig = {
        id: existing.id,
        label: nextDraft.label.trim() || existing.label,
        enabled: existing.enabled,
        transport: nextTransport,
        ...(nextTransport === "stdio"
          ? {
              command: nextDraft.command.trim() || existing.command,
              args: nextDraft.argsText
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
              cwd: nextDraft.cwd.trim() || undefined,
              env: Object.keys(parseEnvLines(nextDraft.envText)).length ? parseEnvLines(nextDraft.envText) : undefined,
            }
          : {
              url: nextDraft.url.trim() || existing.url,
              headers: Object.keys(parseHeaderLines(nextDraft.headersText)).length
                ? parseHeaderLines(nextDraft.headersText)
                : undefined,
              env: Object.keys(parseEnvLines(nextDraft.envText)).length ? parseEnvLines(nextDraft.envText) : undefined,
            }),
      };

      syncStoredMcpServers(mcpServers.map((server) => (server.id === editingMcpId ? optimisticServer : server)));
    },
    [editingMcpId, mcpServers, snapshotMcpEditorDraft, syncStoredMcpServers],
  );

  const openMcpResourceDrill = useCallback((server: McpServerConfig) => {
    setMcpDrillState({
      mode: "resources",
      serverId: server.id,
      serverLabel: server.label,
    });
    setMcpDrillResources([]);
    setMcpDrillResourceIndex(0);
    setMcpDrillResourcesLoading(true);
    const isStillOnThisDrill = () => {
      const s = mcpDrillStateRef.current;
      return s.mode === "resources" && s.serverId === server.id;
    };
    (async () => {
      let bundle: Awaited<ReturnType<typeof buildMcpToolSet>> | null = null;
      try {
        bundle = await buildMcpToolSet([server]);
        if (!isStillOnThisDrill()) return;
        const resources = await bundle.listResources(server.id);
        if (!isStillOnThisDrill()) return;
        setMcpDrillResources(resources);
      } catch {
        if (isStillOnThisDrill()) setMcpDrillResources([]);
      } finally {
        if (bundle) await bundle.close();
        if (isStillOnThisDrill()) setMcpDrillResourcesLoading(false);
      }
    })();
  }, []);

  const openMcpResourceViewer = useCallback((server: McpServerConfig, resource: McpResourceSummary) => {
    setMcpDrillState({
      mode: "viewer",
      serverId: server.id,
      serverLabel: server.label,
      resource,
    });
    setMcpDrillContent(null);
    setMcpDrillContentLoading(true);
    const isStillOnThisViewer = () => {
      const s = mcpDrillStateRef.current;
      return s.mode === "viewer" && s.serverId === server.id && s.resource.uri === resource.uri;
    };
    (async () => {
      let bundle: Awaited<ReturnType<typeof buildMcpToolSet>> | null = null;
      try {
        bundle = await buildMcpToolSet([server]);
        if (!isStillOnThisViewer()) return;
        const result = await bundle.readResource(server.id, resource.uri);
        if (!isStillOnThisViewer()) return;
        setMcpDrillContent(result?.contents ?? null);
      } catch {
        if (isStillOnThisViewer()) setMcpDrillContent(null);
      } finally {
        if (bundle) await bundle.close();
        if (isStillOnThisViewer()) setMcpDrillContentLoading(false);
      }
    })();
  }, []);

  const handleMcpListEscape = useCallback(() => {
    setShowMcpEditor(false);
    setShowMcpModal(false);
    setMcpSearchQuery("");
    setEditingMcpId(null);
    setMcpEditorError(null);
  }, [setShowMcpEditor, setShowMcpModal, setMcpSearchQuery]);

  const handleMcpAddNew = useCallback(() => {
    openMcpEditor(createEmptyMcpEditorDraft());
  }, [openMcpEditor]);

  const handleMcpDrillBackToList = useCallback(() => {
    setMcpDrillState({ mode: "list" });
    setMcpDrillResources([]);
    setMcpDrillResourceIndex(0);
  }, []);

  const handleMcpDrillBackToResources = useCallback(() => {
    const drill = mcpDrillStateRef.current;
    if (drill.mode === "viewer") {
      setMcpDrillState({
        mode: "resources",
        serverId: drill.serverId,
        serverLabel: drill.serverLabel,
      });
    }
    setMcpDrillContent(null);
    setMcpDrillContentLoading(false);
  }, []);

  // ── MCP effects ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!showMcpEditor || !editingMcpId) return;

    const existing = mcpServers.find((server) => server.id === editingMcpId);
    if (!existing) return;
    if (existing.transport === mcpEditorDraft.transport) return;

    const syncedServer: McpServerConfig = {
      id: existing.id,
      label: mcpEditorDraft.label.trim() || existing.label,
      enabled: existing.enabled,
      transport: mcpEditorDraft.transport,
      ...(mcpEditorDraft.transport === "stdio"
        ? {
            command: mcpEditorDraft.command.trim() || undefined,
            args: mcpEditorDraft.argsText
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
            cwd: mcpEditorDraft.cwd.trim() || undefined,
            env: Object.keys(parseEnvLines(mcpEditorDraft.envText)).length
              ? parseEnvLines(mcpEditorDraft.envText)
              : undefined,
          }
        : {
            url: mcpEditorDraft.url.trim() || undefined,
            headers: Object.keys(parseHeaderLines(mcpEditorDraft.headersText)).length
              ? parseHeaderLines(mcpEditorDraft.headersText)
              : undefined,
            env: Object.keys(parseEnvLines(mcpEditorDraft.envText)).length
              ? parseEnvLines(mcpEditorDraft.envText)
              : undefined,
          }),
    };

    syncStoredMcpServers(mcpServers.map((server) => (server.id === editingMcpId ? syncedServer : server)));
  }, [editingMcpId, mcpEditorDraft, mcpServers, showMcpEditor, syncStoredMcpServers]);

  useEffect(() => {
    mcpDrillStateRef.current = mcpDrillState;
  }, [mcpDrillState]);

  useEffect(() => {
    if (!showMcpModal) return;
    let cancelled = false;
    setMcpStatsLoading(true);
    (async () => {
      let bundle: Awaited<ReturnType<typeof buildMcpToolSet>> | null = null;
      try {
        bundle = await buildMcpToolSet(loadMcpServers());
        if (cancelled) return;
        const next = new Map<string, McpServerStats>();
        for (const id of bundle.serverIds) {
          if (cancelled) return;
          const [resources, prompts] = await Promise.all([bundle.listResources(id), bundle.listPrompts(id)]);
          if (cancelled) return;
          next.set(id, {
            tools: bundle.toolCountsByServerId.get(id) ?? 0,
            resources: resources.length,
            prompts: prompts.length,
          });
        }
        if (!cancelled) setMcpServerStats(next);
      } catch {
        if (!cancelled) setMcpServerStats(new Map());
      } finally {
        if (bundle) await bundle.close();
        if (!cancelled) setMcpStatsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showMcpModal]);

  useEffect(() => {
    if (showMcpModal) return;
    setMcpDrillState({ mode: "list" });
    setMcpDrillResources([]);
    setMcpDrillResourceIndex(0);
    setMcpDrillContent(null);
    setMcpDrillResourcesLoading(false);
    setMcpDrillContentLoading(false);
  }, [showMcpModal]);

  return {
    syncStoredMcpServers,
    snapshotMcpEditorDraft,
    openMcpModal,
    openMcpEditor,
    openCatalogMcp,
    editSavedMcp,
    toggleSavedMcp,
    deleteSavedMcp,
    submitMcpEditor,
    cycleMcpEditorTransport,
    openMcpResourceDrill,
    openMcpResourceViewer,
    handleMcpListEscape,
    handleMcpAddNew,
    handleMcpDrillBackToList,
    handleMcpDrillBackToResources,

    mcpEditorDraft,
    mcpEditorField,
    mcpEditorSyncKey,
    mcpEditorError,
    editingMcpId,
    mcpServerStats,
    mcpStatsLoading,
    mcpDrillState,
    mcpDrillResources,
    mcpDrillResourcesLoading,
    mcpDrillResourceIndex,
    mcpDrillContent,
    mcpDrillContentLoading,
    mcpLabelRef,
    mcpUrlRef,
    mcpHeadersRef,
    mcpCommandRef,
    mcpArgsRef,
    mcpCwdRef,
    mcpEnvRef,

    setMcpEditorField,
    setMcpEditorError,
    setMcpDrillResourceIndex,
  };
}

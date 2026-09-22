import type { TextareaRenderable } from "@opentui/core";
import { createContext, type ReactNode, type RefObject, useCallback, useContext, useMemo, useRef } from "react";
import type { Agent } from "../../agent/agent";
import { getHostServices as kernelGetHostServices } from "../../core/plugins";
import { ensureWorkspace } from "../../storage/workspaces";
import { type FileMentionBlock, getFileMentionToken, getPasteBlockToken, type PasteBlock } from "../app-helpers";
import { type PromptHistoryHandle, usePromptHistory } from "../hooks/usePromptHistory.js";
import type { TypeaheadState } from "../hooks/useTypeahead.js";
import { useTypeahead } from "../hooks/useTypeahead.js";
import { isImageFilePath, normalizeLocalPathText } from "../local-file-paths.js";
import { useConversationState } from "./conversation-state-context.js";
import { useQueue } from "./queue-context.js";
import { useRunningAgents } from "./running-agents-context.js";

interface ComposerCtx {
  inputRef: RefObject<TextareaRenderable | null>;
  commitComposer: (opts?: { text?: string; clear?: boolean }) => void;
  typeahead: TypeaheadState;
  typeaheadRef: RefObject<TypeaheadState>;
  promptHistory: PromptHistoryHandle;
  promptHistoryRef: RefObject<PromptHistoryHandle>;
  workspaceId: string | null;
  fileMentionCounterRef: RefObject<number>;
  fileMentionBlocksRef: RefObject<FileMentionBlock[]>;
  handleFileAccept: (filePath: string, tokenInfo: { startPos: number; endPos: number }) => void;
  replacePasteBlocks: (next: PasteBlock[]) => void;
  insertImagePathBlock: (imagePath: string) => void;
  insertFileMentionBlock: (filePath: string) => void;
  insertDroppedFilePaths: (paths: string[]) => boolean;
}

const Ctx = createContext<ComposerCtx | null>(null);

export function useComposer(): ComposerCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useComposer must be used inside <ComposerProvider>");
  return ctx;
}

export function ComposerProvider({ agent, children }: { agent: Agent; children: ReactNode }) {
  const { setPasteBlocks, pasteCounterRef, pasteBlocksRef } = useConversationState();
  const { queueFocusIdRef, setQueueFocusId } = useQueue();
  const { agentsFooterFocusedRef, setAgentsFooterFocused } = useRunningAgents();

  const inputRef = useRef<TextareaRenderable>(null);

  const commitComposer = useCallback((opts?: { text?: string; clear?: boolean }) => {
    const ta = inputRef.current;
    if (!ta) return;
    if (opts?.clear ?? true) ta.clear();
    ta.requestRender();
    if (opts?.text) ta.insertText(opts.text);
  }, []);

  const fileMentionCounterRef = useRef(0);
  const fileMentionBlocksRef = useRef<FileMentionBlock[]>([]);

  const handleFileAccept = useCallback((filePath: string, tokenInfo: { startPos: number; endPos: number }) => {
    const ta = inputRef.current;
    if (!ta) return;

    const id = ++fileMentionCounterRef.current;
    const path = kernelGetHostServices().mentions.resolvePath(filePath);
    const block: FileMentionBlock = { id, path };
    fileMentionBlocksRef.current = [...fileMentionBlocksRef.current, block];

    const text = ta.plainText;
    const before = text.slice(0, tokenInfo.startPos);
    const after = text.slice(tokenInfo.endPos);
    const token = getFileMentionToken(block);
    const newText = `${before}${token} ${after}`;
    ta.setText(newText);
    ta.cursorOffset = before.length + token.length + 1;
  }, []);

  const typeahead = useTypeahead(inputRef, kernelGetHostServices().mentions, handleFileAccept);
  const typeaheadRef = useRef(typeahead);
  typeaheadRef.current = typeahead;

  const workspaceId = useMemo(() => {
    try {
      return ensureWorkspace(agent.getCwd()).id;
    } catch {
      return null;
    }
  }, [agent]);

  const promptHistory = usePromptHistory(inputRef, workspaceId);
  const promptHistoryRef = useRef(promptHistory);
  promptHistoryRef.current = promptHistory;

  const replacePasteBlocks = useCallback(
    (next: PasteBlock[]) => {
      pasteBlocksRef.current = next;
      setPasteBlocks(next);
    },
    [pasteBlocksRef, setPasteBlocks],
  );

  const insertImagePathBlock = useCallback(
    (imagePath: string) => {
      const id = ++pasteCounterRef.current;
      const block = {
        id,
        content: normalizeLocalPathText(imagePath, agent.getCwd()),
        lines: 1,
        isImage: true,
      } satisfies PasteBlock;
      replacePasteBlocks([...pasteBlocksRef.current, block]);
      inputRef.current?.insertText(`${getPasteBlockToken(block)} `);
    },
    [agent, replacePasteBlocks, pasteCounterRef, pasteBlocksRef.current],
  );

  const insertFileMentionBlock = useCallback(
    (filePath: string) => {
      const id = ++fileMentionCounterRef.current;
      const path = kernelGetHostServices().mentions.resolvePath(normalizeLocalPathText(filePath, agent.getCwd()));
      const block: FileMentionBlock = { id, path };
      fileMentionBlocksRef.current = [...fileMentionBlocksRef.current, block];
      inputRef.current?.insertText(`${getFileMentionToken(block)} `);
    },
    [agent],
  );

  const insertDroppedFilePaths = useCallback(
    (paths: string[]): boolean => {
      if (paths.length === 0) return false;

      if (queueFocusIdRef.current !== null) setQueueFocusId(null);
      if (agentsFooterFocusedRef.current) setAgentsFooterFocused(false);

      for (const filePath of paths) {
        if (isImageFilePath(filePath)) {
          insertImagePathBlock(filePath);
        } else {
          insertFileMentionBlock(filePath);
        }
      }
      inputRef.current?.focus();
      return true;
    },
    [
      insertFileMentionBlock,
      insertImagePathBlock,
      setAgentsFooterFocused,
      agentsFooterFocusedRef.current,
      queueFocusIdRef.current,
      setQueueFocusId,
    ],
  );

  const value = useMemo<ComposerCtx>(
    () => ({
      inputRef,
      commitComposer,
      typeahead,
      typeaheadRef,
      promptHistory,
      promptHistoryRef,
      workspaceId,
      fileMentionCounterRef,
      fileMentionBlocksRef,
      handleFileAccept,
      replacePasteBlocks,
      insertImagePathBlock,
      insertFileMentionBlock,
      insertDroppedFilePaths,
    }),
    [
      commitComposer,
      typeahead,
      promptHistory,
      workspaceId,
      handleFileAccept,
      replacePasteBlocks,
      insertImagePathBlock,
      insertFileMentionBlock,
      insertDroppedFilePaths,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

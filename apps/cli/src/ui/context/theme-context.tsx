import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { loadUserSettings, saveUserSettings, type UiMode } from "../../utils/settings";
import { dark, type Theme } from "../theme";
import { DEFAULT_THEME_ID, findThemeDescriptor, getTheme, THEMES } from "../themes/catalog";

void dark;

interface ThemeCtx {
  themeId: string;
  setThemeId: Dispatch<SetStateAction<string>>;
  t: Theme;
  uiMode: UiMode;
  setUiMode: (mode: UiMode) => void;
  toggleUiMode: () => void;
  showThemeModal: boolean;
  setShowThemeModal: Dispatch<SetStateAction<boolean>>;
  themeSearchQuery: string;
  setThemeSearchQuery: Dispatch<SetStateAction<string>>;
  themeModalIndex: number;
  setThemeModalIndex: Dispatch<SetStateAction<number>>;
  openThemeModal: () => void;
  previewTheme: (id: string) => void;
  applyTheme: (id: string) => void;
  revertThemePreview: () => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeIdState] = useState<string>(() => {
    try {
      const saved = loadUserSettings().theme;
      return saved ?? DEFAULT_THEME_ID;
    } catch {
      return DEFAULT_THEME_ID;
    }
  });
  const baseTheme: Theme = getTheme(themeId);
  const [uiMode, setUiModeState] = useState<UiMode>(() => loadUserSettings().uiMode ?? "opencode");
  const [showThemeModal, setShowThemeModal] = useState(false);
  const [themeSearchQuery, setThemeSearchQuery] = useState("");
  const [themeModalIndex, setThemeModalIndex] = useState(0);
  const [themePreviewOriginal, setThemePreviewOriginal] = useState<string | null>(null);

  const t: Theme = useMemo(() => {
    if (uiMode !== "claude-code") return baseTheme;
    return {
      ...baseTheme,
      diffAddedFg: baseTheme.accent,
      mdCode: baseTheme.accent,
      mdLink: baseTheme.accent,
      mdLinkText: baseTheme.accent,
      mdBold: baseTheme.accent,
      mdItalic: baseTheme.accent,
      mdHeading: baseTheme.accent,
    };
  }, [baseTheme, uiMode]);

  const setUiMode = useCallback((next: UiMode) => {
    setUiModeState(next);
    saveUserSettings({ uiMode: next });
  }, []);

  const toggleUiMode = useCallback(() => {
    setUiModeState((prev) => {
      const next: UiMode = prev === "opencode" ? "claude-code" : "opencode";
      saveUserSettings({ uiMode: next });
      return next;
    });
  }, []);

  const openThemeModal = useCallback(() => {
    setThemePreviewOriginal(themeId);
    setThemeModalIndex(0);
    setThemeSearchQuery("");
    setShowThemeModal(true);
  }, [themeId]);

  const previewTheme = useCallback((id: string) => {
    setThemeIdState(id);
  }, []);

  const applyTheme = useCallback((id: string) => {
    setThemeIdState(id);
    saveUserSettings({ theme: id });
    setShowThemeModal(false);
    setThemePreviewOriginal(null);
  }, []);

  const revertThemePreview = useCallback(() => {
    if (themePreviewOriginal !== null) {
      setThemeIdState(themePreviewOriginal);
    }
    setShowThemeModal(false);
    setThemePreviewOriginal(null);
  }, [themePreviewOriginal]);

  const value = useMemo<ThemeCtx>(
    () => ({
      themeId,
      setThemeId: setThemeIdState,
      t,
      uiMode,
      setUiMode,
      toggleUiMode,
      showThemeModal,
      setShowThemeModal,
      themeSearchQuery,
      setThemeSearchQuery,
      themeModalIndex,
      setThemeModalIndex,
      openThemeModal,
      previewTheme,
      applyTheme,
      revertThemePreview,
    }),
    [
      themeId,
      t,
      uiMode,
      setUiMode,
      toggleUiMode,
      showThemeModal,
      themeSearchQuery,
      themeModalIndex,
      openThemeModal,
      previewTheme,
      applyTheme,
      revertThemePreview,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export { DEFAULT_THEME_ID, findThemeDescriptor, THEMES };

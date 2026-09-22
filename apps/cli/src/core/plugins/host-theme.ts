// Host theme accessor + React hook for extensions.
//
// Extension screens (editor, files, doc-viewer, steer) all need the active
// `Theme` object so their UI matches whatever the user picked in /theme.
// Before this module each one imported `loadUserSettings` and
// `getTheme(themeId)` from the host's internals — direct reach-around into
// `src/ui/themes/catalog` + `src/utils/settings`.
//
// `useHostTheme()` returns the current theme and re-renders the calling
// component whenever the user flips themes. `getHostTheme()` is the
// synchronous equivalent for non-React code paths.

import { getTheme, type Theme } from "../../ui/themes/catalog";
import { loadUserSettings } from "../../utils/settings";

function readTheme(): Theme {
  return getTheme(loadUserSettings().theme);
}

export function getHostTheme(): Theme {
  return readTheme();
}

/**
 * React hook returning the active theme. Returns a fresh snapshot on each
 * render — themes can't change without user input, and host screens are
 * short-lived modal overlays, so a per-render read is acceptable. If
 * dynamic theme switching during a screen lifetime becomes a need, this
 * can switch to `useSyncExternalStore` once `subscribeToUserSettings`
 * exists in `src/utils/settings`.
 */
export function useHostTheme(): Theme {
  return readTheme();
}

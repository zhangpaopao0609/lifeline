import { create } from 'zustand';

export type ThemePreference = 'dark' | 'light' | 'system';
export type ThemeName = 'dark' | 'light';

interface ThemeStore {
  preference: ThemePreference;
  /** Appearance actually on screen. Follows the system only while preference is `system`. */
  theme: ThemeName;
  setPreference: (preference: ThemePreference) => void;
}

export const useThemeStore = create<ThemeStore>()(set => ({
  preference: 'dark',
  theme: 'dark',
  setPreference: (preference) => {
    set({ preference });
    try {
      window.localStorage.setItem('lifeline:theme', preference);
    }
    catch {
      // Storage can be unavailable; the current page still switches.
    }
  },
}));

let activeWipe: ViewTransition | undefined;

/**
 * User-initiated appearance change. The new theme wipes in behind one straight edge, from the top-left corner to the bottom-right.
 * A browser without view transitions, or a reader who asked for less motion, switches at once.
 */
export function switchTheme(preference: ThemePreference): void {
  const apply = () => useThemeStore.getState().setPreference(preference);
  const mediaDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const next = preference === 'system' ? (mediaDark ? 'dark' : 'light') : preference;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const start = document.startViewTransition?.bind(document);
  if (reduce || start == null || document.documentElement.dataset.theme === next) {
    apply();
    return;
  }
  activeWipe?.skipTransition();
  try {
    const wipe = start(apply);
    activeWipe = wipe;
    void wipe.finished.finally(() => {
      if (activeWipe === wipe)
        activeWipe = undefined;
    });
  }
  catch {
    apply();
  }
}

/** The head script restores the preference before first paint; install once before mounting React. */
export function installTheme(): () => void {
  const root = document.documentElement;
  const saved = root.dataset.themePreference;
  useThemeStore.setState({ preference: saved === 'light' || saved === 'system' ? saved : 'dark' });
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    const { preference } = useThemeStore.getState();
    const theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    root.dataset.themePreference = preference;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    if (useThemeStore.getState().theme !== theme)
      useThemeStore.setState({ theme });
  };
  const onSystemChange = () => {
    if (useThemeStore.getState().preference === 'system')
      apply();
  };
  apply();
  const unsubscribe = useThemeStore.subscribe(apply);
  media.addEventListener('change', onSystemChange);
  return () => {
    unsubscribe();
    media.removeEventListener('change', onSystemChange);
  };
}

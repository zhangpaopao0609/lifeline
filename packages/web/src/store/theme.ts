import { create } from 'zustand';

export type ThemePreference = 'dark' | 'light' | 'system';

interface ThemeStore {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

export const useThemeStore = create<ThemeStore>()(set => ({
  preference: 'dark',
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

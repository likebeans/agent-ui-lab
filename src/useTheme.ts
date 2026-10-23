import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
const THEME_EVENT = 'ui-lab-theme-change';

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return localStorage.getItem('ui-lab-theme') === 'dark' ? 'dark' : 'light';
    } catch {
      return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    }
  });
  useEffect(() => {
    const changed = () => {
      setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
    };
    window.addEventListener(THEME_EVENT, changed);
    return () => window.removeEventListener(THEME_EVENT, changed);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('ui-lab-theme', theme);
    } catch {
      // The current theme also works without browser storage.
    }
    window.dispatchEvent(new Event(THEME_EVENT));
  }, [theme]);
  return [theme, setTheme] as const;
}

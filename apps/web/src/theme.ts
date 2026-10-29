import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "dvmail-theme";
const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

function stored(): Theme | null {
  try { const t = localStorage.getItem(KEY); return t === "light" || t === "dark" ? t : null; } catch { return null; }
}

/** Тема: выбор человека запоминается; пока выбора нет, следуем настройке системы */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => stored() ?? (systemDark() ? "dark" : "light"));

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => { if (!stored()) setTheme(mq.matches ? "dark" : "light"); };
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const toggle = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === "dark" ? "light" : "dark";
      try { localStorage.setItem(KEY, next); } catch { /* без хранилища выбор живёт до перезагрузки */ }
      return next;
    });
  }, []);
  return [theme, toggle];
}

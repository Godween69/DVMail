import { useCallback, useEffect, useState } from "react";

/** Совпадает ли экран с условием (например, узкий экран) */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const f = () => setOn(mq.matches);
    f();
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, [query]);
  return on;
}

// Адрес страницы хранит, где мы: #/папка/письмо. Так работают кнопка «назад» и обновление страницы.
export interface Route { box: string | null; id: string | null }
const HASH = /^#\/([A-Za-z0-9._~-]{1,200})(?:\/([A-Za-z0-9._~-]{1,200}))?$/;
const read = (): Route => { const m = HASH.exec(window.location.hash); return { box: m?.[1] ?? null, id: m?.[2] ?? null }; };

export function useRoute(): [Route, (r: Route, replace?: boolean) => void] {
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const f = () => setRoute(read());
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  const go = useCallback((r: Route, replace = false) => {
    const h = r.box ? `#/${r.box}${r.id ? "/" + r.id : ""}` : "#/";
    if (replace) { window.history.replaceState(null, "", h); setRoute(r); } else window.location.hash = h;
  }, []);
  return [route, go];
}

export interface Toast { id: number; text: string; kind: "ok" | "err" }
/** Короткие уведомления внизу экрана */
export function useToasts(): [Toast[], (text: string, kind?: "ok" | "err") => void] {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: "ok" | "err" = "ok") => {
    const id = Date.now() + Math.random();
    setList((l) => [...l.slice(-2), { id, text, kind }]);
    window.setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), 4500);
  }, []);
  return [list, push];
}

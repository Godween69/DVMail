import { MotionConfig } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { api, setUnauthorizedHandler } from "./api";
import { Login } from "./Login";
import { MailApp } from "./MailApp";
import { useTheme } from "./theme";

type Auth = { state: "checking" } | { state: "out"; notice?: string } | { state: "in"; email: string };

export default function App() {
  const [auth, setAuth] = useState<Auth>({ state: "checking" });
  const [theme, toggleTheme] = useTheme();

  // Если сервер сообщил, что сессия закончилась, возвращаем на вход
  useEffect(() => {
    setUnauthorizedHandler(() => setAuth((a) => (a.state === "in" ? { state: "out", notice: "Сессия закончилась. Войдите снова." } : a)));
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    api.me().then((r) => setAuth({ state: "in", email: r.email }), () => setAuth({ state: "out" }));
  }, []);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* сессию в любом случае закрываем у себя */ }
    window.location.hash = "";
    setAuth({ state: "out" });
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      {auth.state === "checking" ? <div className="boot"><span className="spinner big" aria-label="Загрузка" /></div>
        : auth.state === "out" ? <Login notice={auth.notice} onLogin={(email) => setAuth({ state: "in", email })} />
        : <MailApp email={auth.email} theme={theme} onToggleTheme={toggleTheme} onLogout={() => void logout()} />}
    </MotionConfig>
  );
}

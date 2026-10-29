import { motion, useAnimate } from "motion/react";
import { useState, type FormEvent } from "react";
import { api, ApiError } from "./api";
import { IconEye, IconEyeOff, IconLock } from "./icons";

export function Login({ onLogin, notice }: { onLogin: (email: string) => void; notice?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [card, animate] = useAnimate<HTMLDivElement>();

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.login(email.trim(), password);
      setPassword("");
      onLogin(r.email);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не удалось войти");
      setPassword("");
      setBusy(false);
      void animate(card.current, { x: [0, -9, 8, -5, 3, 0] }, { duration: 0.42 }); // лёгкое покачивание при ошибке
    }
  }

  return (
    <main className="login">
      <div className="orb o1" /><div className="orb o2" /><div className="orb o3" />
      <motion.div className="login-wrap" initial={{ opacity: 0, y: 22, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 240, damping: 26 }}>
        <div ref={card} className="login-card">
          <div className="login-brand">
            <span className="logo" aria-hidden="true">DV</span>
            <div><h1>DVMail</h1><p>Личная защищённая почта</p></div>
          </div>
          {notice && <p className="notice" role="status">{notice}</p>}
          <form onSubmit={submit} noValidate>
            <label htmlFor="email">Адрес почты</label>
            <input id="email" type="email" autoComplete="username" inputMode="email" placeholder="name@example.org" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
            <label htmlFor="password">Пароль</label>
            <div className="pw">
              <input id="password" type={show ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <button type="button" className="icon-btn" onClick={() => setShow((s) => !s)} aria-label={show ? "Скрыть пароль" : "Показать пароль"} title={show ? "Скрыть пароль" : "Показать пароль"}>
                {show ? <IconEyeOff /> : <IconEye />}
              </button>
            </div>
            <p className="error" role="alert" aria-live="assertive">{error}</p>
            <motion.button className="btn primary block" type="submit" disabled={busy || !email || !password} whileTap={{ scale: 0.98 }}>
              {busy ? <span className="spinner" aria-hidden="true" /> : <IconLock />}{busy ? "Входим…" : "Войти"}
            </motion.button>
          </form>
          <p className="hint">Если у ящика включена двухфакторная защита, входите паролем приложения: его создают в личном кабинете почты.</p>
        </div>
      </motion.div>
    </main>
  );
}

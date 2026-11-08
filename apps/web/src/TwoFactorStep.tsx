import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Challenge } from "./api";
import { ChallengePanel } from "./ChallengePanel";

interface Props {
  methods: string[];
  onLogin: (email: string) => void;
  onCancel: () => void;
}

// Второй шаг входа: подтверждение в DVChat (основной способ) или код из приложения / запасной код.
export function TwoFactorStep({ methods, onLogin, onCancel }: Props) {
  const chat = methods.includes("chat");
  const codes = methods.includes("totp") || methods.includes("recovery");
  const [mode, setMode] = useState<"chat" | "code">(chat ? "chat" : "code");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0); // новый номер: показать новый QR

  useEffect(() => {
    if (mode !== "chat") return;
    let alive = true;
    setChallenge(null);
    setError(null);
    api.twoFactorChatStart().then((c) => { if (alive) setChallenge(c); }).catch((e) => {
      if (!alive) return;
      setError(e instanceof ApiError ? e.message : "Не удалось запросить подтверждение");
      if (codes) setMode("code");
    });
    return () => { alive = false; };
  }, [mode, round, codes]);

  const poll = useCallback(async () => {
    const r = await api.twoFactorChatStatus();
    if (r.state === "approved" && r.email) { onLogin(r.email); return "done" as const; }
    return r.state === "failed" ? ("failed" as const) : ("pending" as const);
  }, [onLogin]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onLogin((await api.twoFactorCode(code.trim())).email);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось проверить код");
      setBusy(false);
    }
  }

  async function back() {
    try { await api.twoFactorCancel(); } catch { /* ожидание всё равно истечёт само */ }
    onCancel();
  }

  return (
    <div className="step2">
      <h2>Подтвердите вход</h2>
      {mode === "chat" ? (
        <>
          {error && <p className="error" role="alert">{error}</p>}
          {challenge ? (
            <ChallengePanel challenge={challenge} poll={poll} onRetry={() => setRound((n) => n + 1)} intro="В приложении DVChat откройте сканер и наведите на код." />
          ) : !error ? <div className="step2-wait"><span className="spinner big" aria-label="Загрузка" /></div> : null}
          {codes && <p className="step2-link"><button type="button" className="link-btn" onClick={() => setMode("code")}>Ввести код вручную</button></p>}
        </>
      ) : (
        <form onSubmit={submit} noValidate>
          <label htmlFor="code2">Код из приложения-аутентификатора или запасной код</label>
          <input id="code2" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode="text" autoCapitalize="characters" autoCorrect="off" spellCheck={false} placeholder="123456 или XXXX-XXXX-XXXX" autoFocus required />
          <p className="error" role="alert" aria-live="assertive">{error ?? ""}</p>
          <button className="btn primary block" type="submit" disabled={busy || !code.trim()}>{busy ? <span className="spinner" aria-hidden="true" /> : null}{busy ? "Проверяем…" : "Подтвердить"}</button>
          {chat && <p className="step2-link"><button type="button" className="link-btn" onClick={() => setMode("chat")}>Подтвердить в DVChat</button></p>}
        </form>
      )}
      <p className="step2-link"><button type="button" className="link-btn muted-link" onClick={() => void back()}>Назад</button></p>
    </div>
  );
}

import { motion } from "motion/react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, type Challenge, type FactorStatus } from "./api";
import { ChallengePanel } from "./ChallengePanel";
import { IconAlert, IconShield, IconX } from "./icons";
import { QrCode } from "./QrCode";

// Пароль (а если включены коды из приложения, то и код) перед опасным действием.
function Confirm({ needCode, label, onSubmit, onCancel }: { needCode: boolean; label: string; onSubmit: (password: string, code?: string) => Promise<void>; onCancel: () => void }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await onSubmit(password, needCode ? code.trim() : undefined); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Не получилось"); setBusy(false); }
  }
  return (
    <form className="sec-form" onSubmit={submit}>
      <label htmlFor="sec-pw">Ваш пароль приложения</label>
      <input id="sec-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />
      {needCode && <>
        <label htmlFor="sec-code">Код из приложения или запасной код</label>
        <input id="sec-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoCorrect="off" spellCheck={false} required />
      </>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="sec-row">
        <button type="submit" className="btn primary small" disabled={busy || !password}>{busy && <span className="spinner" aria-hidden="true" />}{label}</button>
        <button type="button" className="btn ghost small" onClick={onCancel}>Отмена</button>
      </div>
    </form>
  );
}

// Запасные коды показываются один раз: их надо сохранить сразу.
function RecoveryCodes({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { /* буфер недоступен: остаётся «Скачать» */ }
  }
  function save() {
    const url = URL.createObjectURL(new Blob([`Запасные коды DVMail (каждый работает один раз)\n\n${text}\n`], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url; a.download = "dvmail-zapasnye-kody.txt"; a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="warn-box recovery">
      <p><strong>Сохраните запасные коды. Сервер больше их не покажет.</strong></p>
      <p className="muted">Каждый код работает один раз. Они нужны, если телефон потерян или DVChat недоступен.</p>
      <ul className="codes" aria-label="Запасные коды">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
      <div className="sec-row">
        <button type="button" className="btn ghost small" onClick={() => void copy()}>{copied ? "Скопировано" : "Скопировать"}</button>
        <button type="button" className="btn ghost small" onClick={save}>Скачать файл</button>
        <button type="button" className="btn primary small" onClick={onClose}>Я сохранил(а)</button>
      </div>
    </div>
  );
}

function Card({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section className="sec-card">
      <h3>{title}</h3>
      <p className="muted">{note}</p>
      <div className="sec-body">{children}</div>
    </section>
  );
}

export function SecurityPanel({ onClose }: { onClose: () => void }) {
  const [st, setSt] = useState<FactorStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [flow, setFlow] = useState<"link" | "unlink" | "totp" | "totp-off" | "new-codes" | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [totp, setTotp] = useState<{ secret: string; uri: string } | null>(null);
  const [first, setFirst] = useState("");
  const [firstError, setFirstError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.security().then((s) => { setSt(s); setLoadError(null); }, (e) => setLoadError(e instanceof ApiError ? e.message : "Не удалось загрузить"));
  }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onClose]);

  const close = () => { setFlow(null); setChallenge(null); setTotp(null); setFirst(""); setFirstError(null); };
  const finish = (newCodes?: string[] | null) => { close(); if (newCodes && newCodes.length) setCodes(newCodes); refresh(); };

  async function enableTotp(e: FormEvent) {
    e.preventDefault();
    setFirstError(null);
    try { finish((await api.totpEnable(first.trim())).recoveryCodes); }
    catch (err) { setFirstError(err instanceof ApiError ? err.message : "Не получилось"); }
  }

  const needCode = !!st?.totpEnabled;
  let body: ReactNode;
  if (loadError) body = <p className="error" role="alert">{loadError} <button type="button" className="link-btn" onClick={refresh}>Повторить</button></p>;
  else if (!st) body = <div className="sec-wait"><span className="spinner big" aria-label="Загрузка" /></div>;
  else if (!st.available) body = <p className="muted">Второй фактор входа не подключён на этом сервере.</p>;
  else body = (
    <>
      <p className={"sec-state " + (st.enabled ? "ok" : "warn")} role="status">
        {st.enabled ? <IconShield /> : <IconAlert />}
        {st.enabled ? "Вход защищён вторым фактором" : "Второй фактор выключен: вход только по паролю"}
      </p>
      {codes && <RecoveryCodes codes={codes} onClose={() => setCodes(null)} />}

      <Card title="Подтверждение в DVChat" note="Основной способ. При входе покажем QR-код, вы сканируете его в приложении и вводите число.">
        {!st.chatAvailable ? <p className="muted">Не настроено на сервере.</p>
          : flow === "link" ? (
            challenge ? (
              <ChallengePanel challenge={challenge} intro="В приложении DVChat откройте сканер и наведите на код." onRetry={() => setChallenge(null)} poll={async () => {
                const r = await api.chatLinkStatus();
                if (r.state === "approved") { finish(r.recoveryCodes); return "done"; }
                return r.state === "failed" ? "failed" : "pending";
              }} />
            ) : <Confirm needCode={needCode} label="Показать QR-код" onCancel={close} onSubmit={async (p, c) => setChallenge(await api.chatLinkStart(p, c))} />
          ) : flow === "unlink" ? <Confirm needCode={needCode} label="Отвязать" onCancel={close} onSubmit={async (p, c) => { await api.chatUnlink(p, c); finish(); }} />
          : st.chatLinked ? (
            <div className="sec-row"><span>Привязан: <code>{st.matrixId}</code></span><button type="button" className="btn ghost small" onClick={() => setFlow("unlink")}>Отвязать</button></div>
          ) : <button type="button" className="btn primary small" onClick={() => setFlow("link")}>Привязать DVChat</button>}
      </Card>

      <Card title="Коды из приложения" note="Запасной способ: Google Authenticator, Aegis, 2FAS и подобные. Работает без DVChat.">
        {!st.totpAvailable ? <p className="muted">Не настроено на сервере.</p>
          : flow === "totp" ? (
            totp ? (
              <form className="sec-form" onSubmit={enableTotp}>
                <p className="muted">Отсканируйте код в приложении-аутентификаторе, затем введите шестизначный код оттуда.</p>
                <div className="sec-qr"><QrCode value={totp.uri} label="QR-код для приложения-аутентификатора" size={176} /></div>
                <p className="muted">Не получается сканировать? Введите ключ вручную:</p>
                <p className="secret-key">{totp.secret.replace(/(.{4})/g, "$1 ").trim()}</p>
                <label htmlFor="sec-first">Код из приложения</label>
                <input id="sec-first" value={first} onChange={(e) => setFirst(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}" placeholder="123456" required autoFocus />
                {firstError && <p className="error" role="alert">{firstError}</p>}
                <div className="sec-row"><button type="submit" className="btn primary small" disabled={first.trim().length !== 6}>Включить</button><button type="button" className="btn ghost small" onClick={close}>Отмена</button></div>
              </form>
            ) : <Confirm needCode={false} label="Продолжить" onCancel={close} onSubmit={async (p) => setTotp(await api.totpBegin(p))} />
          ) : flow === "totp-off" ? <Confirm needCode={needCode} label="Выключить" onCancel={close} onSubmit={async (p, c) => { await api.totpDisable(p, c); finish(); }} />
          : st.totpEnabled ? (
            <div className="sec-row"><span>Включены</span><button type="button" className="btn ghost small" onClick={() => setFlow("totp-off")}>Выключить</button></div>
          ) : <button type="button" className="btn primary small" onClick={() => setFlow("totp")}>Включить коды из приложения</button>}
      </Card>

      {st.enabled && (
        <Card title="Запасные коды" note="Одноразовые коды на случай, если телефон потерян или DVChat недоступен.">
          {flow === "new-codes"
            ? <Confirm needCode={needCode} label="Выпустить новые" onCancel={close} onSubmit={async (p, c) => { finish((await api.recoveryNew(p, c)).recoveryCodes); }} />
            : <div className="sec-row"><span>Осталось: {st.recoveryLeft ?? 0}</span><button type="button" className="btn ghost small" onClick={() => setFlow("new-codes")}>Выпустить новые</button></div>}
        </Card>
      )}
      <p className="hint">Почтовые программы на телефоне и компьютере (IMAP и SMTP) входят по паролю приложения, как и раньше: второй фактор защищает вход в веб-почту.</p>
    </>
  );

  return (
    <div className="compose-layer">
      <motion.div className="compose-backdrop" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} aria-hidden="true" />
      <motion.div className="compose sec-dialog" role="dialog" aria-modal="true" aria-label="Безопасность" initial={{ opacity: 0, y: 28, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 20, scale: 0.98 }} transition={{ type: "spring", stiffness: 320, damping: 32 }}>
        <div className="c-head"><h2>Безопасность</h2><button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть" title="Закрыть"><IconX /></button></div>
        <div className="sec-scroll">{body}</div>
      </motion.div>
    </div>
  );
}

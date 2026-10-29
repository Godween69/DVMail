import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { api, ApiError, type Identity } from "./api";
import { isDirty, parseAddresses, type Draft } from "./compose";
import { IconAlert, IconSend, IconX } from "./icons";

interface Props {
  identities: Identity[]; initial: Draft; identityId: string; note: string | null;
  onClose: () => void; onSent: (filed: boolean) => void;
}

const TITLES = { new: "Новое письмо", reply: "Ответ", replyAll: "Ответ всем", forward: "Пересылка" } as const;

// Окно написания письма. Текст живёт только здесь, в памяти страницы: на сервер он попадает лишь при отправке.
export function Compose({ identities, initial, identityId, note, onClose, onSent }: Props) {
  const [d, setD] = useState<Draft>(initial);
  const [from, setFrom] = useState(identityId);
  const [showCc, setShowCc] = useState(!!initial.cc);
  const [showBcc, setShowBcc] = useState(!!initial.bcc);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askClose, setAskClose] = useState(false);
  const [askNoSubject, setAskNoSubject] = useState(false);
  const toRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const set = (k: keyof Draft) => (v: string) => { setD((x) => ({ ...x, [k]: v })); setError(null); setAskNoSubject(false); };

  // При открытии: если адрес уже стоит (ответ), ставим курсор в начало текста над цитатой, иначе в поле «Кому»
  useEffect(() => {
    if (initial.to) { const t = textRef.current; if (t) { t.focus(); t.setSelectionRange(0, 0); t.scrollTop = 0; } }
    else toRef.current?.focus();
  }, [initial.to]);

  function tryClose() {
    if (sending) return;
    if (isDirty(d, initial)) setAskClose(true); else onClose();
  }

  async function submit() {
    if (sending) return;
    const to = parseAddresses(d.to), cc = parseAddresses(d.cc), bcc = parseAddresses(d.bcc);
    const bad = [...to.bad, ...cc.bad, ...bcc.bad];
    if (bad.length) return setError(`Не похоже на адрес: ${bad.slice(0, 3).join(", ")}`);
    if (to.ok.length + cc.ok.length + bcc.ok.length === 0) return setError("Укажите хотя бы одного получателя");
    if (to.ok.length + cc.ok.length + bcc.ok.length > 50) return setError("Слишком много получателей: до 50");
    if (!d.subject.trim() && !askNoSubject) { setAskNoSubject(true); return; }
    setSending(true); setError(null);
    try {
      const r = await api.send({ identityId: from, to: to.ok, cc: cc.ok, bcc: bcc.ok, subject: d.subject, text: d.text, replyTo: d.replyTo });
      onSent(r.filed);
    } catch (e) {
      setSending(false);
      setError(e instanceof ApiError ? e.message : "Не удалось отправить письмо");
    }
  }

  // Горячие клавиши слушаем на всём окне: после нажатия кнопок фокус может оказаться вне окна письма
  const keysRef = useRef<(ev: globalThis.KeyboardEvent) => void>(() => {});
  keysRef.current = (ev) => {
    if (ev.key === "Escape") { ev.preventDefault(); if (askClose) setAskClose(false); else tryClose(); }
    else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); void submit(); }
  };
  useEffect(() => {
    const f = (ev: globalThis.KeyboardEvent) => keysRef.current(ev);
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);

  return (
    <div className="compose-layer">
      <motion.div className="compose-backdrop" onClick={tryClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} aria-hidden="true" />
      <motion.div className="compose" role="dialog" aria-modal="true" aria-label={TITLES[d.mode]} initial={{ opacity: 0, y: 24, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16 }} transition={{ type: "spring", stiffness: 380, damping: 32 }}>
        <header className="c-head">
          <h2>{TITLES[d.mode]}</h2>
          <button className="icon-btn tiny" onClick={tryClose} aria-label="Закрыть" title="Закрыть"><IconX /></button>
        </header>

        <div className="c-fields">
          <div className="c-row">
            <label htmlFor={id + "f"}>От</label>
            {identities.length > 1 ? (
              <select id={id + "f"} value={from} onChange={(e) => setFrom(e.target.value)} disabled={sending}>
                {identities.map((i) => <option key={i.id} value={i.id}>{i.name ? `${i.name} <${i.email}>` : i.email}</option>)}
              </select>
            ) : <span className="c-static">{identities[0] ? (identities[0].name ? `${identities[0].name} <${identities[0].email}>` : identities[0].email) : "—"}</span>}
          </div>
          <div className="c-row">
            <label htmlFor={id + "t"}>Кому</label>
            <input id={id + "t"} ref={toRef} value={d.to} onChange={(e) => set("to")(e.target.value)} disabled={sending} autoComplete="off" spellCheck={false} maxLength={4000} placeholder="адрес, можно несколько через запятую" />
            <span className="c-more">
              {!showCc && <button type="button" className="link-btn" onClick={() => setShowCc(true)}>Копия</button>}
              {!showBcc && <button type="button" className="link-btn" onClick={() => setShowBcc(true)}>Скрытая</button>}
            </span>
          </div>
          {showCc && (
            <div className="c-row"><label htmlFor={id + "c"}>Копия</label>
              <input id={id + "c"} value={d.cc} onChange={(e) => set("cc")(e.target.value)} disabled={sending} autoComplete="off" spellCheck={false} maxLength={4000} /></div>
          )}
          {showBcc && (
            <div className="c-row"><label htmlFor={id + "b"}>Скрытая</label>
              <input id={id + "b"} value={d.bcc} onChange={(e) => set("bcc")(e.target.value)} disabled={sending} autoComplete="off" spellCheck={false} maxLength={4000} placeholder="получатели не увидят этот адрес друг у друга" /></div>
          )}
          <div className="c-row">
            <label htmlFor={id + "s"}>Тема</label>
            <input id={id + "s"} value={d.subject} onChange={(e) => set("subject")(e.target.value)} disabled={sending} maxLength={300} />
          </div>
        </div>

        {note && <div className="banner c-note"><IconAlert width={16} height={16} /> {note}</div>}
        <textarea ref={textRef} className="c-text" value={d.text} onChange={(e) => set("text")(e.target.value)} disabled={sending} maxLength={100000} aria-label="Текст письма" placeholder="Текст письма" />

        <AnimatePresence initial={false}>
          {(error || askNoSubject) && (
            <motion.div className="c-msg" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} role="alert">
              {error ? <span className="err-text">{error}</span> : <span>У письма нет темы. Отправить без темы?</span>}
            </motion.div>
          )}
        </AnimatePresence>

        <footer className="c-foot">
          {askClose ? (
            <div className="c-ask">
              <span>Закрыть без отправки? Текст пропадёт.</span>
              <span className="acts"><button className="btn danger small" onClick={onClose}>Закрыть</button><button className="btn ghost small" onClick={() => setAskClose(false)}>Продолжить писать</button></span>
            </div>
          ) : (
            <>
              <button className="btn primary small" onClick={() => void submit()} disabled={sending}>
                {sending ? <><span className="spinner" aria-hidden="true" /> Отправляю…</> : <><IconSend width={16} height={16} /> {askNoSubject ? "Всё равно отправить" : "Отправить"}</>}
              </button>
              <button className="btn ghost small" onClick={tryClose} disabled={sending}>Отмена</button>
              <span className="grow" />
              <span className="muted c-hint">Ctrl+Enter, чтобы отправить</span>
            </>
          )}
        </footer>
      </motion.div>
    </div>
  );
}

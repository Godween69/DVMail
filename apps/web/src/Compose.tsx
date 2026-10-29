import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { AddressField } from "./AddressField";
import { api, ApiError, type Attachment, type Contact, type Identity, type Limits } from "./api";
import { checkAdd, mb, PARALLEL, sendBlocker, usedBytes, type AttItem } from "./attachments";
import { isDirty, parseAddresses, type Draft } from "./compose";
import { fileSize } from "./format";
import { IconAlert, IconClip, IconSend, IconX } from "./icons";

interface Props {
  identities: Identity[]; initial: Draft; identityId: string; limits: Limits; keepFiles: Attachment[];
  onClose: () => void; onSent: (filed: boolean) => void;
}

const TITLES = { new: "Новое письмо", reply: "Ответ", replyAll: "Ответ всем", forward: "Пересылка" } as const;
const hasFiles = (e: DragEvent | globalThis.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

// Окно написания письма. Текст живёт только здесь, в памяти страницы: на сервер он попадает лишь при отправке.
// Вложения загружаются на сервер сразу при выборе (с полоской хода), в письмо уходят их идентификаторы.
export function Compose({ identities, initial, identityId, limits, keepFiles, onClose, onSent }: Props) {
  const [d, setD] = useState<Draft>(initial);
  const [from, setFrom] = useState(identityId);
  const [showCc, setShowCc] = useState(!!initial.cc);
  const [showBcc, setShowBcc] = useState(!!initial.bcc);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askClose, setAskClose] = useState(false);
  const [askNoSubject, setAskNoSubject] = useState(false);
  const [drag, setDrag] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]); // подсказки адресов; нет ответа: просто без подсказок
  // вложения пересылаемого письма уже на сервере: сразу в списке как готовые
  const [items, setItems] = useState<AttItem[]>(() =>
    keepFiles.map((a, i) => ({ key: "k" + i, name: a.name, size: a.size, state: "done" as const, progress: 1, blobId: a.blobId, keep: true })));
  const toRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const files = useRef(new Map<string, File>());       // выбранные файлы, ждущие или идущие на загрузку
  const aborts = useRef(new Map<string, () => void>()); // отмена идущих загрузок
  const started = useRef(new Set<string>());
  const dragDepth = useRef(0);
  const counter = useRef(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const sentRef = useRef(false);
  const id = useId();
  const set = (k: keyof Draft) => (v: string) => { setD((x) => ({ ...x, [k]: v })); setError(null); setAskNoSubject(false); };
  const patch = (key: string, p: Partial<AttItem>) => setItems((x) => x.map((i) => (i.key === key ? { ...i, ...p } : i)));

  // При открытии: если адрес уже стоит (ответ), ставим курсор в начало текста над цитатой, иначе в поле «Кому»
  useEffect(() => {
    if (initial.to) { const t = textRef.current; if (t) { t.focus(); t.setSelectionRange(0, 0); t.scrollTop = 0; } }
    else toRef.current?.focus();
  }, [initial.to]);

  useEffect(() => {
    let alive = true;
    api.contacts().then((c) => { if (alive) setContacts(c); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // ---- Вложения
  function startUpload(key: string) {
    const file = files.current.get(key);
    if (!file || started.current.has(key)) return;
    started.current.add(key);
    patch(key, { state: "uploading", progress: 0 });
    const u = api.upload(file, (f) => patch(key, { progress: f }));
    aborts.current.set(key, u.abort);
    u.promise
      .then((r) => patch(key, { state: "done", progress: 1, blobId: r.blobId, name: r.name }))
      .catch((e: unknown) => { if (!(e instanceof ApiError && e.status === -1)) patch(key, { state: "error", error: e instanceof ApiError ? e.message : "Не удалось загрузить файл" }); })
      .finally(() => { aborts.current.delete(key); files.current.delete(key); });
  }

  // Очередь: не больше PARALLEL загрузок одновременно (столько принимает сервер)
  useEffect(() => {
    let slots = PARALLEL - items.filter((i) => i.state === "uploading").length;
    for (const it of items) if (it.state === "waiting" && slots > 0) { slots--; startUpload(it.key); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  function addFiles(list: File[]) {
    if (sending || list.length === 0) return;
    const next = [...itemsRef.current];
    for (const f of list) {
      const key = "u" + ++counter.current;
      const why = checkAdd(f, next, limits);
      if (why) next.push({ key, name: f.name || "файл", size: f.size, state: "error", progress: 0, error: why });
      else { files.current.set(key, f); next.push({ key, name: f.name || "файл", size: f.size, state: "waiting", progress: 0 }); }
    }
    setItems(next);
    setError(null);
  }

  function removeItem(it: AttItem) {
    aborts.current.get(it.key)?.();
    files.current.delete(it.key);
    started.current.add(it.key); // удалённый ожидающий файл больше не стартует
    if (it.state === "done" && it.blobId && !it.keep) void api.removeFile(it.blobId).catch(() => {});
    setItems((x) => x.filter((i) => i.key !== it.key));
    setError(null);
  }

  // Закрыли окно: идущие загрузки прерываем, неотправленные файлы убираем с сервера (по возможности)
  useEffect(() => () => {
    for (const abort of aborts.current.values()) abort();
    if (!sentRef.current) for (const i of itemsRef.current) if (i.state === "done" && i.blobId && !i.keep) void api.removeFile(i.blobId).catch(() => {});
  }, []);

  // Файл, брошенный мимо окна, не должен открываться вместо письма
  useEffect(() => {
    const stop = (e: globalThis.DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => { window.removeEventListener("dragover", stop); window.removeEventListener("drop", stop); };
  }, []);

  const onDragEnter = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current++; setDrag(true); };
  const onDragOver = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
  const onDragLeave = (e: DragEvent) => { if (!hasFiles(e)) return; if (--dragDepth.current <= 0) { dragDepth.current = 0; setDrag(false); } };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth.current = 0; setDrag(false);
    addFiles(Array.from(e.dataTransfer.files));
  };
  const onPaste = (e: ClipboardEvent) => {
    const fs = Array.from(e.clipboardData.files);
    if (fs.length > 0) { e.preventDefault(); addFiles(fs); }
  };

  function tryClose() {
    if (sending) return;
    if (isDirty(d, initial) || items.some((i) => !i.keep)) setAskClose(true); else onClose();
  }

  async function submit() {
    if (sending) return;
    const to = parseAddresses(d.to), cc = parseAddresses(d.cc), bcc = parseAddresses(d.bcc);
    const bad = [...to.bad, ...cc.bad, ...bcc.bad];
    if (bad.length) return setError(`Не похоже на адрес: ${bad.slice(0, 3).join(", ")}`);
    if (to.ok.length + cc.ok.length + bcc.ok.length === 0) return setError("Укажите хотя бы одного получателя");
    if (to.ok.length + cc.ok.length + bcc.ok.length > 50) return setError("Слишком много получателей: до 50");
    const blocker = sendBlocker(items);
    if (blocker) return setError(blocker);
    if (!d.subject.trim() && !askNoSubject) { setAskNoSubject(true); return; }
    setSending(true); setError(null);
    try {
      const own = items.filter((i) => !i.keep && i.blobId).map((i) => i.blobId as string);
      const keep = items.filter((i) => i.keep && i.blobId).map((i) => i.blobId as string);
      const r = await api.send({
        identityId: from, to: to.ok, cc: cc.ok, bcc: bcc.ok, subject: d.subject, text: d.text, replyTo: d.replyTo,
        attachments: own, forwardOf: keep.length ? d.forwardOf : null, keep,
      });
      sentRef.current = true;
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

  const shown = items.filter((i) => i.state !== "error").length;
  const used = usedBytes(items);

  return (
    <div className="compose-layer">
      <motion.div className="compose-backdrop" onClick={tryClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} aria-hidden="true" />
      <motion.div
        className="compose" role="dialog" aria-modal="true" aria-label={TITLES[d.mode]}
        onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
        initial={{ opacity: 0, y: 24, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16 }} transition={{ type: "spring", stiffness: 380, damping: 32 }}
      >
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
            <AddressField id={id + "t"} inputRef={toRef} value={d.to} onChange={set("to")} contacts={contacts} disabled={sending} maxLength={4000} placeholder="адрес, можно несколько через запятую" />
            <span className="c-more">
              {!showCc && <button type="button" className="link-btn" onClick={() => setShowCc(true)}>Копия</button>}
              {!showBcc && <button type="button" className="link-btn" onClick={() => setShowBcc(true)}>Скрытая</button>}
            </span>
          </div>
          {showCc && (
            <div className="c-row"><label htmlFor={id + "c"}>Копия</label>
              <AddressField id={id + "c"} value={d.cc} onChange={set("cc")} contacts={contacts} disabled={sending} maxLength={4000} /></div>
          )}
          {showBcc && (
            <div className="c-row"><label htmlFor={id + "b"}>Скрытая</label>
              <AddressField id={id + "b"} value={d.bcc} onChange={set("bcc")} contacts={contacts} disabled={sending} maxLength={4000} placeholder="получатели не увидят этот адрес друг у друга" /></div>
          )}
          <div className="c-row">
            <label htmlFor={id + "s"}>Тема</label>
            <input id={id + "s"} value={d.subject} onChange={(e) => set("subject")(e.target.value)} disabled={sending} maxLength={300} />
          </div>
        </div>

        <textarea ref={textRef} className="c-text" value={d.text} onChange={(e) => set("text")(e.target.value)} onPaste={onPaste} disabled={sending} maxLength={100000} aria-label="Текст письма" placeholder="Текст письма" />

        {items.length > 0 && (
          <div className="c-attach">
            <div className="c-attach-head muted">Вложения: {shown} · {fileSize(used)} из {mb(limits.total)}</div>
            <ul className="c-files">
              {items.map((it) => (
                <li key={it.key} className={"c-file " + it.state}>
                  <IconClip width={15} height={15} />
                  <span className="c-fname" title={it.name}>{it.name}</span>
                  <span className="muted c-fsize">{fileSize(it.size)}</span>
                  {(it.state === "uploading" || it.state === "waiting") && (
                    <span className="c-bar" role="progressbar" aria-label={`Загрузка ${it.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(it.progress * 100)}>
                      <i style={{ width: `${Math.round(it.progress * 100)}%` }} />
                    </span>
                  )}
                  {it.state === "waiting" && <span className="muted c-fnote">ждёт очереди</span>}
                  {it.state === "error" && <span className="err-text c-ferr">{it.error}</span>}
                  <button className="icon-btn tiny" onClick={() => removeItem(it)} disabled={sending} aria-label={`Убрать ${it.name}`} title="Убрать"><IconX /></button>
                </li>
              ))}
            </ul>
          </div>
        )}

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
              <span>Закрыть без отправки? Текст и файлы пропадут.</span>
              <span className="acts"><button className="btn danger small" onClick={onClose}>Закрыть</button><button className="btn ghost small" onClick={() => setAskClose(false)}>Продолжить писать</button></span>
            </div>
          ) : (
            <>
              <button className="btn primary small" onClick={() => void submit()} disabled={sending}>
                {sending ? <><span className="spinner" aria-hidden="true" /> Отправляю…</> : <><IconSend width={16} height={16} /> {askNoSubject ? "Всё равно отправить" : "Отправить"}</>}
              </button>
              <button className="btn ghost small" onClick={() => pickRef.current?.click()} disabled={sending} title="Прикрепить файлы (можно перетащить в окно или вставить из буфера)">
                <IconClip width={16} height={16} /> Прикрепить
              </button>
              <input ref={pickRef} type="file" multiple hidden aria-label="Выбор файлов" onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
              <button className="btn ghost small" onClick={tryClose} disabled={sending}>Отмена</button>
              <span className="grow" />
              <span className="muted c-hint">Ctrl+Enter, чтобы отправить</span>
            </>
          )}
        </footer>

        {drag && <div className="c-drop" aria-hidden="true"><span>Отпустите, чтобы прикрепить файлы</span></div>}
      </motion.div>
    </div>
  );
}

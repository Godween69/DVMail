import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { api, type Addr, type EmailFull } from "./api";
import { fileSize, fullDate, initial, tone, who } from "./format";
import { IconAlert, IconBack, IconClip, IconCopy, IconDownload, IconExternal, IconFile, IconForward, IconLink, IconLock, IconMail, IconMailOpen, IconReply, IconReplyAll, IconTrash } from "./icons";
import { frameDoc, prepareHtml, textLinks, type LinkInfo } from "./safe-html";

interface Props {
  selected: boolean; mail: EmailFull | null; loading: boolean; error: string | null; inTrash: boolean; narrow: boolean;
  onReply: () => void; onReplyAll: () => void; onForward: () => void;
  onBack: () => void; onToggleSeen: () => void; onTrash: () => void; onRetry: () => void; onCopied: (ok: boolean) => void;
}

const people = (list: Addr[]) => list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ");

export function Reader(p: Props) {
  return (
    <section className="reader-panel" aria-label="Письмо">
      <AnimatePresence mode="wait" initial={false}>
        {!p.selected ? (
          <motion.div key="empty" className="reader-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            <span className="state-ico big"><IconMail width={38} height={38} /></span>
            <p>Выберите письмо, чтобы прочитать</p>
          </motion.div>
        ) : p.error ? (
          <motion.div key="err" className="reader-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {p.narrow && <button className="btn ghost small back-abs" onClick={p.onBack}><IconBack /> Назад</button>}
            <p>{p.error}</p><button className="btn ghost small" onClick={p.onRetry}>Повторить</button>
          </motion.div>
        ) : p.loading || !p.mail ? (
          <motion.div key="load" className="reader-skel" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            {p.narrow && <button className="btn ghost small" onClick={p.onBack}><IconBack /> Назад</button>}
            <i className="w60" /><i className="w40" /><i className="w90" /><i className="w80" /><i className="w70" />
          </motion.div>
        ) : (
          <Message key={p.mail.id} {...p} mail={p.mail} />
        )}
      </AnimatePresence>
    </section>
  );
}

function Message(p: Props & { mail: EmailFull }) {
  const m = p.mail;
  const hasHtml = m.html.trim().length > 0;
  const hasText = m.text.trim().length > 0;
  const [view, setView] = useState<"styled" | "text">(hasHtml ? "styled" : "text");
  const [confirm, setConfirm] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  useEffect(() => { setConfirm(false); }, [m.id]);

  // Очистка выполняется один раз на письмо
  const prepared = useMemo(() => (hasHtml ? prepareHtml(m.html) : null), [m.id, m.html, hasHtml]);
  const links: LinkInfo[] = useMemo(() => (prepared ? prepared.links : textLinks(m.text)), [prepared, m.text]);
  const danger = links.some((l) => l.mismatch);
  const showLinks = !m.encrypted && links.length > 0;

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); p.onCopied(true); } catch { p.onCopied(false); }
  }

  return (
    <motion.article className="mail" initial={{ opacity: 0, x: p.narrow ? 36 : 0, y: p.narrow ? 0 : 10 }} animate={{ opacity: 1, x: 0, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.1 } }} transition={{ type: "spring", stiffness: 340, damping: 32 }}>
      <header className="mail-head">
        <div className="toolbar">
          {p.narrow && <button className="btn ghost small" onClick={p.onBack}><IconBack /> Назад</button>}
          <button className="btn ghost small" onClick={p.onReply} title="Ответить"><IconReply /><span className="lbl">Ответить</span></button>
          <button className="btn ghost small" onClick={p.onReplyAll} title="Ответить всем"><IconReplyAll /><span className="lbl">Всем</span></button>
          <button className="btn ghost small" onClick={p.onForward} title="Переслать"><IconForward /><span className="lbl">Переслать</span></button>
          <span className="grow" />
          <motion.button className="btn ghost small" onClick={p.onToggleSeen} whileTap={{ scale: 0.96 }} title={m.unread ? "Отметить прочитанным" : "Отметить непрочитанным"}>
            {m.unread ? <><IconMailOpen /><span className="lbl">Прочитано</span></> : <><IconMail /><span className="lbl">Не прочитано</span></>}
          </motion.button>
          <a className="btn ghost small" href={api.rawUrl(m.id)} title="Скачать письмо целиком (.eml)"><IconDownload /><span className="lbl">Скачать</span></a>
          <motion.button className="btn ghost small warn" onClick={() => (p.inTrash ? setConfirm(true) : p.onTrash())} whileTap={{ scale: 0.96 }} title="Удалить письмо">
            <IconTrash /><span className="lbl">Удалить</span>
          </motion.button>
        </div>
        <AnimatePresence initial={false}>
          {confirm && (
            <motion.div className="confirm" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
              <div className="confirm-in">
                <span>Удалить письмо навсегда? Восстановить его будет нельзя.</span>
                <span className="acts"><button className="btn danger small" onClick={p.onTrash}>Удалить навсегда</button><button className="btn ghost small" onClick={() => setConfirm(false)}>Отмена</button></span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <h1 className="subject">{m.subject || "(без темы)"}</h1>
        <div className="meta">
          <span className={"avatar big tone" + tone(m.from?.email ?? "")} aria-hidden="true">{initial(m.from)}</span>
          <div className="meta-text">
            <div className="from"><strong>{who(m.from)}</strong>{m.from?.name && <span className="muted"> &lt;{m.from.email}&gt;</span>}</div>
            <div className="muted small-line" title={people(m.to)}>кому: {people(m.to) || "—"}</div>
            {m.cc.length > 0 && <div className="muted small-line" title={people(m.cc)}>копия: {people(m.cc)}</div>}
          </div>
          <time className="muted when" dateTime={m.receivedAt}>{fullDate(m.receivedAt)}</time>
        </div>
      </header>

      {m.encrypted ? (
        <div className="locked">
          <span className="state-ico big"><IconLock width={34} height={34} /></span>
          <h3>Письмо зашифровано</h3>
          <p>Расшифровка в браузере появится в следующей версии. Пока письмо можно скачать целиком.</p>
          <a className="btn primary small" href={api.rawUrl(m.id)}><IconDownload /> Скачать письмо</a>
        </div>
      ) : (
        <div className="body">
          {hasHtml && hasText && (
            <div className="seg" role="tablist" aria-label="Вид письма">
              <button role="tab" aria-selected={view === "styled"} className={view === "styled" ? "on" : ""} onClick={() => setView("styled")}>Оформление</button>
              <button role="tab" aria-selected={view === "text"} className={view === "text" ? "on" : ""} onClick={() => setView("text")}>Текст</button>
            </div>
          )}
          {prepared && prepared.blockedImages > 0 && view === "styled" && (
            <div className="banner"><IconAlert width={16} height={16} /> Внешние картинки отключены: они могут выдать, что письмо открыто.</div>
          )}
          {m.truncated && <div className="banner"><IconAlert width={16} height={16} /> Письмо очень большое, показана только его начальная часть. Целиком его можно скачать.</div>}
          {prepared && view === "styled" ? (
            <iframe className="frame" title="Текст письма" sandbox="" referrerPolicy="no-referrer" srcDoc={frameDoc(prepared.html)} />
          ) : (
            <div className="plain">{m.text.trim() ? m.text : hasHtml ? "Текстовой версии нет." : "(пустое письмо)"}</div>
          )}
        </div>
      )}

      {((m.attachments.length > 0 && !m.encrypted) || showLinks) && (
        <footer className="mail-foot">
          {m.attachments.length > 0 && !m.encrypted && (
            <div className="atts" aria-label="Вложения">
              <span className="foot-title"><IconClip width={15} height={15} /> Вложения: {m.attachments.length}</span>
              {m.attachments.map((a) => (
                <a key={a.blobId} className="att" href={api.attachmentUrl(m.id, a.blobId)} title={`Скачать: ${a.name}`}>
                  <IconFile width={16} height={16} /><span className="att-name">{a.name}</span><span className="muted">{fileSize(a.size)}</span><IconDownload width={15} height={15} />
                </a>
              ))}
            </div>
          )}
          {showLinks && (
            <div className="links">
              <button className={"foot-title toggle" + (danger ? " danger-text" : "")} onClick={() => setLinksOpen((o) => !o)} aria-expanded={linksOpen}>
                <IconLink width={15} height={15} /> Ссылки в письме: {links.length}{danger && " · есть подозрительные"}
              </button>
              <AnimatePresence initial={false}>
                {linksOpen && (
                  <motion.ul initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}>
                    {links.map((l) => (
                      <li key={l.url} className={l.mismatch ? "bad" : ""}>
                        <span className="l-main"><strong>{l.host}</strong><span className="l-url">{l.url}</span>
                          {l.mismatch && <span className="tag warn">текст ссылки показывает другой сайт</span>}
                          {l.unusual && <span className="tag warn">необычные символы в адресе</span>}
                        </span>
                        <button className="icon-btn tiny" onClick={() => copy(l.url)} aria-label="Скопировать адрес" title="Скопировать адрес"><IconCopy /></button>
                        {l.kind === "web" && <a className="icon-btn tiny" href={l.url} target="_blank" rel="noopener noreferrer nofollow" aria-label="Открыть в новой вкладке" title="Открыть в новой вкладке"><IconExternal /></a>}
                      </li>
                    ))}
                  </motion.ul>
                )}
              </AnimatePresence>
            </div>
          )}
        </footer>
      )}
    </motion.article>
  );
}

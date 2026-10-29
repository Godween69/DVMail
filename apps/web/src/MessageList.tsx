import { AnimatePresence, motion } from "motion/react";
import { useRef, type KeyboardEvent } from "react";
import type { EmailItem } from "./api";
import { initial, listDate, tone, who } from "./format";
import { IconClip, IconMenu, IconMail, IconPen, IconRefresh, IconSearch, IconX } from "./icons";

interface Props {
  title: string; total: number; items: EmailItem[]; loading: boolean; error: string | null; hasMore: boolean;
  selectedId: string | null; showTo: boolean; query: string; refreshing: boolean;
  onSelect: (id: string) => void; onMore: () => void; onQuery: (q: string) => void; onMenu: () => void; onCompose: () => void; onRefresh: () => void; onRetry: () => void;
}

export function MessageList(p: Props) {
  const listRef = useRef<HTMLUListElement>(null);

  // Стрелки вверх и вниз переходят между письмами
  function keys(ev: KeyboardEvent<HTMLUListElement>) {
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    const all = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button.msg") ?? []);
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = all[i + (ev.key === "ArrowDown" ? 1 : -1)];
    if (next) { ev.preventDefault(); next.focus(); }
  }

  return (
    <section className="list-panel" aria-label="Письма">
      <header className="list-head">
        <button className="icon-btn menu-btn" onClick={p.onMenu} aria-label="Папки" title="Папки"><IconMenu /></button>
        <div className="list-title"><h2>{p.title}</h2><span className="muted">{p.query ? `найдено: ${p.total}` : `${p.total}`}</span></div>
        <button className="icon-btn compose-mini" onClick={p.onCompose} aria-label="Написать письмо" title="Написать письмо"><IconPen /></button>
        <button className={"icon-btn" + (p.refreshing ? " spin" : "")} onClick={p.onRefresh} aria-label="Обновить" title="Обновить"><IconRefresh /></button>
      </header>
      <div className="search">
        <IconSearch />
        <input type="search" placeholder="Поиск по письмам" value={p.query} onChange={(e) => p.onQuery(e.target.value)} aria-label="Поиск по письмам" maxLength={200} />
        {p.query && <button className="icon-btn tiny" onClick={() => p.onQuery("")} aria-label="Очистить поиск"><IconX /></button>}
      </div>

      <div className="list-scroll">
        {p.error ? (
          <div className="state"><p>{p.error}</p><button className="btn ghost small" onClick={p.onRetry}>Повторить</button></div>
        ) : p.loading && p.items.length === 0 ? (
          <ul className="skeletons" aria-hidden="true">{Array.from({ length: 7 }, (_, i) => <li key={i}><span className="avatar sk" /><span className="sk-lines"><i /><i /><i /></span></li>)}</ul>
        ) : p.items.length === 0 ? (
          <div className="state"><span className="state-ico"><IconMail width={30} height={30} /></span><p>{p.query ? "Ничего не найдено" : "В этой папке нет писем"}</p></div>
        ) : (
          <ul className="messages" ref={listRef} onKeyDown={keys}>
            <AnimatePresence initial>
              {p.items.map((m, i) => {
                const party = p.showTo ? m.to : m.from;
                return (
                  <motion.li key={m.id} layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: { delay: i < 12 ? i * 0.025 : 0, duration: 0.22 } }} exit={{ opacity: 0, x: -28, height: 0, transition: { duration: 0.2 } }}>
                    <button className={"msg" + (m.id === p.selectedId ? " selected" : "") + (m.unread ? " unread" : "")} onClick={() => p.onSelect(m.id)} aria-current={m.id === p.selectedId ? "true" : undefined}>
                      <span className={"avatar tone" + tone(party?.email ?? "")} aria-hidden="true">{initial(party)}</span>
                      <span className="msg-main">
                        <span className="msg-top">
                          <span className="msg-from">{p.showTo && <em>Кому: </em>}{who(party)}</span>
                          <span className="msg-date">{listDate(m.receivedAt)}</span>
                        </span>
                        <span className="msg-subj"><span className="t">{m.subject || "(без темы)"}</span>{m.hasAttachment && <IconClip className="clip" width={14} height={14} aria-label="Есть вложение" />}</span>
                        <span className="msg-prev">{m.preview}</span>
                      </span>
                      {m.unread && <span className="dot" aria-label="Не прочитано" />}
                    </button>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        )}
        {p.hasMore && !p.error && (
          <div className="more"><button className="btn ghost small" onClick={p.onMore} disabled={p.loading}>{p.loading ? "Загрузка…" : "Показать ещё"}</button></div>
        )}
      </div>
    </section>
  );
}

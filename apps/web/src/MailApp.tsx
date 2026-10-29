import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type EmailFull, type EmailItem, type Identity, type Mailbox } from "./api";
import { Compose } from "./Compose";
import { buildDraft, emptyDraft, type ComposeMode, type Draft } from "./compose";
import { folderLabel, sortMailboxes } from "./format";
import { useMedia, useRoute, useToasts } from "./hooks";
import { MessageList } from "./MessageList";
import { Reader } from "./Reader";
import { Sidebar } from "./Sidebar";
import type { Theme } from "./theme";

const PAGE = 30;
const POLL_MS = 60_000;

interface ListState { items: EmailItem[]; total: number; loading: boolean; error: string | null }
interface ComposeState { key: number; draft: Draft; identityId: string; note: string | null }
interface OpenState { id: string; data: EmailFull | null; loading: boolean; error: string | null }
const msg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export function MailApp({ email, theme, onToggleTheme, onLogout }: { email: string; theme: Theme; onToggleTheme: () => void; onLogout: () => void }) {
  const [route, go] = useRoute();
  const [boxes, setBoxes] = useState<Mailbox[] | null>(null);
  const [boxError, setBoxError] = useState<string | null>(null);
  const [list, setList] = useState<ListState>({ items: [], total: 0, loading: true, error: null });
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<OpenState | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);
  const [identities, setIdentities] = useState<Identity[] | null>(null);
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [toasts, toast] = useToasts();
  const req = useRef(0);
  const small = useMedia("(max-width: 999px)");
  const narrow = useMedia("(max-width: 699px)");

  const inbox = boxes?.find((b) => b.role === "inbox") ?? boxes?.[0] ?? null;
  const current = boxes ? (boxes.find((b) => b.id === route.box) ?? inbox) : null;
  const currentId = current?.id ?? null;
  const showTo = current?.role === "sent" || current?.role === "drafts";

  // ---- Папки
  const loadBoxes = useCallback(async () => {
    try { setBoxes(sortMailboxes(await api.mailboxes())); setBoxError(null); }
    catch (e) { setBoxError(msg(e, "Не удалось получить папки")); }
  }, []);
  useEffect(() => { void loadBoxes(); }, [loadBoxes]);
  useEffect(() => { if (boxes && inbox && !route.box) go({ box: inbox.id, id: null }, true); }, [boxes, inbox, route.box, go]);

  // ---- Поиск с небольшой задержкой, чтобы не спрашивать сервер на каждую букву
  useEffect(() => { const t = window.setTimeout(() => setQ(input.trim()), 350); return () => window.clearTimeout(t); }, [input]);

  // ---- Список писем: при смене папки, поиска или нажатии «обновить»
  useEffect(() => {
    if (!currentId) return;
    const my = ++req.current;
    setList({ items: [], total: 0, loading: true, error: null });
    api.emails(currentId, 0, PAGE, q).then(
      (pg) => { if (my === req.current) setList({ items: pg.emails, total: pg.total, loading: false, error: null }); },
      (e) => { if (my === req.current) setList({ items: [], total: 0, loading: false, error: msg(e, "Не удалось получить письма") }); },
    );
  }, [currentId, q, tick]);

  async function loadMore() {
    if (!currentId || list.loading) return;
    const my = ++req.current;
    setList((l) => ({ ...l, loading: true }));
    try {
      const pg = await api.emails(currentId, list.items.length, PAGE, q);
      if (my !== req.current) return;
      setList((l) => ({ ...l, loading: false, total: pg.total, items: [...l.items, ...pg.emails.filter((x) => !l.items.some((y) => y.id === x.id))] }));
    } catch (e) { if (my === req.current) { setList((l) => ({ ...l, loading: false })); toast(msg(e, "Не удалось загрузить ещё"), "err"); } }
  }

  // ---- Тихое обновление: счётчики папок и (если не листали и не искали) начало списка
  const refresh = useCallback(async (manual: boolean) => {
    setRefreshing(true);
    try {
      await loadBoxes();
      if (currentId && !q) {
        const my = ++req.current;
        const pg = await api.emails(currentId, 0, Math.max(PAGE, list.items.length), "");
        if (my === req.current) setList({ items: pg.emails, total: pg.total, loading: false, error: null });
      }
    } catch (e) { if (manual) toast(msg(e, "Не удалось обновить"), "err"); }
    finally { setRefreshing(false); }
  }, [currentId, q, list.items.length, loadBoxes, toast]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void refreshRef.current(false); }, POLL_MS);
    return () => window.clearInterval(t);
  }, []);

  // ---- Открытое письмо
  const adjust = useCallback((boxIds: string[], dUnread: number, dTotal = 0) => {
    setBoxes((bs) => bs && bs.map((b) => (boxIds.includes(b.id) ? { ...b, unread: Math.max(0, b.unread + dUnread), total: Math.max(0, b.total + dTotal) } : b)));
  }, []);

  const markSeen = useCallback(async (mail: EmailFull, seen: boolean) => {
    const ids = mail.mailboxIds;
    const apply = (s: boolean) => {
      setList((l) => ({ ...l, items: l.items.map((x) => (x.id === mail.id ? { ...x, unread: !s } : x)) }));
      setOpen((o) => (o && o.data && o.id === mail.id ? { ...o, data: { ...o.data, unread: !s } } : o));
      adjust(ids, s ? -1 : 1);
    };
    apply(seen);
    try { await api.setSeen(mail.id, seen); }
    catch (e) { apply(!seen); toast(msg(e, "Не удалось изменить пометку"), "err"); }
  }, [adjust, toast]);

  useEffect(() => {
    if (!route.id) { setOpen(null); return; }
    let dead = false;
    const id = route.id;
    setOpen({ id, data: null, loading: true, error: null });
    api.email(id).then(
      (d) => { if (dead) return; setOpen({ id, data: d, loading: false, error: null }); if (d.unread) void markSeen(d, true); },
      (e) => { if (!dead) setOpen({ id, data: null, loading: false, error: msg(e, e instanceof ApiError && e.status === 404 ? "Письмо не найдено" : "Не удалось открыть письмо") }); },
    );
    return () => { dead = true; };
  }, [route.id, markSeen]);

  async function trash() {
    const mail = open?.data;
    if (!mail) return;
    try {
      const r = await api.trash(mail.id);
      setList((l) => ({ ...l, total: Math.max(0, l.total - 1), items: l.items.filter((x) => x.id !== mail.id) }));
      adjust(mail.mailboxIds, mail.unread ? -1 : 0, -1);
      go({ box: currentId, id: null });
      toast(r.permanent ? "Письмо удалено навсегда" : "Письмо перемещено в корзину");
      void loadBoxes();
    } catch (e) { toast(msg(e, "Не удалось удалить письмо"), "err"); }
  }

  // ---- Новое письмо, ответ, пересылка
  async function openCompose(mode: ComposeMode, mail?: EmailFull) {
    let ids = identities;
    if (!ids) {
      try { ids = await api.identities(); setIdentities(ids); }
      catch (e) { toast(msg(e, "Не удалось подготовить письмо"), "err"); return; }
    }
    if (ids.length === 0) { toast("У этого ящика нет адреса отправителя", "err"); return; }
    const own = [email, ...ids.map((i) => i.email)];
    const draft = mode === "new" || !mail ? emptyDraft() : buildDraft(mode, mail, own);
    // отвечаем с того адреса, на который пришло письмо, иначе с первого
    const got = mail ? [...mail.to, ...mail.cc].map((a) => a.email.toLowerCase()) : [];
    const identityId = (ids.find((i) => got.includes(i.email.toLowerCase())) ?? ids[0]).id;
    const note = mode === "forward" && mail && mail.attachments.length > 0 ? "Вложения исходного письма не пересылаются: отправка вложений пока не поддерживается." : null;
    setDrawer(false);
    setCompose({ key: Date.now(), draft, identityId, note });
  }
  function sent(filed: boolean) {
    setCompose(null);
    toast(filed ? "Письмо отправлено" : "Письмо отправлено, но копия не попала в «Отправленные»", filed ? "ok" : "err");
    void refresh(false);
  }

  const selectBox = (id: string) => { setInput(""); setQ(""); setDrawer(false); go({ box: id, id: null }); };
  const hasMore = list.items.length < list.total;
  const showReader = !narrow || !!route.id;
  const showList = !narrow || !route.id;

  if (!boxes) {
    return <div className="boot">{boxError ? <><p>{boxError}</p><button className="btn ghost small" onClick={() => void loadBoxes()}>Повторить</button></> : <span className="spinner big" aria-label="Загрузка" />}</div>;
  }

  return (
    <div className={"shell" + (narrow && route.id ? " reading" : "")}>
      <Sidebar boxes={boxes} current={currentId} onSelect={selectBox} email={email} theme={theme} onToggleTheme={onToggleTheme} onLogout={onLogout} onCompose={() => void openCompose("new")} drawer={small} open={drawer} onClose={() => setDrawer(false)} />
      {showList && (
        <MessageList
          title={current ? folderLabel(current) : ""} total={list.total} items={list.items} loading={list.loading} error={list.error} hasMore={hasMore}
          selectedId={route.id} showTo={showTo} query={input} refreshing={refreshing}
          onSelect={(id) => go({ box: currentId, id })} onMore={() => void loadMore()} onQuery={setInput} onMenu={() => setDrawer(true)} onCompose={() => void openCompose("new")}
          onRefresh={() => (list.error ? setTick((t) => t + 1) : void refresh(true))} onRetry={() => setTick((t) => t + 1)}
        />
      )}
      {showReader && (
        <Reader
          selected={!!route.id} mail={open?.data ?? null} loading={open?.loading ?? false} error={open?.error ?? null}
          inTrash={current?.role === "trash"} narrow={narrow}
          onBack={() => go({ box: currentId, id: null })} onRetry={() => go({ box: currentId, id: route.id }, true)}
          onToggleSeen={() => open?.data && void markSeen(open.data, open.data.unread)} onTrash={() => void trash()}
          onReply={() => open?.data && void openCompose("reply", open.data)} onReplyAll={() => open?.data && void openCompose("replyAll", open.data)} onForward={() => open?.data && void openCompose("forward", open.data)}
          onCopied={(ok) => toast(ok ? "Адрес скопирован" : "Не удалось скопировать", ok ? "ok" : "err")}
        />
      )}
      <AnimatePresence>
        {compose && <Compose key={compose.key} identities={identities ?? []} initial={compose.draft} identityId={compose.identityId} note={compose.note} onClose={() => setCompose(null)} onSent={sent} />}
      </AnimatePresence>
      <div className="toasts" aria-live="polite">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div key={t.id} className={"toast " + t.kind} layout initial={{ opacity: 0, y: 16, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.96 }} transition={{ type: "spring", stiffness: 400, damping: 30 }}>
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

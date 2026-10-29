import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import type { Mailbox } from "./api";
import { folderLabel } from "./format";
import { IconArchive, IconDraft, IconFolder, IconInbox, IconJunk, IconLogout, IconMoon, IconSend, IconSun, IconTrash } from "./icons";
import type { Theme } from "./theme";

const ICONS: Record<string, () => React.JSX.Element> = {
  inbox: () => <IconInbox />, drafts: () => <IconDraft />, sent: () => <IconSend />,
  archive: () => <IconArchive />, junk: () => <IconJunk />, trash: () => <IconTrash />,
};

interface Props {
  boxes: Mailbox[]; current: string | null; onSelect: (id: string) => void;
  email: string; theme: Theme; onToggleTheme: () => void; onLogout: () => void;
  drawer: boolean; open: boolean; onClose: () => void;
}

export function Sidebar({ boxes, current, onSelect, email, theme, onToggleTheme, onLogout, drawer, open, onClose }: Props) {
  return (
    <>
      {drawer && open && <div className="backdrop" onClick={onClose} aria-hidden="true" />}
      <aside className={"sidebar" + (drawer ? " as-drawer" : "") + (open ? " open" : "")} aria-label="Папки">
        <div className="brand">
          <span className="logo" aria-hidden="true">DV</span>
          <span className="brand-name">DVMail</span>
        </div>
        <nav>
          <LayoutGroup id="folders">
            <ul className="folders">
              {boxes.map((m) => (
                <li key={m.id}>
                  <button className={"folder" + (m.id === current ? " active" : "")} onClick={() => onSelect(m.id)} aria-current={m.id === current ? "page" : undefined}>
                    {m.id === current && <motion.span layoutId="pill" className="pill" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
                    <span className="f-icon">{(m.role && ICONS[m.role]?.()) || <IconFolder />}</span>
                    <span className="f-name">{folderLabel(m)}</span>
                    <AnimatePresence mode="wait" initial={false}>
                      {m.unread > 0 && (
                        <motion.span key={m.unread} className="count" initial={{ opacity: 0, scale: 0.6, y: 4 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.1 } }} transition={{ type: "spring", stiffness: 500, damping: 30 }}>
                          {m.unread > 999 ? "999+" : m.unread}
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </button>
                </li>
              ))}
            </ul>
          </LayoutGroup>
        </nav>
        <div className="account">
          <div className="who-acc" title={email}><span className="acc-mail">{email}</span></div>
          <div className="acc-actions">
            <button className="icon-btn" onClick={onToggleTheme} aria-label={theme === "dark" ? "Включить светлую тему" : "Включить тёмную тему"} title={theme === "dark" ? "Светлая тема" : "Тёмная тема"}>
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={theme} className="swap" initial={{ rotate: -70, opacity: 0, scale: 0.6 }} animate={{ rotate: 0, opacity: 1, scale: 1 }} exit={{ rotate: 70, opacity: 0, scale: 0.6 }} transition={{ duration: 0.18 }}>
                  {theme === "dark" ? <IconSun /> : <IconMoon />}
                </motion.span>
              </AnimatePresence>
            </button>
            <button className="icon-btn" onClick={onLogout} aria-label="Выйти" title="Выйти"><IconLogout /></button>
          </div>
        </div>
      </aside>
    </>
  );
}

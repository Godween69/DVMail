import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { Contact } from "./api";
import { applyContact, currentToken, findContacts, parseAddresses } from "./compose";

interface Props {
  id: string; value: string; onChange: (v: string) => void; contacts: Contact[];
  disabled?: boolean; maxLength?: number; placeholder?: string; inputRef?: RefObject<HTMLInputElement | null>;
}

// Поле адресов с подсказками: пока человек набирает адрес, под полем появляются подходящие из его же почты.
// Стрелки выбирают, Enter или Tab вставляют, Esc закрывает список. Весь список только в памяти страницы.
export function AddressField({ id, value, onChange, contacts, disabled, maxLength, placeholder, inputRef }: Props) {
  const own = useRef<HTMLInputElement>(null);
  const el = inputRef ?? own;
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(false);
  const nextCaret = useRef<number | null>(null);

  const tok = currentToken(value, caret);
  const list = useMemo(() => {
    if (!focused || hidden || disabled) return [];
    const taken = parseAddresses(value.slice(0, tok.start) + value.slice(caret)).ok;
    return findContacts(contacts, tok.text, taken);
  }, [contacts, focused, hidden, disabled, value, caret, tok.start, tok.text]);

  // после вставки ставим курсор в конец вставленного
  useEffect(() => {
    if (nextCaret.current !== null && el.current) { el.current.setSelectionRange(nextCaret.current, nextCaret.current); nextCaret.current = null; }
  });

  const sync = () => setCaret(el.current?.selectionStart ?? value.length);
  const accept = (c: Contact) => {
    const r = applyContact(value, caret, c);
    nextCaret.current = r.caret;
    setCaret(r.caret); setActive(0); onChange(r.value);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (list.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((active + 1) % list.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((active - 1 + list.length) % list.length); }
    else if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey) || (e.key === "Tab" && !e.shiftKey)) { e.preventDefault(); accept(list[Math.min(active, list.length - 1)]); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setHidden(true); } // закрывает только список, не окно письма
  };
  const open = list.length > 0;

  return (
    <>
      <input
        id={id} ref={el} value={value} disabled={disabled} maxLength={maxLength} placeholder={placeholder}
        autoComplete="off" spellCheck={false}
        role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={id + "-list"}
        aria-activedescendant={open ? `${id}-o${Math.min(active, list.length - 1)}` : undefined}
        onChange={(e) => { onChange(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setActive(0); setHidden(false); }}
        onKeyDown={onKeyDown} onKeyUp={sync} onClick={sync} onSelect={sync}
        onFocus={() => { setFocused(true); sync(); }} onBlur={() => setFocused(false)}
      />
      {open && (
        <ul className="c-sug" id={id + "-list"} role="listbox" aria-label="Подсказки адресов">
          {list.map((c, i) => (
            <li
              key={c.email} id={`${id}-o${i}`} role="option" aria-selected={i === active} className={i === active ? "on" : ""}
              onMouseDown={(e) => { e.preventDefault(); accept(c); }} onMouseEnter={() => setActive(i)}
            >
              {c.name ? <><span className="c-sug-name">{c.name}</span><span className="c-sug-mail muted">{c.email}</span></> : <span className="c-sug-name">{c.email}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

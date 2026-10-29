// Проверка логики ответов, пересылки и разбора адресов (compose.ts). Файл собирается rolldown во временную папку.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const out = mkdtempSync(join(tmpdir(), "dvmail-compose-"));
execFileSync("npx", ["rolldown", join(root, "src/compose.ts"), "--format", "esm", "--file", join(out, "compose.mjs")], { cwd: root, stdio: "pipe" });
const { buildDraft, parseAddresses, isDirty, emptyDraft, plainOf } = await import(pathToFileURL(join(out, "compose.mjs")).href);
process.on("exit", () => rmSync(out, { recursive: true, force: true }));

const A = (email, name = null) => ({ name, email });
const mail = (over = {}) => ({
  id: "e1", unread: false, mailboxIds: ["m1"], from: A("anna@example.org", "Анна"), to: [A("hello@dvbstudio.ru"), A("bob@example.org")],
  cc: [A("carl@example.org"), A("alias@dvbstudio.ru")], replyTo: [], subject: "Счёт", receivedAt: "2026-10-28T10:00:00Z", sentAt: "", size: 1,
  text: "Добрый день\nВторая строка", html: "", truncated: false, encrypted: false, attachments: [], ...over,
});
const OWN = ["hello@dvbstudio.ru", "alias@dvbstudio.ru"];

test("разбор адресов: имена, разделители, повторы, ошибки", () => {
  assert.deepEqual(parseAddresses("a@example.org, B@example.org; a@EXAMPLE.org\nc@example.org"), { ok: ["a@example.org", "B@example.org", "c@example.org"], bad: [] });
  assert.deepEqual(parseAddresses('"Иванов, Иван" <ivan@example.org>, Петр <petr@example.org>').ok, ["ivan@example.org", "petr@example.org"]);
  assert.deepEqual(parseAddresses("anna").bad, ["anna"], "слово без @ не должно молча пропадать");
  assert.deepEqual(parseAddresses("a@b, x@example.org").bad, ["a@b"]);
  assert.deepEqual(parseAddresses("  ,; ").ok, []);
  assert.deepEqual(parseAddresses("a b@example.org").bad, ["a"]); // пробел разделяет: «a» без @ будет показано как ошибка
});

test("ответ: адресат, тема, цитата", () => {
  const d = buildDraft("reply", mail(), OWN);
  assert.equal(d.to, "anna@example.org");
  assert.equal(d.cc, "");
  assert.equal(d.subject, "Re: Счёт");
  assert.equal(d.replyTo, "e1");
  assert.match(d.text, /^\n\n.*Анна <anna@example\.org> написал\(а\):\n> Добрый день\n> Вторая строка$/s);
  assert.equal(buildDraft("reply", mail({ subject: "Re: Счёт" }), OWN).subject, "Re: Счёт", "Re: не дублируется");
  assert.equal(buildDraft("reply", mail({ subject: "Ответ: Счёт" }), OWN).subject, "Ответ: Счёт");
  assert.equal(buildDraft("reply", mail({ subject: "" }), OWN).subject, "Re:");
});

test("ответ: Reply-To главнее отправителя", () => {
  assert.equal(buildDraft("reply", mail({ replyTo: [A("support@example.org")] }), OWN).to, "support@example.org");
});

test("ответ всем: свои адреса не попадают, повторов нет", () => {
  const d = buildDraft("replyAll", mail(), OWN);
  assert.equal(d.to, "anna@example.org, bob@example.org");
  assert.equal(d.cc, "carl@example.org");
  // письмо, которое написали сами себе: адресат остаётся
  const self = buildDraft("replyAll", mail({ from: A("hello@dvbstudio.ru"), to: [A("hello@dvbstudio.ru")], cc: [] }), OWN);
  assert.equal(self.to, "hello@dvbstudio.ru");
  // адрес в «Кому» и «Копия» одновременно показывается один раз
  const dup = buildDraft("replyAll", mail({ cc: [A("BOB@example.org")] }), OWN);
  assert.equal(dup.cc, "");
});

test("цитата не ломается от строк с «>» и от CRLF", () => {
  const d = buildDraft("reply", mail({ text: "> вложенная цитата\r\nобычная" }), OWN);
  assert.ok(d.text.endsWith(">> вложенная цитата\n> обычная"), d.text);
});

test("пересылка: пустые адресаты, шапка, тема Fwd:", () => {
  const d = buildDraft("forward", mail(), OWN);
  assert.equal(d.to, ""); assert.equal(d.replyTo, null);
  assert.equal(d.subject, "Fwd: Счёт");
  assert.match(d.text, /---------- Пересылаемое письмо ----------\nОт: Анна <anna@example\.org>\nДата: .+\nТема: Счёт\nКому: hello@dvbstudio\.ru, bob@example\.org\nКопия: .+\n\nДобрый день\nВторая строка$/s);
  assert.equal(buildDraft("forward", mail({ subject: "Fwd: Счёт" }), OWN).subject, "Fwd: Счёт");
});

test("зашифрованное письмо не цитируется", () => {
  assert.equal(plainOf(mail({ encrypted: true })), "");
  assert.doesNotMatch(buildDraft("reply", mail({ encrypted: true, text: "тайна" }), OWN).text, /тайна/);
});

test("изменения в окне письма замечаются", () => {
  const a = emptyDraft();
  assert.equal(isDirty(a, a), false);
  assert.equal(isDirty({ ...a, text: "x" }, a), true);
});

// ---- Подсказки адресов
const { currentToken, findContacts, applyContact, contactLabel } = await import(pathToFileURL(join(out, "compose.mjs")).href);
const C = (email, name = "") => ({ name, email });
const BOOK = [C("bob@example.org", "Боб Смирнов"), C("anna@example.org", "Анна Петрова"), C("petr@work.example", "Пётр"), C("carl@example.org"), C("anna.p@mail.example", "Анна Попова")];

test("подсказки: набираемый адрес это часть после последнего разделителя до курсора", () => {
  assert.deepEqual(currentToken("a@example.org, bo"), { start: 15, text: "bo" });
  assert.deepEqual(currentToken("bo"), { start: 0, text: "bo" });
  assert.deepEqual(currentToken("a@example.org; \n  bo"), { start: 18, text: "bo" });
  assert.deepEqual(currentToken("a@example.org, bo, c@example.org", 17), { start: 15, text: "bo" }, "курсор в середине");
  assert.deepEqual(currentToken(""), { start: 0, text: "" });
  assert.deepEqual(currentToken("abc", 99), { start: 0, text: "abc" }, "курсор за пределами");
});

test("подсказки: поиск по началу адреса, имени и слова имени, потом по середине; уже стоящие не повторяются", () => {
  const e = (t, taken = []) => findContacts(BOOK, t, taken).map((c) => c.email);
  assert.deepEqual(e("bo"), ["bob@example.org"]);
  assert.deepEqual(e("анна"), ["anna@example.org", "anna.p@mail.example"], "порядок как у сервера");
  assert.deepEqual(e("петр"), ["anna@example.org", "petr@work.example"], "«Петрова» и «Пётр» (е и ё одно и то же)");
  assert.deepEqual(e("пёт"), ["anna@example.org", "petr@work.example"]);
  assert.deepEqual(e("смир"), ["bob@example.org"], "начало второго слова имени");
  assert.deepEqual(e("example").slice(0, 2), ["bob@example.org", "anna@example.org"], "из середины адреса");
  assert.deepEqual(e("anna", ["ANNA@example.org"]), ["anna.p@mail.example"], "уже в поле: пропускаем без учёта регистра");
  assert.deepEqual(e("carl@example.org"), [], "адрес набран целиком: подсказывать нечего");
  assert.deepEqual(e("ан").length, 2, "из середины слова от двух букв не ищем: «Иван» не мешает");
  assert.deepEqual(e("мир"), ["bob@example.org"], "от трёх букв ищем и в середине: «Смирнов»");
  assert.deepEqual(e(""), []);
  assert.deepEqual(e("   "), []);
  assert.deepEqual(e("a<b"), [], "угловые скобки: адрес уже оформлен");
  assert.deepEqual(e("ё".repeat(80)), []);
  assert.equal(findContacts(Array.from({ length: 50 }, (_, i) => C(`u${i}@example.org`)), "u", [], 6).length, 6, "не больше шести");
});

test("подсказки: вставка заменяет набранные буквы, ставит запятую и курсор после неё", () => {
  const bob = C("bob@example.org", "Боб Смирнов");
  assert.deepEqual(applyContact("a@example.org, bo", 17, bob), { value: "a@example.org, Боб Смирнов <bob@example.org>, ", caret: 46 });
  assert.deepEqual(applyContact("bo", 2, C("bob@example.org")), { value: "bob@example.org, ", caret: 17 });
  const mid = applyContact("a@example.org, bo, c@example.org", 17, bob);
  assert.equal(mid.value, "a@example.org, Боб Смирнов <bob@example.org>, c@example.org", "хвост остаётся, лишней запятой нет");
  assert.equal(mid.caret, 46);
  assert.equal(contactLabel(C("x@example.org", 'Ты <"злой">, имя;')), "Ты злой имя <x@example.org>", "знаки, ломающие запись, убраны");
  // вставленное разбирается обратно в нужный адрес
  assert.deepEqual(parseAddresses(applyContact("", 0, bob).value).ok, ["bob@example.org"]);
});

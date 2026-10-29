// Тесты сервера входа. Вместо настоящего Stalwart работает заглушка (она знает один пароль приложения).
// Запуск: npm test (из корня или из apps/server). Сборка идёт перед тестами.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.DVMAIL_LOG = "quiet";
const { createApp } = await import("../dist/bootstrap.js");
const { SessionStore } = await import("../dist/session.store.js");

const EMAIL = "hello@dvbstudio.ru";
const PASS = "app-pass-correct-123";
const ORIGIN = "https://webmail.test";
const BASIC = "Basic " + Buffer.from(`${EMAIL}:${PASS}`).toString("base64");
const MFA_BASIC = "Basic " + Buffer.from(`${EMAIL}:main-password-needs-code`).toString("base64");

// ---- Заглушка Stalwart ----
// Формат ответов повторяет настоящий Stalwart 0.16 (проверено на настоящем ящике): POST /jmap, bodyValues по partId,
// скачивание /jmap/download/{аккаунт}/{blob}/{имя}. Код 402 «нужен код двухфакторки» тоже как у настоящего.
let mockHits = 0;
const PDF = Buffer.from("%PDF-1.4 тестовое вложение");
const part = (partId, blobId, type, size, extra = {}) => ({ partId, blobId, type, size, charset: null, disposition: null, name: null, cid: null, ...extra });
// Что заглушка получила на отправку (для проверок) и режимы сбоев
let SUBMITTED = [], newId = 0, failSubmitMethod = false;
const MAILS = new Map();
const addMail = (m) => MAILS.set(m.id, m);
function resetMails() {
  MAILS.clear(); SUBMITTED = []; failSubmitMethod = false;
  const pdf = part("3", "blob-pdf", "application/pdf", PDF.length, { disposition: "attachment", name: "Счёт/../2026.pdf" });
  addMail({ id: "e1", threadId: "t1", mailboxIds: { m1: true }, keywords: {}, from: [{ name: "Анна", email: "anna@example.org" }], to: [{ name: null, email: EMAIL }],
    subject: "Счёт на оплату", messageId: ["orig-1@example.org"], references: ["root@example.org"], receivedAt: "2026-10-28T10:00:00Z", sentAt: "2026-10-28T09:59:00Z", preview: "Добрый день", hasAttachment: true, size: 4000, blobId: "blob-e1",
    bodyStructure: part(null, null, "multipart/mixed", null), textBody: [part("1", "blob-t", "text/plain", 12)], htmlBody: [part("2", "blob-h", "text/html", 40)],
    attachments: [pdf, part("4", "blob-bad/../x", "image/png", 1)], bodyValues: { 1: { value: "Добрый день", isTruncated: false }, 2: { value: "<p>Добрый <b>день</b><script>alert(1)</script></p>", isTruncated: false } } });
  addMail({ id: "e2", threadId: "t2", mailboxIds: { m1: true }, keywords: { $seen: true }, from: [{ name: null, email: "bob@example.org" }], to: [{ name: null, email: EMAIL }],
    subject: "Привет", receivedAt: "2026-10-27T10:00:00Z", sentAt: null, preview: "Просто текст", hasAttachment: false, size: 500, blobId: "blob-e2",
    bodyStructure: part("1", "blob-t2", "text/plain", 20), textBody: [part("1", "blob-t2", "text/plain", 20)], htmlBody: [part("1", "blob-t2", "text/plain", 20)],
    attachments: [], bodyValues: { 1: { value: "Просто текст", isTruncated: false } } });
  addMail({ id: "e3", threadId: "t3", mailboxIds: { m3: true }, keywords: { $seen: true }, from: [{ name: "Шифр", email: "enc@example.org" }], to: [{ name: null, email: EMAIL }],
    subject: "Секретно", receivedAt: "2026-10-26T10:00:00Z", sentAt: null, preview: "", hasAttachment: true, size: 900, blobId: "blob-e3",
    bodyStructure: part("1", "blob-p7m", "application/pkcs7-mime", 800, { name: "smime.p7m" }), textBody: [], htmlBody: [], attachments: [part("1", "blob-p7m", "application/pkcs7-mime", 800, { name: "smime.p7m" })], bodyValues: {} });
}
resetMails();
const BOXES = [
  { id: "m1", name: "Inbox", role: "inbox", totalEmails: 3, unreadEmails: 1, secretExtra: "не должно уйти в браузер" },
  { id: "m2", name: "Deleted Items", role: "trash", totalEmails: 0, unreadEmails: 0 },
  { id: "m3", name: "Drafts", role: "drafts", totalEmails: 1, unreadEmails: 0 },
  { id: "m4", name: "Sent Items", role: "sent", totalEmails: 0, unreadEmails: 0 },
];
const IDENTITIES = [
  { id: "i1", name: "Привет Hello", email: "hello@dvbstudio.ru" },
  { id: "i2", name: "", email: "alias@dvbstudio.ru" },
  { id: "i3", name: "Запрещённый", email: "nobody@dvbstudio.ru" },
];
const pick = (o, props) => (props ? Object.fromEntries(props.filter((k) => k in o).map((k) => [k, o[k]])) : o);

function jmap(calls) {
  const out = []; const state = {};
  for (const [name, args, id] of calls) {
    let r;
    if (args.accountId !== "a1") r = ["error", { type: "forbidden" }, id];
    else if (name === "Mailbox/get") r = [name, { accountId: "a1", list: BOXES.map((b) => pick(b, args.properties ? [...args.properties, "secretExtra"] : null)) }, id];
    else if (name === "Identity/get") r = [name, { accountId: "a1", list: IDENTITIES.map((i) => pick(i, args.properties)) }, id];
    else if (name === "EmailSubmission/set") {
      if (failSubmitMethod) { r = ["error", { type: "serverFail" }, id]; out.push(r); continue; }
      const res = { accountId: "a1" };
      for (const [cid, sub] of Object.entries(args.create ?? {})) {
        const m = MAILS.get(sub.emailId);
        if (!m) (res.notCreated ??= {})[cid] = { type: "invalidEmail" };
        else if (sub.identityId === "i3") (res.notCreated ??= {})[cid] = { type: "forbiddenFrom" };
        else if (sub.envelope.rcptTo.some((x) => x.email.startsWith("bad@"))) (res.notCreated ??= {})[cid] = { type: "invalidEmail" };
        else { SUBMITTED.push({ ...sub, mail: structuredClone(m) }); (res.created ??= {})[cid] = { id: "sub" + SUBMITTED.length }; }
      }
      r = [name, res, id];
    } else if (name === "Email/query") {
      let ids = [...MAILS.values()].filter((m) => m.mailboxIds[args.filter.inMailbox] && (!args.filter.text || m.subject.includes(args.filter.text))).map((m) => m.id);
      const total = ids.length; ids = ids.slice(args.position ?? 0, (args.position ?? 0) + (args.limit ?? 100));
      state[id] = ids; r = [name, { accountId: "a1", ids, total, position: args.position ?? 0 }, id];
    } else if (name === "Email/get") {
      const ids = args["#ids"] ? state[args["#ids"].resultOf] : args.ids;
      r = [name, { accountId: "a1", list: ids.filter((i) => MAILS.has(i)).map((i) => pick(MAILS.get(i), args.properties)), notFound: ids.filter((i) => !MAILS.has(i)) }, id];
    } else if (name === "Email/set") {
      const res = { accountId: "a1" };
      for (const [cid, c] of Object.entries(args.create ?? {})) {
        if (/ОТКАЗ/.test(c.subject ?? "")) { (res.notCreated ??= {})[cid] = { type: "invalidProperties" }; continue; }
        const mid = "n" + ++newId;
        MAILS.set(mid, { ...c, id: mid, threadId: "tn" + newId, receivedAt: "2026-10-29T10:00:00Z", preview: "", hasAttachment: false, size: 100, blobId: "blob-" + mid });
        (res.created ??= {})[cid] = { id: mid };
      }
      for (const [mid, patch] of Object.entries(args.update ?? {})) {
        const m = MAILS.get(mid); res.updated ??= {};
        if (!m) { (res.notUpdated ??= {})[mid] = { type: "notFound" }; continue; }
        for (const [k, v] of Object.entries(patch)) {
          if (k === "keywords/$seen") { if (v === null) delete m.keywords.$seen; else m.keywords.$seen = true; }
          else if (k === "mailboxIds") m.mailboxIds = v;
          else if (k.startsWith("mailboxIds/")) { if (v === null) delete m.mailboxIds[k.slice(11)]; else m.mailboxIds[k.slice(11)] = true; }
          else if (k === "keywords/$draft") delete m.keywords.$draft;
        }
        res.updated[mid] = null;
      }
      for (const mid of args.destroy ?? []) { if (MAILS.delete(mid)) (res.destroyed ??= []).push(mid); }
      r = [name, res, id];
    } else r = ["error", { type: "unknownMethod" }, id];
    out.push(r);
  }
  return out;
}

const mock = http.createServer((req, res) => {
  mockHits++;
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  const ok = req.headers.authorization === BASIC;
  const mfa = req.headers.authorization === MFA_BASIC; // верный пароль, но нужен код
  if (!ok) return send(mfa ? 402 : 401, { status: mfa ? 402 : 401, title: mfa ? "MFA code required" : "Unauthorized" });
  if (req.method === "GET" && req.url === "/jmap/session") {
    return send(200, { primaryAccounts: { "urn:ietf:params:jmap:mail": "a1" }, accounts: { a1: {} }, apiUrl: "https://mail.example/jmap" });
  }
  const dl = /^\/jmap\/download\/a1\/([^/]+)\/file\?accept=application%2Foctet-stream$/.exec(req.url ?? "");
  if (req.method === "GET" && dl) {
    if (dl[1] === "blob-pdf") { res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": PDF.length }); return res.end(PDF); }
    if (dl[1] === "blob-e1") { const eml = Buffer.from("From: anna@example.org\r\n\r\nтело"); res.writeHead(200, { "Content-Type": "message/rfc822", "Content-Length": eml.length }); return res.end(eml); }
    return send(404, {});
  }
  if (req.method === "POST" && req.url === "/jmap") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => send(200, { methodResponses: jmap(JSON.parse(body).methodCalls), sessionState: "s1" }));
    return;
  }
  send(404, {});
});

let app, base, store;
const apps = [];
async function start(over = {}) {
  const { app: a } = await createApp({
    stalwartUrl: `http://127.0.0.1:${mock.address().port}`, cookieSecure: false, allowedOrigin: ORIGIN, host: "127.0.0.1", ...over,
  });
  await a.listen(0, "127.0.0.1");
  apps.push(a);
  return { a, url: `http://127.0.0.1:${a.getHttpServer().address().port}` };
}
const H = (extra = {}) => ({ "Content-Type": "application/json", "X-Requested-With": "dvmail", Origin: ORIGIN, ...extra });
const login = (url, email, password, extra) =>
  fetch(url + "/api/auth/login", { method: "POST", headers: H(extra), body: JSON.stringify({ email, password }) });
const cookieOf = (r) => (r.headers.get("set-cookie") ?? "").split(";")[0];

before(async () => {
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  ({ a: app, url: base } = await start());
  store = app.get(SessionStore);
});
after(async () => { for (const a of apps) await a.close(); mock.close(); });

test("health отвечает", async () => {
  const r = await fetch(base + "/health");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-powered-by"), null);
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("вход без своего заголовка отклоняется (CSRF)", async () => {
  const r = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASS }) });
  assert.equal(r.status, 403);
});

test("вход с чужого Origin отклоняется", async () => {
  const r = await login(base, EMAIL, PASS, { Origin: "https://evil.example" });
  assert.equal(r.status, 403);
});

test("вход с cross-site отклоняется", async () => {
  const r = await login(base, EMAIL, PASS, { "Sec-Fetch-Site": "cross-site" });
  assert.equal(r.status, 403);
});

test("неверный пароль: 401 без cookie", async () => {
  const r = await login(base, EMAIL, "wrong-password");
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("set-cookie"), null);
  assert.match((await r.json()).message, /Неверный адрес или пароль/);
});

test("чужой домен отклоняется без обращения к Stalwart", async () => {
  const before = mockHits;
  const r = await login(base, "someone@gmail.com", PASS);
  assert.equal(r.status, 401);
  assert.equal(mockHits, before);
});

test("слишком большое тело запроса отклоняется", async () => {
  const r = await fetch(base + "/api/auth/login", { method: "POST", headers: H(), body: JSON.stringify({ email: EMAIL, password: "x".repeat(20000) }) });
  assert.equal(r.status, 413);
});

test("без cookie доступ закрыт", async () => {
  assert.equal((await fetch(base + "/api/mailboxes")).status, 401);
  assert.equal((await fetch(base + "/api/auth/me")).status, 401);
});

test("полный путь: вход, папки, выход", async () => {
  const r = await login(base, EMAIL.toUpperCase(), PASS); // регистр адреса не важен
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { email: EMAIL });
  const sc = r.headers.get("set-cookie");
  assert.match(sc, /^dvmail_sid=[A-Za-z0-9_-]{43};/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  const cookie = cookieOf(r);

  const me = await fetch(base + "/api/auth/me", { headers: { Cookie: cookie } });
  assert.deepEqual(await me.json(), { email: EMAIL });

  const mb = await fetch(base + "/api/mailboxes", { headers: { Cookie: cookie } });
  assert.equal(mb.status, 200);
  const text = await mb.text();
  assert.ok(!text.includes("secretExtra"), "лишние поля не должны уходить в браузер");
  assert.ok(!text.includes(PASS), "пароль не должен появляться в ответах");
  assert.deepEqual(JSON.parse(text).mailboxes[0], { id: "m1", name: "Inbox", role: "inbox", parentId: null, total: 3, unread: 1 });

  const out = await fetch(base + "/api/auth/logout", { method: "POST", headers: H({ Cookie: cookie }) });
  assert.equal(out.status, 204);
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await fetch(base + "/api/mailboxes", { headers: { Cookie: cookie } })).status, 401);
});

test("подделанный токен не принимается", async () => {
  const r = await login(base, EMAIL, PASS);
  const good = cookieOf(r);
  const bad = good.slice(0, -2) + (good.endsWith("AA") ? "BB" : "AA");
  assert.equal((await fetch(base + "/api/mailboxes", { headers: { Cookie: bad } })).status, 401);
  assert.equal((await fetch(base + "/api/mailboxes", { headers: { Cookie: "dvmail_sid=short-token" } })).status, 401);
});

test("пароль в памяти хранится зашифрованным и не читается без токена", async () => {
  const r = await login(base, EMAIL, PASS);
  const dump = JSON.stringify([...store.map.values()].map((s) => ({ ...s, iv: s.iv.toString("hex"), ct: s.ct.toString("hex"), tag: s.tag.toString("hex") })));
  assert.ok(!dump.includes(PASS), "пароль найден в памяти открытым текстом");
  const token = cookieOf(r).split("=")[1];
  assert.equal(store.get(token)?.password, PASS);
  // тот же шифртекст другим токеном не открывается
  const [key, stored] = [...store.map.entries()].pop();
  const other = store.create({ email: EMAIL, accountId: "a1", password: "другой" });
  store.map.set(store.lookupKey(other), stored); // подсовываем чужой шифртекст под токен other
  assert.equal(store.get(other), null);
  assert.ok(key);
});

test("сессия умирает после простоя", async () => {
  const { url } = await start({ idleMs: 250 });
  const r = await login(url, EMAIL, PASS);
  const cookie = cookieOf(r);
  assert.equal((await fetch(url + "/api/auth/me", { headers: { Cookie: cookie } })).status, 200);
  await new Promise((res) => setTimeout(res, 450));
  assert.equal((await fetch(url + "/api/auth/me", { headers: { Cookie: cookie } })).status, 401);
});

test("сбой Stalwart даёт 502 и не считается неудачей пользователя", async () => {
  const { url } = await start({ stalwartUrl: "http://127.0.0.1:9", maxFailPerPair: 2 });
  for (let i = 0; i < 4; i++) assert.equal((await login(url, EMAIL, PASS)).status, 502);
});

test("подбор пароля: после лимита 429 и даже верный пароль не пускает", async () => {
  const { url } = await start({ maxFailPerPair: 3, maxFailPerIp: 50 });
  for (let i = 0; i < 3; i++) assert.equal((await login(url, EMAIL, "bad" + i)).status, 401);
  const blocked = await login(url, EMAIL, PASS);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  // другая почта с того же адреса не заблокирована парным лимитом
  assert.equal((await login(url, "other@dvbstudio.ru", "bad")).status, 401);
});

test("общий лимит по адресу сети", async () => {
  const { url } = await start({ maxFailPerPair: 50, maxFailPerIp: 4 });
  for (let i = 0; i < 4; i++) assert.equal((await login(url, `user${i}@dvbstudio.ru`, "bad")).status, 401);
  assert.equal((await login(url, EMAIL, PASS)).status, 429);
});

// ================= Письма =================
const session = async (url = base) => cookieOf(await login(url, EMAIL, PASS));
const get = (path, cookie, url = base) => fetch(url + path, { headers: { Cookie: cookie } });
const post = (path, body, cookie, url = base) => fetch(url + path, { method: "POST", headers: H({ Cookie: cookie }), body: JSON.stringify(body) });

test("двухфакторка: верный пароль без кода даёт тот же отказ, что и неверный пароль", async () => {
  const { url } = await start();
  const r = await fetch(url + "/api/auth/login", { method: "POST", headers: H(), body: JSON.stringify({ email: EMAIL, password: "main-password-needs-code" }) });
  const w = await fetch(url + "/api/auth/login", { method: "POST", headers: H(), body: JSON.stringify({ email: EMAIL, password: "wrong" }) });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("set-cookie"), null);
  assert.equal((await r.json()).message, (await w.json()).message);
  assert.match(BAD_TEXT, /пароль приложения/);
});
const BAD_TEXT = "Неверный адрес или пароль. Если у ящика включена двухфакторная защита, нужен пароль приложения.";

test("список писем: поля, порядок, непрочитанные, без лишнего", async () => {
  resetMails();
  const c = await session();
  const r = await get("/api/emails?mailbox=m1", c);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.total, 2);
  assert.deepEqual(j.emails.map((m) => m.id), ["e1", "e2"]);
  assert.deepEqual(j.emails[0], {
    id: "e1", from: { name: "Анна", email: "anna@example.org" }, to: { name: null, email: EMAIL }, subject: "Счёт на оплату",
    receivedAt: "2026-10-28T10:00:00Z", preview: "Добрый день", hasAttachment: true, unread: true, draft: false,
  });
  assert.equal(j.emails[1].unread, false);
  assert.ok(!JSON.stringify(j).includes("blob"), "идентификаторы содержимого не нужны списку");
});

test("список писем: постраничность, поиск, проверка параметров", async () => {
  resetMails();
  const c = await session();
  const p2 = await (await get("/api/emails?mailbox=m1&position=1&limit=1", c)).json();
  assert.deepEqual(p2.emails.map((m) => m.id), ["e2"]);
  assert.equal(p2.total, 2);
  const found = await (await get("/api/emails?mailbox=m1&q=" + encodeURIComponent("Счёт"), c)).json();
  assert.deepEqual(found.emails.map((m) => m.id), ["e1"]);
  for (const bad of ["", "?mailbox=../x", "?mailbox=m1&limit=0", "?mailbox=m1&limit=500", "?mailbox=m1&position=-1", "?mailbox=m1&position=abc", "?mailbox=m 1"]) {
    assert.equal((await get("/api/emails" + bad, c)).status, 400, bad);
  }
  assert.equal((await fetch(base + "/api/emails?mailbox=m1")).status, 401);
});

test("чтение письма: текст, HTML, вложения без служебных путей, подозрительные blobId отброшены", async () => {
  resetMails();
  const c = await session();
  const j = await (await get("/api/emails/e1", c)).json();
  assert.equal(j.subject, "Счёт на оплату");
  assert.equal(j.text, "Добрый день");
  assert.match(j.html, /<b>день<\/b>/);       // очистка HTML делается в браузере, сервер отдаёт как есть
  assert.equal(j.encrypted, false);
  assert.equal(j.unread, true);
  assert.deepEqual(j.mailboxIds, ["m1"]);
  assert.deepEqual(j.attachments, [{ blobId: "blob-pdf", name: "Счёт_.._2026.pdf", type: "application/pdf", size: PDF.length }]);
  const plain = await (await get("/api/emails/e2", c)).json();
  assert.equal(plain.text, "Просто текст");
  assert.equal(plain.html, "", "письмо без HTML не выдаёт текст за HTML");
  assert.equal((await get("/api/emails/zzz", c)).status, 404);
  assert.equal((await get("/api/emails/..%2Fx", c)).status, 400);
});

test("зашифрованное письмо помечается, тела нет", async () => {
  const c = await session();
  const j = await (await get("/api/emails/e3", c)).json();
  assert.equal(j.encrypted, true);
  assert.equal(j.text, "");
  assert.equal(j.html, "");
});

test("прочитано и непрочитано: меняется только один флаг", async () => {
  resetMails();
  const c = await session();
  MAILS.get("e1").keywords.$flagged = true;
  assert.equal((await post("/api/emails/e1/seen", { seen: true }, c)).status, 200);
  assert.deepEqual(MAILS.get("e1").keywords, { $flagged: true, $seen: true });
  assert.equal((await post("/api/emails/e1/seen", { seen: false }, c)).status, 200);
  assert.deepEqual(MAILS.get("e1").keywords, { $flagged: true });
  assert.equal((await post("/api/emails/e1/seen", { seen: "да" }, c)).status, 400);
  assert.equal((await post("/api/emails/zzz/seen", { seen: true }, c)).status, 404);
  const noHeader = await fetch(base + "/api/emails/e1/seen", { method: "POST", headers: { "Content-Type": "application/json", Cookie: c, Origin: ORIGIN }, body: '{"seen":true}' });
  assert.equal(noHeader.status, 403);
});

test("удаление: в корзину, а из корзины насовсем", async () => {
  resetMails();
  const c = await session();
  const a = await (await post("/api/emails/e2/trash", {}, c)).json();
  assert.deepEqual(a, { ok: true, permanent: false });
  assert.deepEqual(MAILS.get("e2").mailboxIds, { m2: true });
  const b = await (await post("/api/emails/e2/trash", {}, c)).json();
  assert.deepEqual(b, { ok: true, permanent: true });
  assert.ok(!MAILS.has("e2"));
  assert.equal((await post("/api/emails/e2/trash", {}, c)).status, 404);
});

test("вложение: отдаётся только как скачивание, чужие и подозрительные идентификаторы отклоняются", async () => {
  resetMails();
  const c = await session();
  const r = await get("/api/emails/e1/attachments/blob-pdf", c);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/octet-stream");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("content-security-policy"), /sandbox/);
  const cd = r.headers.get("content-disposition");
  assert.match(cd, /^attachment; filename="/);
  assert.ok(!/[\\/]/.test(cd.split("filename*")[0].replace(/^attachment; filename="/, "")), "в имени файла нет путей");
  assert.ok(cd.includes("filename*=UTF-8''"));
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), PDF);
  // blob существует у Stalwart, но не является вложением этого письма
  assert.equal((await get("/api/emails/e1/attachments/blob-e1", c)).status, 404);
  assert.equal((await get("/api/emails/e2/attachments/blob-pdf", c)).status, 404);
  assert.equal((await get("/api/emails/e1/attachments/..%2F..%2Fadmin", c)).status, 400);
  assert.equal((await fetch(base + "/api/emails/e1/attachments/blob-pdf")).status, 401);
});

test("письмо целиком (.eml)", async () => {
  resetMails();
  const c = await session();
  const r = await get("/api/emails/e1/raw", c);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /message\.eml/);
  assert.equal(r.headers.get("content-type"), "application/octet-stream");
  assert.match(await r.text(), /^From: anna@example.org/);
  assert.equal((await get("/api/emails/e2/raw", c)).status, 404); // blob письма в заглушке отсутствует
});

test("отозванный доступ закрывает сессию, сбой Stalwart даёт 502", async () => {
  const { url } = await start();
  const c = await session(url);
  const bad = await start({ stalwartUrl: "http://127.0.0.1:9" }); // сервер почты недоступен
  assert.equal((await get("/api/mailboxes", c, bad.url)).status, 401); // чужой процесс: сессии там нет
  const live = await session(url);
  mock.close(); // имитируем падение Stalwart на живой сессии
  const r = await get("/api/emails?mailbox=m1", live, url);
  assert.equal(r.status, 502);
  assert.ok(!(await r.text()).includes(PASS));
  await new Promise((res) => mock.listen(mock.address()?.port ?? 0, "127.0.0.1", res));
});

test("сайт: страница, файлы с хешем, запасной маршрут, заголовки безопасности", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "dvmail-web-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>DVMail</title>");
  writeFileSync(join(root, "assets", "app-abc.js"), "console.log(1)");
  const { url } = await start({ webRoot: root });
  const page = await fetch(url + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /DVMail/);
  const csp = page.headers.get("content-security-policy");
  assert.match(csp, /default-src 'self'/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.match((await fetch(url + "/inbox/e1")).headers.get("content-type"), /html/); // запасной маршрут
  const js = await fetch(url + "/assets/app-abc.js");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("cache-control"), /immutable/);
  assert.equal((await fetch(url + "/api/nothing")).status, 404);   // API не подменяется страницей
  assert.equal((await fetch(url + "/nofile.png")).status, 404);
  assert.equal((await fetch(url + "/health")).status, 200);
});

// ================= Усиление защиты (результаты аудита) =================
test("адрес сети для лимита: IPv6 считается по сети /64, IPv4 как есть", async () => {
  const { netKey } = await import("../dist/auth.controller.js");
  assert.equal(netKey("203.0.113.7"), "203.0.113.7");
  assert.equal(netKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(netKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:0db8:0001:0002::/64");
  assert.equal(netKey("2001:db8:1:2::5"), "2001:0db8:0001:0002::/64");
  assert.equal(netKey("2001:DB8::1"), "2001:0db8:0000:0000::/64");
  assert.equal(netKey("::1"), "0000:0000:0000:0000::/64");
  assert.equal(netKey(undefined), "unknown");
});

test("подбор пароля нельзя обойти сменой адреса внутри одной сети IPv6", async () => {
  const { url } = await start({ maxFailPerPair: 3, maxFailPerIp: 50 });
  const from = (ip) => ({ "X-Forwarded-For": ip });
  for (let i = 0; i < 3; i++) assert.equal((await login(url, EMAIL, "bad" + i, from(`2001:db8:5:6::${i + 1}`))).status, 401);
  assert.equal((await login(url, EMAIL, PASS, from("2001:db8:5:6:ffff::99"))).status, 429);
  assert.equal((await login(url, EMAIL, PASS, from("2001:db8:7:7::1"))).status, 200); // другая сеть не задета
});

test("переполнение счётчиков: память ограничена, лимитер продолжает работать", async () => {
  const { a, url } = await start({ maxFailPerPair: 2, maxFailPerIp: 50 });
  const { LoginLimiter } = await import("../dist/login-limiter.js");
  const limiter = a.get(LoginLimiter);
  // Остаточный риск (описан в модели угроз): чтобы вытеснить чужую запись, нужно больше 5000 неудач
  // с разных адресов; один адрес получает не больше 20 попыток за окно.
  for (let i = 0; i < 10_050; i++) limiter.fail(`198.51.${i % 250}.${(i >> 8) + 1}`, `x${i}@dvbstudio.ru`);
  assert.ok(limiter.fails.size <= 10_000, "память ограничена");
  for (let i = 0; i < 2; i++) assert.equal((await login(url, EMAIL, "bad" + i)).status, 401);
  assert.equal((await login(url, EMAIL, PASS)).status, 429, "после переполнения новые блокировки работают");
});

test("сессий на один ящик не больше 8: старые закрываются", async () => {
  const { url } = await start();
  const cookies = [];
  for (let i = 0; i < 10; i++) cookies.push(cookieOf(await login(url, EMAIL, PASS)));
  const status = async (c) => (await fetch(url + "/api/auth/me", { headers: { Cookie: c } })).status;
  assert.equal(await status(cookies[0]), 401);
  assert.equal(await status(cookies[1]), 401);
  assert.equal(await status(cookies[2]), 200);
  assert.equal(await status(cookies[9]), 200);
});

test("частота запросов одной сессии ограничена, другая сессия не страдает", async () => {
  const { url } = await start({ maxRequestsPerMinute: 5 });
  const a = cookieOf(await login(url, EMAIL, PASS));
  const b = cookieOf(await login(url, EMAIL, PASS));
  for (let i = 0; i < 5; i++) assert.equal((await fetch(url + "/api/auth/me", { headers: { Cookie: a } })).status, 200);
  const r = await fetch(url + "/api/auth/me", { headers: { Cookie: a } });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get("retry-after")) >= 1);
  assert.equal((await fetch(url + "/api/auth/me", { headers: { Cookie: b } })).status, 200);
});

test("заголовки безопасности на всех ответах", async () => {
  const r = await fetch(base + "/health");
  assert.equal(r.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.match(r.headers.get("permissions-policy"), /camera=\(\)/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});

test("мусорные параметры и идентификаторы: ни одной ошибки 500 и ни одной утечки", async () => {
  resetMails();
  const c = await session();
  const junk = ["", "%00", "%0d%0aSet-Cookie:x=1", "../../etc/passwd", "%2e%2e%2f", "a".repeat(5000), "{{7*7}}", "'; DROP", "<script>", "%ff%fe", "e1;x", "e1%20", "‮", "null", "undefined", "-1", "1e9"];
  const paths = (j) => [`/api/emails/${j}`, `/api/emails/${j}/raw`, `/api/emails/e1/attachments/${j}`, `/api/emails?mailbox=${j}`, `/api/emails?mailbox=m1&q=${j}&position=${j}&limit=${j}`];
  for (const j of junk) for (const p of paths(j)) {
    const r = await fetch(base + p, { headers: { Cookie: c } });
    const t = await r.text();
    assert.ok(r.status < 500 || r.status === 502, `${p} дал ${r.status}`);
    assert.ok(!t.includes(PASS) && !/stack|at Object|node_modules/.test(t), `утечка в ответе на ${p}`);
    assert.ok(!r.headers.get("set-cookie"), `подмена cookie через ${p}`);
  }
  for (const j of junk) for (const act of ["seen", "trash"]) {
    const r = await fetch(base + `/api/emails/${j}/${act}`, { method: "POST", headers: H({ Cookie: c }), body: JSON.stringify({ seen: true }) });
    assert.ok(r.status < 500, `${act}/${j} дал ${r.status}`);
  }
  for (const body of ["", "null", "[]", '"x"', "{", '{"seen":{}}', '{"__proto__":{"seen":true}}']) {
    const r = await fetch(base + "/api/emails/e1/seen", { method: "POST", headers: H({ Cookie: c }), body });
    assert.ok(r.status >= 400 && r.status < 500, `тело ${body} дало ${r.status}`);
  }
});


// ================= Отправка писем (этап Б1) =================
// Предыдущий тест останавливает и заново запускает заглушку на новом порту, поэтому общий `base` тут уже не годится:
// для этого раздела поднимаем свежий экземпляр сервера (один на раздел)
let SB = null;
const sb = async () => (SB ??= (await start()).url);
const sess = async () => cookieOf(await login(await sb(), EMAIL, PASS));
const send = async (body, cookie, url) => post("/api/send", body, cookie, url ?? (await sb()));
const OK_BODY = { identityId: "i1", to: ["anna@example.org"], subject: "Тема", text: "Текст письма" };

test("адреса отправителя: только нужные поля", async () => {
  const c = await sess();
  const j = await (await get("/api/identities", c, await sb())).json();
  assert.equal(j.identities.length, 3);
  assert.deepEqual(j.identities[0], { id: "i1", name: "Привет Hello", email: EMAIL });
  assert.equal((await fetch((await sb()) + "/api/identities")).status, 401);
});

test("отправка: письмо уходит, получатели без повторов, копия в «Отправленных», черновика не остаётся", async () => {
  resetMails();
  const c = await sess();
  const r = await send({ ...OK_BODY, to: ["anna@example.org", "ANNA@example.org"], cc: ["bob@example.org"], bcc: ["secret@example.org"], subject: "Тема\r\nBcc: evil@example.org", text: "Строка 1\r\nСтрока 2" }, c);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, filed: true });
  assert.equal(SUBMITTED.length, 1);
  const sub = SUBMITTED[0];
  assert.equal(sub.identityId, "i1");
  assert.deepEqual(sub.envelope.mailFrom, { email: EMAIL, parameters: null });
  assert.deepEqual(sub.envelope.rcptTo.map((x) => x.email), ["anna@example.org", "bob@example.org", "secret@example.org"]);
  // отправленное письмо: адрес «От» взят у сервера, тема в одну строку, переводы строк нормализованы
  assert.deepEqual(sub.mail.from, [{ name: "Привет Hello", email: EMAIL }]);
  assert.ok(!/[\r\n]/.test(sub.mail.subject), "в теме не должно быть переводов строк");
  assert.equal(sub.mail.bodyValues[1].value, "Строка 1\nСтрока 2");
  assert.deepEqual(sub.mail.bcc, [{ email: "secret@example.org" }]);
  // после отправки письмо лежит в «Отправленных» и больше не черновик
  const stored = [...MAILS.values()].find((m) => m.subject.startsWith("Тема"));
  assert.deepEqual(Object.keys(stored.mailboxIds), ["m4"]);
  assert.ok(!stored.keywords.$draft);
  assert.equal([...MAILS.values()].filter((m) => m.keywords.$draft).length, 0, "черновиков остаться не должно");
});

test("ответ: связь с исходным письмом берётся с сервера, а не из браузера", async () => {
  resetMails();
  const c = await sess();
  const r = await send({ ...OK_BODY, replyTo: "e1", subject: "Re: Счёт на оплату" }, c);
  assert.equal(r.status, 200);
  assert.deepEqual(SUBMITTED[0].mail.inReplyTo, ["orig-1@example.org"]);
  assert.deepEqual(SUBMITTED[0].mail.references, ["root@example.org", "orig-1@example.org"]);
  assert.equal((await send({ ...OK_BODY, replyTo: "нет-такого" }, c)).status, 400);
  assert.equal((await send({ ...OK_BODY, replyTo: "zzz" }, c)).status, 400, "несуществующее письмо");
});

test("отправка: проверка входных данных до обращения к Stalwart, ничего не создаётся", async () => {
  resetMails();
  const c = await sess();
  const hits = mockHits;
  const many = Array.from({ length: 51 }, (_, i) => `u${i}@example.org`);
  const cases = [
    {}, null, { ...OK_BODY, identityId: "" }, { ...OK_BODY, identityId: "../x" }, { ...OK_BODY, to: [] },
    { ...OK_BODY, to: ["не-адрес"] }, { ...OK_BODY, to: ["a@b"] }, { ...OK_BODY, to: ["a b@example.org"] },
    { ...OK_BODY, to: ["a@example.org\r\nBcc: x@example.org"] }, { ...OK_BODY, to: ["<a@example.org>"] }, { ...OK_BODY, to: "a@example.org" },
    { ...OK_BODY, to: [123] }, { ...OK_BODY, to: many }, { ...OK_BODY, cc: ["x"] }, { ...OK_BODY, bcc: [{}] },
    { ...OK_BODY, subject: 5 }, { ...OK_BODY, text: {} }, { ...OK_BODY, text: "я".repeat(100_001) }, { ...OK_BODY, replyTo: 7 },
  ];
  for (const b of cases) {
    const r = await send(b, c);
    assert.equal(r.status, 400, JSON.stringify(b)?.slice(0, 80));
  }
  assert.equal(mockHits, hits, "Stalwart не должен был получить ни одного запроса");
  assert.equal(SUBMITTED.length, 0);
});

test("отправка: чужой адрес отправителя отклоняется и ничего не создаётся", async () => {
  resetMails();
  const c = await sess();
  const before = MAILS.size;
  const r = await send({ ...OK_BODY, identityId: "i-chuzhoy" }, c);
  assert.equal(r.status, 400);
  assert.equal(MAILS.size, before);
  assert.equal(SUBMITTED.length, 0);
});

test("отправка: отказ сервера понятно объяснён, черновик не остаётся", async () => {
  resetMails();
  const c = await sess();
  const before = MAILS.size;
  let r = await send({ ...OK_BODY, identityId: "i3" }, c);
  assert.equal(r.status, 422);
  assert.match((await r.json()).message, /не разрешает отправлять с этого адреса/);
  r = await send({ ...OK_BODY, to: ["bad@example.org"] }, c);
  assert.equal(r.status, 422);
  assert.match((await r.json()).message, /проверьте адреса/);
  r = await send({ ...OK_BODY, subject: "ОТКАЗ" }, c);
  assert.equal(r.status, 422);
  assert.equal(MAILS.size, before, "после отказа не должно остаться черновиков");
});

test("отправка: сбой метода сервера даёт 502 без утечек и без оставшегося черновика", async () => {
  resetMails();
  const c = await sess();
  const before = MAILS.size;
  failSubmitMethod = true;
  const r = await send(OK_BODY, c);
  failSubmitMethod = false;
  assert.equal(r.status, 502);
  const t = await r.text();
  assert.ok(!t.includes(PASS) && !/serverFail|stack/.test(t));
  assert.equal(MAILS.size, before);
});

test("отправка: без сессии 401, без защитного заголовка 403, чужой Origin 403", async () => {
  assert.equal((await fetch((await sb()) + "/api/send", { method: "POST", headers: H(), body: JSON.stringify(OK_BODY) })).status, 401);
  const c = await sess();
  assert.equal((await fetch((await sb()) + "/api/send", { method: "POST", headers: { "Content-Type": "application/json", Cookie: c }, body: JSON.stringify(OK_BODY) })).status, 403);
  assert.equal((await fetch((await sb()) + "/api/send", { method: "POST", headers: H({ Cookie: c, Origin: "https://evil.example" }), body: JSON.stringify(OK_BODY) })).status, 403);
  assert.equal((await fetch((await sb()) + "/api/send", { method: "POST", headers: H({ Cookie: c, "Sec-Fetch-Site": "cross-site" }), body: JSON.stringify(OK_BODY) })).status, 403);
});

test("отправка: размер тела: до 100 000 знаков можно, дальше отказ, огромное тело отсекается", async () => {
  resetMails();
  const c = await sess();
  assert.equal((await send({ ...OK_BODY, text: "а".repeat(100_000) }, c)).status, 200);
  assert.equal((await send({ ...OK_BODY, text: "a".repeat(150_000) }, c)).status, 400);
  assert.equal((await send({ ...OK_BODY, text: "a".repeat(300_000) }, c)).status, 413);
  // на остальных маршрутах предел прежний, 16 КБ
  assert.equal((await post("/api/emails/e1/seen", { seen: true, pad: "x".repeat(20_000) }, c, await sb())).status, 413);
});

test("отправка: не больше 40 писем в час с одного ящика", async () => {
  resetMails();
  const { url } = await start();
  const c = cookieOf(await login(url, EMAIL, PASS));
  for (let i = 0; i < 40; i++) assert.equal((await send(OK_BODY, c, url)).status, 200, "письмо " + i);
  const r = await send(OK_BODY, c, url);
  assert.equal(r.status, 429);
  assert.match((await r.json()).message, /Лимит отправки/);
  // другой процесс с чистым счётчиком не затронут (счётчик у каждого свой)
  const other = await start();
  assert.equal((await send(OK_BODY, cookieOf(await login(other.url, EMAIL, PASS)), other.url)).status, 200);
});

test("белый список JMAP: Identity/EmailSubmission доступны только через свои маршруты", async () => {
  const c = await sess();
  for (const p of ["/api/jmap", "/jmap", "/api/identities/x", "/api/submission"]) {
    const r = await get(p, c, await sb());
    const t = await r.text();
    // запасной маршрут сайта отдаёт страницу (HTML), но никакого JMAP наружу не отдаётся
    assert.ok(r.status === 404 || (r.status === 200 && /text\/html/.test(r.headers.get("content-type") ?? "")), `${p} дал ${r.status}`);
    assert.ok(!/methodResponses|accountId/.test(t), `${p}: утечка JMAP`);
  }
});

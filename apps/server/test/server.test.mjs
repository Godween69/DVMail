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

// ---- Заглушка Stalwart ----
let mockHits = 0;
const mock = http.createServer((req, res) => {
  mockHits++;
  const ok = req.headers.authorization === BASIC;
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (!ok) return send(401, { error: "unauthorized" });
  if (req.method === "GET" && req.url === "/jmap/session") {
    return send(200, { primaryAccounts: { "urn:ietf:params:jmap:mail": "a1" }, accounts: { a1: {} }, apiUrl: "https://mail.example/jmap/" });
  }
  if (req.method === "POST" && req.url === "/jmap/") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const call = JSON.parse(body).methodCalls[0];
      if (call[0] !== "Mailbox/get" || call[1].accountId !== "a1") return send(200, { methodResponses: [["error", { type: "unknownMethod" }, "0"]] });
      send(200, { methodResponses: [["Mailbox/get", { accountId: "a1", list: [
        { id: "m1", name: "Inbox", role: "inbox", totalEmails: 3, unreadEmails: 1, secretExtra: "не должно уйти в браузер" },
      ] }, "0"]] });
    });
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
  assert.deepEqual(JSON.parse(text).mailboxes, [{ id: "m1", name: "Inbox", role: "inbox", parentId: null, total: 3, unread: 1 }]);

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

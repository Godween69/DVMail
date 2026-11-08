// Тесты второго фактора (DV Auth). Вместо настоящих сервисов работают заглушки Stalwart и DV Auth.
// Заглушка DV Auth повторяет контракт из docs/API.md репозитория DV Auth (талон, способы, коды, чат, настройки).
// Запуск: npm test (из корня или из apps/server). Сборка идёт перед тестами.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.DVMAIL_LOG = "quiet";
const { createApp } = await import("../dist/bootstrap.js");
const { loadConfig } = await import("../dist/config.js");

const EMAIL = "hello@dvbstudio.ru";
const PASS = "app-pass-correct-123";
const ORIGIN = "https://webmail.test";
const SECRET = "s".repeat(40);
const BASIC = "Basic " + Buffer.from(`${EMAIL}:${PASS}`).toString("base64");

// ---- Заглушка Stalwart: знает один пароль, аккаунт a1 ----
const stalwart = http.createServer((req, res) => {
  if (req.headers.authorization !== BASIC) { res.writeHead(401); return res.end("{}"); }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ primaryAccounts: { "urn:ietf:params:jmap:mail": "a1" }, accounts: { a1: {} } }));
});

// ---- Заглушка DV Auth ----
const D = { // состояние заглушки (сбрасывается перед каждым тестом)
  factors: new Map(),      // subject -> { chat: bool, totp: bool, recovery: int }
  tickets: new Map(),      // талон -> subject
  chatApprove: null,       // чей subject вернуть при подтверждении в чате (null: ещё ждём)
  codeSubject: null,       // что вернуть как subject при верном коде (null: тот же, чей талон)
  mode: "ok",              // ok | down | unauthorized | redirect
  seen: [],                // что приложение отправило в DV Auth
  chatLinked: false, totpStarted: false,
};
function resetD() {
  D.factors = new Map(); D.tickets = new Map(); D.chatApprove = null; D.codeSubject = null; D.mode = "ok"; D.seen = [];
  D.chatLinked = false; D.totpStarted = false;
}
const GOOD_CODE = "123456", GOOD_TOTP_ENABLE = "654321", BAD_STATUS_CODE = 401;
const dvauth = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (D.mode === "down") { req.socket.destroy(); return; }
  if (D.mode === "redirect") { res.writeHead(302, { Location: "http://evil.example/" }); return res.end(); }
  if (req.headers.authorization !== `Bearer ${SECRET}` || D.mode === "unauthorized") return send(401, { error: "unauthorized", message: "bad secret" });
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    D.seen.push({ method: req.method, path: url.pathname, body, query: Object.fromEntries(url.searchParams) });
    const f = (s) => D.factors.get(s);
    if (url.pathname === "/v1/status") {
      const x = f(url.searchParams.get("subject")) ?? { chat: false, totp: false, recovery: 0 };
      return send(200, { enabled: x.chat || x.totp, chatAvailable: true, chatLinked: x.chat, matrixId: x.chat ? "@anna:example.org" : null, totpAvailable: true, totpEnabled: x.totp, recoveryLeft: x.recovery, methods: [x.chat && "chat", x.totp && "totp", x.recovery && "recovery"].filter(Boolean) });
    }
    if (url.pathname === "/v1/login/begin") {
      const x = f(body.subject);
      if (!x || !(x.chat || x.totp)) return send(200, { required: false });
      const t = "T".repeat(10) + Math.random().toString(36).slice(2, 14).padEnd(12, "x");
      D.tickets.set(t, body.subject);
      return send(200, { required: true, ticket: t, methods: [x.chat && "chat", x.totp && "totp", "recovery"].filter(Boolean) });
    }
    if (url.pathname === "/v1/login/code") {
      const subject = D.tickets.get(body.ticket);
      if (!subject) return send(401, { error: "ticket_expired", message: "Талон истёк, войдите заново" });
      if (body.code !== GOOD_CODE) return send(401, { error: "invalid_code", message: "Неверный код" });
      D.tickets.delete(body.ticket);
      return send(200, { ok: true, subject: D.codeSubject ?? subject });
    }
    if (url.pathname === "/v1/login/chat/start") {
      if (!D.tickets.has(body.ticket)) return send(401, { error: "ticket_expired", message: "Талон истёк" });
      return send(200, { challenge: "c1", number: "472", qr: "dvchat://auth#abc", expiresIn: 180 });
    }
    if (url.pathname === "/v1/login/chat/status") {
      const subject = D.tickets.get(body.ticket);
      if (!subject) return send(200, { state: "none" });
      if (D.chatApprove) return send(200, { state: "approved", subject: D.chatApprove });
      return send(200, { state: "pending" });
    }
    if (url.pathname === "/v1/totp/begin") { D.totpStarted = true; return send(200, { secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/DVMail:hello?secret=JBSWY3DPEHPK3PXP" }); }
    if (url.pathname === "/v1/totp/enable") {
      if (!D.totpStarted || body.code !== GOOD_TOTP_ENABLE) return send(400, { error: "invalid_code", message: "Код не подошёл" });
      D.factors.set(body.subject, { ...(f(body.subject) ?? { chat: false }), totp: true, recovery: 10 });
      return send(200, { recoveryCodes: ["AAAA-AAAA-AAAA"] });
    }
    if (url.pathname === "/v1/totp/disable") { const x = f(body.subject); if (x) x.totp = false; return send(200, { ok: true }); }
    if (url.pathname === "/v1/check") return body.code === GOOD_CODE ? send(200, { ok: true }) : send(401, { error: "invalid_code", message: "Неверный код" });
    if (url.pathname === "/v1/recovery/new") return send(200, { recoveryCodes: ["BBBB-BBBB-BBBB"] });
    if (url.pathname === "/v1/chat/link/start") return send(200, { challenge: "l1", number: "815", qr: "dvchat://link#xyz", expiresIn: 180 });
    if (url.pathname === "/v1/chat/link/status") return send(200, { state: D.chatLinked ? "approved" : "pending" });
    if (url.pathname === "/v1/chat/unlink") { const x = f(body.subject); if (x) x.chat = false; return send(200, { ok: true }); }
    send(404, { error: "not_found", message: "нет такого адреса" });
  });
});

const apps = [];
async function start(over = {}) {
  const { app } = await createApp({
    stalwartUrl: `http://127.0.0.1:${stalwart.address().port}`, cookieSecure: false, allowedOrigin: ORIGIN, host: "127.0.0.1",
    authUrl: `http://127.0.0.1:${dvauth.address().port}`, authSecret: SECRET, ...over,
  });
  await app.listen(0, "127.0.0.1");
  apps.push(app);
  return `http://127.0.0.1:${app.getHttpServer().address().port}`;
}
const H = (extra = {}) => ({ "Content-Type": "application/json", "X-Requested-With": "dvmail", Origin: ORIGIN, ...extra });
const post = (base, path, body, cookie) => fetch(base + path, { method: "POST", headers: H(cookie ? { Cookie: cookie } : {}), body: JSON.stringify(body ?? {}) });
const cookiesOf = (r) => Object.fromEntries(r.headers.getSetCookie().map((c) => c.split(";")[0].split("=")).map(([k, v]) => [k, v ?? ""]));
const jar = (c) => Object.entries(c).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");
const login = (base, password = PASS) => post(base, "/api/auth/login", { email: EMAIL, password });
const meStatus = async (base, cookie) => (await fetch(base + "/api/auth/me", { headers: { Cookie: cookie } })).status;

before(async () => {
  await new Promise((r) => stalwart.listen(0, "127.0.0.1", r));
  await new Promise((r) => dvauth.listen(0, "127.0.0.1", r));
});
after(async () => { for (const a of apps) await a.close(); stalwart.close(); dvauth.close(); });

// ---------- Настройки ----------
test("настройки: адрес и секрет DV Auth задаются только вместе", () => {
  assert.throws(() => loadConfig({ authUrl: "http://x:1", authSecret: "" }), /вместе/);
  assert.throws(() => loadConfig({ authUrl: "", authSecret: SECRET }), /вместе/);
  assert.throws(() => loadConfig({ authUrl: "http://x:1", authSecret: "коротко" }), /32/);
  assert.throws(() => loadConfig({ authUrl: "ftp://x", authSecret: SECRET }), /http/);
  assert.equal(loadConfig({ authUrl: "", authSecret: "" }).authUrl, "");
});

// ---------- Без DV Auth: всё как раньше ----------
test("DV Auth не подключён: вход по паролю, настройки недоступны", async () => {
  resetD();
  const base = await start({ authUrl: "", authSecret: "" });
  const r = await login(base);
  assert.equal(r.status, 200);
  const c = cookiesOf(r);
  assert.ok(c.dvmail_sid);
  assert.equal(D.seen.length, 0, "DV Auth не должен вызываться");
  const sec = await fetch(base + "/api/auth/security", { headers: { Cookie: jar(c) } });
  assert.deepEqual(await sec.json(), { available: false });
  assert.equal((await post(base, "/api/auth/security/totp/begin", { password: PASS }, jar(c))).status, 404);
});

// ---------- Вход ----------
test("подключён, второго фактора у человека нет: вход по паролю, DV Auth получил номер аккаунта и адрес", async () => {
  resetD();
  const base = await start();
  const r = await login(base);
  assert.equal(r.status, 200);
  const c = cookiesOf(r);
  assert.ok(c.dvmail_sid);
  assert.equal(await meStatus(base, jar(c)), 200);
  const begin = D.seen.find((x) => x.path === "/v1/login/begin");
  assert.equal(begin.body.subject, "a1", "идентификатор человека это аккаунт Stalwart, а не адрес почты");
  assert.ok(begin.body.ip);
});

test("второй фактор включён: после пароля сессии нет, браузер не видит талон", async () => {
  resetD(); D.factors.set("a1", { chat: true, totp: true, recovery: 10 });
  const base = await start();
  const r = await login(base);
  assert.equal(r.status, 200);
  const text = await r.text();
  const body = JSON.parse(text);
  assert.deepEqual(body.twoFactor.methods.sort(), ["chat", "recovery", "totp"]);
  assert.ok(!text.includes("TTTTTTTTTT"), "талон DV Auth не должен уходить в браузер");
  const c = cookiesOf(r);
  assert.ok(c.dvmail_pend, "выдана кука ожидающего входа");
  assert.ok(!c.dvmail_sid, "сессия не открыта");
  assert.equal(await meStatus(base, jar(c)), 401);
});

test("неверный пароль до второго шага не доходит: DV Auth не вызывается", async () => {
  resetD(); D.factors.set("a1", { chat: true, totp: false, recovery: 10 });
  const base = await start();
  assert.equal((await login(base, "wrong-password")).status, 401);
  assert.equal(D.seen.length, 0);
});

test("код: неверный отклонён без сессии, верный открывает сессию и гасит ожидание", async () => {
  resetD(); D.factors.set("a1", { chat: false, totp: true, recovery: 10 });
  const base = await start();
  const pend = jar(cookiesOf(await login(base)));
  const bad = await post(base, "/api/auth/2fa/code", { code: "000000" }, pend);
  assert.equal(bad.status, 401);
  assert.ok(!cookiesOf(bad).dvmail_sid);
  const ok = await post(base, "/api/auth/2fa/code", { code: GOOD_CODE }, pend);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).email, EMAIL);
  const c = cookiesOf(ok);
  assert.ok(c.dvmail_sid);
  assert.equal(c.dvmail_pend, "", "кука ожидания очищена");
  assert.equal(await meStatus(base, jar(c)), 200);
  // повторное использование того же ожидания невозможно
  assert.equal((await post(base, "/api/auth/2fa/code", { code: GOOD_CODE }, pend)).status, 401);
});

test("второй шаг без куки ожидания невозможен", async () => {
  resetD(); D.factors.set("a1", { chat: false, totp: true, recovery: 10 });
  const base = await start();
  assert.equal((await post(base, "/api/auth/2fa/code", { code: GOOD_CODE })).status, 401);
  assert.equal((await post(base, "/api/auth/2fa/chat/start", {})).status, 401);
  assert.equal((await post(base, "/api/auth/2fa/chat/status", {})).status, 401);
});

test("DV Auth подтвердил чужой аккаунт: сессия не открывается", async () => {
  resetD(); D.factors.set("a1", { chat: false, totp: true, recovery: 10 }); D.codeSubject = "a2";
  const base = await start();
  const pend = jar(cookiesOf(await login(base)));
  const r = await post(base, "/api/auth/2fa/code", { code: GOOD_CODE }, pend);
  assert.equal(r.status, 401);
  assert.ok(!cookiesOf(r).dvmail_sid);
});

test("чат: QR и число выдаются, пока ждём ответ сессии нет, после подтверждения вход открыт", async () => {
  resetD(); D.factors.set("a1", { chat: true, totp: false, recovery: 10 });
  const base = await start();
  const pend = jar(cookiesOf(await login(base)));
  const st = await (await post(base, "/api/auth/2fa/chat/start", {}, pend)).json();
  assert.equal(st.number, "472");
  assert.match(st.qr, /^dvchat:\/\//);
  const wait = await post(base, "/api/auth/2fa/chat/status", {}, pend);
  assert.deepEqual(await wait.json(), { state: "pending" });
  assert.ok(!cookiesOf(wait).dvmail_sid);
  D.chatApprove = "a1";
  const done = await post(base, "/api/auth/2fa/chat/status", {}, pend);
  const body = await done.json();
  assert.equal(body.state, "approved");
  assert.equal(body.email, EMAIL);
  assert.ok(cookiesOf(done).dvmail_sid);
});

test("чат: подтверждение от чужого аккаунта не открывает сессию", async () => {
  resetD(); D.factors.set("a1", { chat: true, totp: false, recovery: 10 }); D.chatApprove = "a2";
  const base = await start();
  const pend = jar(cookiesOf(await login(base)));
  const r = await post(base, "/api/auth/2fa/chat/status", {}, pend);
  assert.equal(r.status, 401);
  assert.ok(!cookiesOf(r).dvmail_sid);
});

test("«Назад»: ожидающий вход забыт, второй шаг больше не работает", async () => {
  resetD(); D.factors.set("a1", { chat: false, totp: true, recovery: 10 });
  const base = await start();
  const pend = jar(cookiesOf(await login(base)));
  const out = await post(base, "/api/auth/2fa/cancel", {}, pend);
  assert.equal(out.status, 204);
  assert.equal((await post(base, "/api/auth/2fa/code", { code: GOOD_CODE }, pend)).status, 401);
});

test("ожидание живёт ограниченное время", async () => {
  resetD(); D.factors.set("a1", { chat: false, totp: true, recovery: 10 });
  const base = await start({ pendingMs: 150 });
  const pend = jar(cookiesOf(await login(base)));
  await new Promise((r) => setTimeout(r, 250));
  assert.equal((await post(base, "/api/auth/2fa/code", { code: GOOD_CODE }, pend)).status, 401);
});

// ---------- Отказ в доступе, если DV Auth недоступен ----------
for (const mode of ["down", "unauthorized", "redirect"]) {
  test(`DV Auth: ${mode}: вход закрыт (503), сессии и куки нет, даже при верном пароле`, async () => {
    resetD(); D.mode = mode;
    const base = await start();
    const r = await login(base);
    assert.equal(r.status, 503);
    assert.match((await r.json()).message, /второго фактора/);
    assert.deepEqual(cookiesOf(r), {});
  });
}

// ---------- Настройки безопасности ----------
async function session(base) {
  const r = await login(base);
  assert.equal(r.status, 200);
  const c = jar(cookiesOf(r));
  assert.equal(await meStatus(base, c), 200);
  return c;
}

test("безопасность: без сессии закрыто", async () => {
  resetD();
  const base = await start();
  assert.equal((await fetch(base + "/api/auth/security")).status, 401);
  assert.equal((await post(base, "/api/auth/security/totp/begin", { password: PASS })).status, 401);
});

test("безопасность: состояние читается по номеру аккаунта", async () => {
  resetD(); D.factors.set("a1", { chat: true, totp: false, recovery: 7 });
  const base = await start();
  // у человека включён чат, поэтому войти можно только вторым шагом; для проверки настроек берём вход без фактора
  D.factors.clear();
  const c = await session(base);
  D.factors.set("a1", { chat: true, totp: false, recovery: 7 });
  const st = await (await fetch(base + "/api/auth/security", { headers: { Cookie: c } })).json();
  assert.equal(st.available, true);
  assert.equal(st.chatLinked, true);
  assert.equal(st.recoveryLeft, 7);
  assert.equal(D.seen.at(-1).query.subject, "a1");
});

test("безопасность: неверный пароль даёт 403 и не закрывает сессию", async () => {
  resetD();
  const base = await start();
  const c = await session(base);
  const r = await post(base, "/api/auth/security/totp/begin", { password: "wrong" }, c);
  assert.equal(r.status, 403);
  assert.equal(await meStatus(base, c), 200, "сессия жива");
  assert.ok(!D.seen.some((x) => x.path === "/v1/totp/begin"), "DV Auth не вызван");
});

test("безопасность: включение кодов из приложения: пароль, затем первый код; запасные коды выдаются один раз", async () => {
  resetD();
  const base = await start();
  const c = await session(base);
  const b = await post(base, "/api/auth/security/totp/begin", { password: PASS }, c);
  assert.equal(b.status, 200);
  assert.match((await b.json()).uri, /^otpauth:\/\//);
  assert.equal(D.seen.find((x) => x.path === "/v1/totp/begin").body.label, EMAIL);
  const bad = await post(base, "/api/auth/security/totp/enable", { code: "111111" }, c);
  assert.equal(bad.status, 400);
  assert.equal((await post(base, "/api/auth/security/totp/enable", { code: "abc" }, c)).status, 400);
  const ok = await post(base, "/api/auth/security/totp/enable", { code: GOOD_TOTP_ENABLE }, c);
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).recoveryCodes, ["AAAA-AAAA-AAAA"]);
  assert.equal(D.factors.get("a1").totp, true);
});

test("безопасность: когда коды включены, опасное действие требует ещё и код; неверный код это 403", async () => {
  resetD();
  const base = await start();
  const c = await session(base);          // вход, пока фактора нет
  D.factors.set("a1", { chat: false, totp: true, recovery: 10 });
  const noCode = await post(base, "/api/auth/security/recovery/new", { password: PASS }, c);
  assert.equal(noCode.status, 403);
  const badCode = await post(base, "/api/auth/security/recovery/new", { password: PASS, code: "000000" }, c);
  assert.equal(badCode.status, 403);
  assert.equal(await meStatus(base, c), 200);
  const ok = await post(base, "/api/auth/security/recovery/new", { password: PASS, code: GOOD_CODE }, c);
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).recoveryCodes, ["BBBB-BBBB-BBBB"]);
  const off = await fetch(base + "/api/auth/security/totp/disable", { method: "POST", headers: H({ Cookie: c }), body: JSON.stringify({ password: PASS, code: GOOD_CODE }) });
  assert.equal(off.status, 200);
  assert.equal(D.factors.get("a1").totp, false);
});

test("безопасность: привязка и отвязка DVChat", async () => {
  resetD();
  const base = await start();
  const c = await session(base);
  const s = await (await post(base, "/api/auth/security/chat/start", { password: PASS }, c)).json();
  assert.equal(s.number, "815");
  assert.deepEqual(await (await post(base, "/api/auth/security/chat/status", {}, c)).json(), { state: "pending" });
  D.chatLinked = true;
  assert.deepEqual(await (await post(base, "/api/auth/security/chat/status", {}, c)).json(), { state: "approved" });
  D.factors.set("a1", { chat: true, totp: false, recovery: 10 });
  const un = await fetch(base + "/api/auth/security/chat", { method: "DELETE", headers: H({ Cookie: c }), body: JSON.stringify({ password: PASS }) });
  assert.equal(un.status, 200);
  assert.equal(D.factors.get("a1").chat, false);
});

test("безопасность: перебор пароля в настройках ограничен тем же счётчиком, что и вход", async () => {
  resetD();
  const base = await start({ maxFailPerPair: 3 });
  const c = await session(base);
  for (let i = 0; i < 3; i++) assert.equal((await post(base, "/api/auth/security/totp/begin", { password: "wrong" + i }, c)).status, 403);
  const blocked = await post(base, "/api/auth/security/totp/begin", { password: PASS }, c);
  assert.equal(blocked.status, 429);
});

test("безопасность: DV Auth недоступен: настройки отвечают 503, сессия остаётся", async () => {
  resetD();
  const base = await start();
  const c = await session(base);
  D.mode = "down";
  const r = await fetch(base + "/api/auth/security", { headers: { Cookie: c } });
  assert.equal(r.status, 503);
  assert.equal(await meStatus(base, c), 200);
});


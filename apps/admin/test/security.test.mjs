// Тесты безопасности админки: хеш пароля, страница и заголовки, Host, CSRF, вход, лимиты, сессии.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ADMIN_PW, start, stopAll, post, get, cookieOf, loggedIn } from "./helpers.mjs";

const { hashPassword, verifyPassword, generatePassword } = await import("../dist/password.js");

let base, port, hash;
before(async () => { ({ url: base, port, hash } = await start()); });
after(stopAll);

const loggedInAt = (s) => loggedIn(s.url);

test("хеш пароля: верный проходит, неверный нет, формат scrypt", async () => {
  assert.match(hash, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(await verifyPassword(ADMIN_PW, hash), true);
  assert.equal(await verifyPassword("другой пароль", hash), false);
  assert.equal(await verifyPassword(ADMIN_PW, "мусор"), false);
  assert.equal(generatePassword().length, 32);
  assert.notEqual(generatePassword(), generatePassword());
});

test("страница отдаётся, заголовки безопасности на месте", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  assert.match(await r.text(), /Ящики DVMail/);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("x-powered-by"), null);
  assert.match(r.headers.get("content-security-policy"), /default-src 'none'; script-src 'self'/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(r.headers.get("content-security-policy")));
  const js = await fetch(base + "/app.js");
  assert.match(js.headers.get("content-type"), /javascript/);
  const html = await (await fetch(base + "/")).text();
  assert.ok(!/<script(?![^>]*\ssrc=)/i.test(html), "в странице не должно быть встроенных скриптов");
  assert.ok(!/ on\w+=/i.test(html), "в странице не должно быть встроенных обработчиков");
});

test("чужой заголовок Host отклоняется (DNS rebinding)", async () => {
  const code = await new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port, path: "/", headers: { Host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(code, 403);
});

test("защита от подделки запросов: нет заголовка, чужой Origin, cross-site", async () => {
  const noHeader = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: ADMIN_PW }) });
  assert.equal(noHeader.status, 403);
  assert.equal((await post(base, "/api/login", { password: ADMIN_PW }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await post(base, "/api/login", { password: ADMIN_PW }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
});

test("без входа API закрыт", async () => {
  assert.equal((await fetch(base + "/api/accounts")).status, 401);
  assert.equal((await fetch(base + "/api/me")).status, 401);
  assert.equal((await post(base, "/api/accounts", { name: "abc" })).status, 401);
  assert.equal((await post(base, "/api/accounts/c/delete", { confirmName: "hello" })).status, 401);
});

test("вход: неверный пароль 401 без cookie; верный даёт cookie HttpOnly SameSite=Strict", async () => {
  const bad = await post(base, "/api/login", { password: "неверный" });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get("set-cookie"), null);
  const good = await post(base, "/api/login", { password: ADMIN_PW });
  assert.equal(good.status, 200);
  const sc = good.headers.get("set-cookie");
  assert.match(sc, /^dvmail_admin_sid=[A-Za-z0-9_-]{43};/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  assert.equal((await get(base, "/api/me", cookieOf(good))).status, 200);
});

test("подделанный токен сессии не принимается", async () => {
  const c = await loggedIn(base);
  const bad = c.slice(0, -2) + (c.endsWith("AA") ? "BB" : "AA");
  assert.equal((await get(base, "/api/accounts", bad)).status, 401);
  assert.equal((await get(base, "/api/accounts", "dvmail_admin_sid=short")).status, 401);
});

test("выход закрывает сессию", async () => {
  const c = await loggedIn(base);
  const out = await post(base, "/api/logout", {}, { Cookie: c });
  assert.equal(out.status, 204);
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await get(base, "/api/accounts", c)).status, 401);
});

test("подбор пароля: после лимита 429, даже верный пароль не пускает", async () => {
  const s = await start({ maxFailPerIp: 3, maxFailTotal: 50 });
  for (let i = 0; i < 3; i++) assert.equal((await post(s.url, "/api/login", { password: "bad" + i })).status, 401);
  const blocked = await post(s.url, "/api/login", { password: ADMIN_PW });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
});

test("общий лимит неудач (смена адреса не помогает)", async () => {
  const s = await start({ maxFailPerIp: 50, maxFailTotal: 4 });
  for (let i = 0; i < 4; i++) assert.equal((await post(s.url, "/api/login", { password: "bad" })).status, 401);
  assert.equal((await post(s.url, "/api/login", { password: ADMIN_PW })).status, 429);
});

test("сессия умирает после простоя", async () => {
  const s = await start({ idleMs: 250 });
  const c = await loggedInAt(s);
  assert.equal((await get(s.url, "/api/me", c)).status, 200);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal((await get(s.url, "/api/me", c)).status, 401);
});

test("слишком большое тело запроса отклоняется", async () => {
  const r = await post(base, "/api/login", { password: "x".repeat(6000) });
  assert.equal(r.status, 413);
});

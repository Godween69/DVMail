// Тесты работы с ящиками: список, создание, удаление, ошибки Stalwart.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { TOKEN, DOMAIN, accounts, setRejectToken, start, stopAll, post, get, loggedIn } from "./helpers.mjs";

let base;
before(async () => { ({ url: base } = await start()); });
after(stopAll);

const loggedInAt = (s) => loggedIn(s.url);

test("список ящиков: поля, роли, защищённые; лишнего (паролей) нет", async () => {
  const c = await loggedIn(base);
  const r = await get(base, "/api/accounts", c);
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(!/password|secret|credentials|x-hello|x-admin/i.test(text), "в списке не должно быть секретов");
  const data = JSON.parse(text);
  assert.equal(data.domain, DOMAIN);
  const hello = data.accounts.find((a) => a.name === "hello");
  assert.deepEqual(hello, { id: "c", name: "hello", email: "hello@dvbstudio.ru", role: "User", description: "DVB Studio", protected: true });
  assert.equal(data.accounts.find((a) => a.name === "dvadmin").protected, true);
});

test("создание: проверки имени, дубликат, успех, пробный вход, пароль один раз", async () => {
  const c = await loggedIn(base);
  const mk = (b) => post(base, "/api/accounts", b, { Cookie: c });
  assert.equal((await mk({ name: "A" })).status, 400);
  assert.equal((await mk({ name: "bad name!" })).status, 400);
  assert.equal((await mk({ name: "../x" })).status, 400);
  assert.equal((await mk({ name: "postmaster" })).status, 400);
  assert.equal((await mk({ name: "DVADMIN" })).status, 400);
  assert.equal((await mk({ name: "hello" })).status, 409);
  const ok = await mk({ name: "Anna", description: "  Анна\u0000\u0007  " });
  assert.equal(ok.status, 201);
  const j = await ok.json();
  assert.equal(j.email, "anna@dvbstudio.ru");
  assert.equal(j.password.length, 32);
  assert.equal(j.loginOk, true);
  const stored = accounts.get(j.id);
  assert.equal(stored.name, "anna");
  assert.equal(stored.description, "Анна");
  assert.equal(stored.type, "User");
  assert.deepEqual(stored.roles, { "@type": "User" });
  assert.equal(stored.domainId, "b");
  const list = await (await get(base, "/api/accounts", c)).text();
  assert.ok(list.includes("anna@dvbstudio.ru"));
  assert.ok(!list.includes(j.password), "пароль не должен появляться в списке");
  assert.equal((await mk({ name: "anna" })).status, 409);
});

test("удаление: имя совпало, роль User; защищённые и админ не удаляются; чужие Id отклоняются", async () => {
  const c = await loggedIn(base);
  const mk = await (await post(base, "/api/accounts", { name: "temp1" }, { Cookie: c })).json();
  const del = (id, name) => post(base, `/api/accounts/${id}/delete`, { confirmName: name }, { Cookie: c });
  assert.equal((await del(mk.id, "другое")).status, 400);
  assert.ok(accounts.has(mk.id));
  assert.equal((await del("c", "hello")).status, 403);   // защищённый
  assert.equal((await del("e", "dvadmin")).status, 403); // администратор
  assert.ok(accounts.has("c") && accounts.has("e"));
  assert.equal((await del("zzz", "x")).status, 404);
  assert.equal((await del("bad id!", "x")).status, 400);
  assert.equal((await post(base, `/api/accounts/${mk.id}/delete`, {}, { Cookie: c })).status, 400);
  assert.equal((await del(mk.id, "temp1")).status, 200);
  assert.ok(!accounts.has(mk.id));
});

test("ошибки Stalwart: ключ отклонён и сервер недоступен дают 502 без утечки секретов", async () => {
  const c = await loggedIn(base);
  setRejectToken(true);
  const r1 = await get(base, "/api/accounts", c);
  setRejectToken(false);
  assert.equal(r1.status, 502);
  assert.ok(!(await r1.text()).includes(TOKEN));
  const s = await start({ stalwartUrl: "http://127.0.0.1:9" });
  const c2 = await loggedInAt(s);
  const r2 = await get(s.url, "/api/accounts", c2);
  assert.equal(r2.status, 502);
  assert.ok(!(await r2.text()).includes(TOKEN));
});

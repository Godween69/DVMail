// Тесты работы с ящиками: список, создание, удаление, ошибки Stalwart.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { TOKEN, DOMAIN, accounts, sets, setRejectToken, start, stopAll, post, get, loggedIn, mockLogin, H } from "./helpers.mjs";

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

test("сброс пароля: меняется только основной пароль, пароли приложений и двухфакторка целы", async () => {
  const c = await loggedIn(base);
  const made = await (await post(base, "/api/accounts", { name: "reset1" }, { Cookie: c })).json();
  // у ящика есть пароль приложения и двухфакторка (как у настоящего пользователя)
  const acc = accounts.get(made.id);
  acc.credentials[0].otpAuth = "otp-secret-keep";
  acc.credentials[1] = { "@type": "AppPassword", credentialId: "1", description: "Телефон", secret: "app-secret-keep", expiresAt: null, allowedIps: {} };
  const oldPw = made.password;
  const email = "reset1@dvbstudio.ru";
  assert.equal(await mockLogin(email, oldPw), true);

  const before = sets.length;
  const r = await post(base, `/api/accounts/${made.id}/reset-password`, { confirmName: "reset1" }, { Cookie: c });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(Object.keys(j).sort(), ["email", "id", "loginOk", "password"]);
  assert.equal(j.email, email);
  assert.equal(j.password.length, 32);
  assert.notEqual(j.password, oldPw);
  assert.equal(j.loginOk, true);
  // новый пароль работает, старый нет, пароль приложения работает по-прежнему
  assert.equal(await mockLogin(email, j.password), true);
  assert.equal(await mockLogin(email, oldPw), false);
  assert.equal(await mockLogin(email, "app-secret-keep"), true);
  assert.equal(acc.credentials[0].otpAuth, "otp-secret-keep");
  assert.equal(acc.credentials[1].description, "Телефон");
  // в Stalwart ушла ровно одна точечная правка поля secret, а не замена всего списка учётных данных
  const sent = sets.slice(before);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { update: { [made.id]: { "credentials/0/secret": j.password } } });
  // пароль нигде не появляется в списке
  assert.ok(!(await (await get(base, "/api/accounts", c)).text()).includes(j.password));
  // повторный сброс снова даёт новый пароль
  const j2 = await (await post(base, `/api/accounts/${made.id}/reset-password`, { confirmName: "reset1" }, { Cookie: c })).json();
  assert.notEqual(j2.password, j.password);
  assert.equal(await mockLogin(email, j.password), false);
  assert.equal(await mockLogin(email, j2.password), true);
});

test("сброс пароля: защита (защищённые, админ, неверное имя, чужие Id, без входа, без защиты от подделки)", async () => {
  const c = await loggedIn(base);
  const reset = (id, body) => post(base, `/api/accounts/${id}/reset-password`, body, { Cookie: c });
  const snap = JSON.stringify([accounts.get("c").credentials, accounts.get("e").credentials]);
  const before = sets.length;
  assert.equal((await reset("c", { confirmName: "hello" })).status, 403);   // защищённый ящик
  assert.equal((await reset("e", { confirmName: "dvadmin" })).status, 403); // администратор
  const made = await (await post(base, "/api/accounts", { name: "reset2" }, { Cookie: c })).json();
  const sets0 = sets.length;
  assert.equal((await reset(made.id, { confirmName: "другое" })).status, 400);
  assert.equal((await reset(made.id, {})).status, 400);
  assert.equal((await reset("zzz", { confirmName: "x" })).status, 404);
  assert.equal((await reset("bad id!", { confirmName: "x" })).status, 400);
  assert.equal(sets.length, sets0, "при отказах в Stalwart не должно уходить правок");
  assert.equal(await mockLogin("reset2@dvbstudio.ru", made.password), true);
  assert.equal(JSON.stringify([accounts.get("c").credentials, accounts.get("e").credentials]), snap, "защищённые не менялись");
  // без входа в админку
  const anon = await fetch(`${base}/api/accounts/${made.id}/reset-password`, { method: "POST", headers: H(base), body: JSON.stringify({ confirmName: "reset2" }) });
  assert.equal(anon.status, 401);
  // без заголовка защиты от подделки запросов
  const noCsrf = await fetch(`${base}/api/accounts/${made.id}/reset-password`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: c, Origin: base }, body: JSON.stringify({ confirmName: "reset2" }),
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(await mockLogin("reset2@dvbstudio.ru", made.password), true, "пароль не должен был измениться");
  void before;
});

test("сброс пароля: у ящика нет одного основного пароля, сброс отказывает без изменений", async () => {
  const c = await loggedIn(base);
  const made = await (await post(base, "/api/accounts", { name: "reset3" }, { Cookie: c })).json();
  accounts.get(made.id).credentials[5] = pw2();
  const n = sets.length;
  const r = await post(base, `/api/accounts/${made.id}/reset-password`, { confirmName: "reset3" }, { Cookie: c });
  assert.equal(r.status, 502);
  assert.equal(sets.length, n);
  assert.equal(await mockLogin("reset3@dvbstudio.ru", made.password), true);
  function pw2() { return { "@type": "Password", credentialId: "5", secret: "second", otpAuth: null, expiresAt: null, allowedIps: {} }; }
});

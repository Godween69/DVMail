"use strict";
// Страница админки. Весь текст из ответов сервера вставляется через textContent (не innerHTML),
// поэтому имя или описание ящика не могут внедрить чужой код на страницу.

const $ = (id) => document.getElementById(id);
let hideTimer = null;
let msgTimer = null;

// Уведомление внизу экрана; обычное исчезает само через 6 секунд
function say(text, ok) {
  const m = $("message");
  clearTimeout(msgTimer);
  m.textContent = text || "";
  m.className = ok ? "ok" : "";
  if (text) msgTimer = setTimeout(() => { m.textContent = ""; }, 6000);
}

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Requested-With": "dvmail-admin" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch { /* пустой ответ */ }
  if (r.status === 401 && path !== "/api/login") showLogin();
  return { ok: r.ok, status: r.status, data };
}

function showLogin() {
  clearResult();
  $("view-main").hidden = true;
  $("btn-logout").hidden = true;
  $("domain").textContent = "";
  $("view-login").hidden = false;
  $("login-password").focus();
}

function showMain() {
  $("view-login").hidden = true;
  $("view-main").hidden = false;
  $("btn-logout").hidden = false;
  loadList();
}

function clearResult() {
  clearTimeout(hideTimer);
  $("result").hidden = true;
  $("result-password").textContent = "";
  $("result-email").textContent = "";
  $("result-title").textContent = "";
}

// Показ пароля (нового ящика или после сброса): один раз, сам исчезает через 2 минуты
function showResult(title, email, password, loginOk) {
  clearResult();
  $("result-title").textContent = title;
  $("result-email").textContent = email;
  $("result-password").textContent = password;
  $("result-note").textContent = loginOk
    ? "Пробный вход по этому паролю прошёл успешно."
    : "Внимание: пробный вход не удался. Проверьте ящик в админке Stalwart.";
  $("result").hidden = false;
  $("result").scrollIntoView({ behavior: "smooth", block: "start" });
  hideTimer = setTimeout(clearResult, 120000);
}

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function button(text, cls, onClick) {
  const b = el("button", text, "btn " + cls);
  b.type = "button";
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

// Цвет аватарки зависит от имени (шесть оттенков), чтобы ящики отличались с первого взгляда
function avatarClass(name) {
  let n = 0;
  for (const ch of name) n = (n + ch.charCodeAt(0)) % 6;
  return "avatar av" + n;
}

// Строка списка: аватарка, адрес, описание, метка роли, кнопки (у защищённых кнопок нет)
function renderItem(a) {
  const li = el("li");
  const row = el("div", undefined, "row");
  const who = el("div", undefined, "who");
  who.appendChild(el("span", a.name.charAt(0), avatarClass(a.name)));
  const mail = el("div", undefined, "mail");
  const addr = el("div", undefined, "addr");
  addr.appendChild(el("span", a.email));
  if (a.role !== "User") addr.appendChild(el("span", a.role, "tag"));
  else if (a.protected) addr.appendChild(el("span", "защищён", "tag"));
  mail.appendChild(addr);
  if (a.description) mail.appendChild(el("div", a.description, "sub"));
  who.appendChild(mail);
  row.appendChild(who);
  if (!a.protected) {
    const acts = el("div", undefined, "acts");
    acts.appendChild(button("Сбросить пароль", "ghost small", () => openReset(li, a)));
    acts.appendChild(button("Удалить", "ghost small warn", () => openConfirm(li, a)));
    row.appendChild(acts);
  }
  li.appendChild(row);
  return li;
}

// Одновременно открыта только одна панель подтверждения
function closePanels() {
  document.querySelectorAll("#list .confirm").forEach((p) => p.remove());
}

// Сброс пароля: достаточно нажать «Да, сбросить пароль»
function openReset(li, a) {
  closePanels();
  const box = el("div", undefined, "confirm calm");
  box.appendChild(el("div", "Задать новый пароль для " + a.email + "? Старый пароль перестанет работать. Новый будет показан один раз.", "sub"));
  const go = button("Да, сбросить пароль", "primary small");
  const acts = el("div", undefined, "acts");
  go.addEventListener("click", async () => {
    go.disabled = true;
    const r = await api("POST", "/api/accounts/" + encodeURIComponent(a.id) + "/reset-password", { confirmName: a.name });
    box.remove();
    if (r.ok) { say(""); showResult("Пароль сброшен", r.data.email, r.data.password, r.data.loginOk); }
    else say((r.data && r.data.message) || "Не удалось сбросить пароль");
  });
  acts.append(go, button("Отмена", "ghost small", () => box.remove()));
  box.appendChild(acts);
  li.appendChild(box);
  go.focus();
}

// Подтверждение удаления: нужно набрать имя ящика, пока оно не совпадёт, кнопка выключена
function openConfirm(li, a) {
  closePanels();
  const box = el("div", undefined, "confirm");
  box.appendChild(el("div", "Удалить ящик вместе со всеми письмами? Наберите имя: " + a.name, "sub"));
  const input = el("input");
  input.autocomplete = "off";
  const go = button("Удалить навсегда", "danger small");
  go.disabled = true;
  input.addEventListener("input", () => { go.disabled = input.value.trim() !== a.name; });
  go.addEventListener("click", async () => {
    go.disabled = true;
    const r = await api("POST", "/api/accounts/" + encodeURIComponent(a.id) + "/delete", { confirmName: input.value.trim() });
    if (r.ok) { say("Ящик " + a.email + " удалён", true); loadList(); }
    else { say((r.data && r.data.message) || "Не удалось удалить"); box.remove(); }
  });
  const acts = el("div", undefined, "acts");
  acts.append(go, button("Отмена", "ghost small", () => box.remove()));
  box.append(input, acts);
  li.appendChild(box);
  input.focus();
}

async function loadList() {
  const r = await api("GET", "/api/accounts");
  if (!r.ok) { if (r.status !== 401) say((r.data && r.data.message) || "Не удалось получить список"); return; }
  $("domain").textContent = "@" + r.data.domain;
  $("count").textContent = String(r.data.accounts.length);
  $("list").replaceChildren(...r.data.accounts.map(renderItem));
}

$("form-login").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const r = await api("POST", "/api/login", { password: $("login-password").value });
  $("login-password").value = "";
  if (r.ok) { say(""); showMain(); }
  else say((r.data && r.data.message) || "Не удалось войти");
});

$("btn-logout").addEventListener("click", async () => {
  await api("POST", "/api/logout");
  say("");
  showLogin();
});

$("form-create").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  clearResult();
  const r = await api("POST", "/api/accounts", { name: $("new-name").value, description: $("new-desc").value });
  if (!r.ok) { say((r.data && r.data.message) || "Не удалось создать"); return; }
  say("");
  $("new-name").value = "";
  $("new-desc").value = "";
  showResult("Ящик создан", r.data.email, r.data.password, r.data.loginOk);
  loadList();
});

$("btn-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("result-password").textContent);
    say("Пароль скопирован", true);
  } catch {
    say("Не удалось скопировать: выделите пароль и скопируйте вручную");
  }
});
$("btn-hide").addEventListener("click", clearResult);

// Старт: если сессия есть, сразу основной экран
(async () => {
  const r = await api("GET", "/api/me");
  if (r.ok) showMain(); else showLogin();
})();

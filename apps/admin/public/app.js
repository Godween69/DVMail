"use strict";
// Страница админки. Весь текст из ответов сервера вставляется через textContent (не innerHTML),
// поэтому имя или описание ящика не могут внедрить чужой код на страницу.

const $ = (id) => document.getElementById(id);
let hideTimer = null;

function say(text, ok) {
  const m = $("message");
  m.textContent = text || "";
  m.className = ok ? "ok" : "";
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
  $("view-login").hidden = false;
  $("login-password").focus();
}

function showMain() {
  $("view-login").hidden = true;
  $("view-main").hidden = false;
  loadList();
}

function clearResult() {
  clearTimeout(hideTimer);
  $("result").hidden = true;
  $("result-password").textContent = "";
  $("result-email").textContent = "";
}

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

// Строка списка: адрес, описание, метка роли, кнопка удаления (для защищённых её нет)
function renderItem(a) {
  const li = el("li");
  const row = el("div", undefined, "row");
  const left = el("div");
  const title = el("span", a.email);
  left.appendChild(title);
  if (a.role !== "User") left.appendChild(el("span", a.role, "tag"));
  else if (a.protected) left.appendChild(el("span", "защищён", "tag"));
  if (a.description) left.appendChild(el("div", a.description, "sub"));
  row.appendChild(left);
  if (!a.protected) {
    const del = el("button", "Удалить", "link");
    del.type = "button";
    del.addEventListener("click", () => openConfirm(li, a));
    row.appendChild(del);
  }
  li.appendChild(row);
  return li;
}

// Подтверждение удаления: нужно набрать имя ящика, пока оно не совпадёт, кнопка выключена
function openConfirm(li, a) {
  if (li.querySelector(".confirm")) return;
  const box = el("div", undefined, "confirm");
  box.appendChild(el("div", "Удалить ящик вместе со всеми письмами? Наберите имя: " + a.name, "sub"));
  const input = el("input");
  input.autocomplete = "off";
  const go = el("button", "Удалить навсегда", "danger");
  go.type = "button";
  go.disabled = true;
  const cancel = el("button", "Отмена", "link");
  cancel.type = "button";
  input.addEventListener("input", () => { go.disabled = input.value.trim() !== a.name; });
  cancel.addEventListener("click", () => box.remove());
  go.addEventListener("click", async () => {
    go.disabled = true;
    const r = await api("POST", "/api/accounts/" + encodeURIComponent(a.id) + "/delete", { confirmName: input.value.trim() });
    if (r.ok) { say("Ящик " + a.email + " удалён", true); loadList(); }
    else { say((r.data && r.data.message) || "Не удалось удалить"); box.remove(); }
  });
  box.append(input, go, cancel);
  li.appendChild(box);
  input.focus();
}

async function loadList() {
  const r = await api("GET", "/api/accounts");
  if (!r.ok) { if (r.status !== 401) say((r.data && r.data.message) || "Не удалось получить список"); return; }
  $("domain").textContent = "@" + r.data.domain;
  const ul = $("list");
  ul.replaceChildren(...r.data.accounts.map(renderItem));
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
  $("result-email").textContent = r.data.email;
  $("result-password").textContent = r.data.password;
  $("result-note").textContent = r.data.loginOk
    ? "Пробный вход по этому паролю прошёл успешно."
    : "Внимание: пробный вход не удался. Проверьте ящик в админке Stalwart.";
  $("result").hidden = false;
  hideTimer = setTimeout(clearResult, 120000); // пароль сам исчезнет через 2 минуты
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

// Общее для тестов админки: заглушка Stalwart и помощники запуска.
// Заглушка повторяет формат ответов, проверенный на настоящем Stalwart 0.16 (POST /jmap, x:Account/query, get, set).
import http from "node:http";
import net from "node:net";

process.env.DVMAIL_LOG = "quiet";
const { createApp } = await import("../dist/bootstrap.js");
const { hashPassword } = await import("../dist/password.js");

export const TOKEN = "stalwart-test-token-0123456789abcdef";
export const ADMIN_PW = "correct horse battery staple";
export const DOMAIN = "dvbstudio.ru";

// ---- Заглушка Stalwart ----
// Учётные данные хранятся как у настоящего Stalwart 0.16: словарь записей с типами Password и AppPassword
const pw = (secret, extra = {}) => ({ "@type": "Password", credentialId: "0", secret, otpAuth: null, expiresAt: null, allowedIps: {}, ...extra });
export const accounts = new Map([
  ["e", { id: "e", name: "dvadmin", roles: { "@type": "Admin" }, description: null, credentials: { 0: pw("x-admin") } }],
  ["c", { id: "c", name: "hello", roles: { "@type": "User" }, description: "DVB Studio", credentials: {
    0: pw("x-hello", { otpAuth: "otp-hello" }),
    1: { "@type": "AppPassword", credentialId: "1", description: "DVMail webmail", secret: "app-hello", expiresAt: null, allowedIps: {} },
  } }],
]);
// Журнал всех x:Account/set, пришедших в заглушку (тесты проверяют, что уходит только точечная правка)
export const sets = [];
const secrets = (a) => Object.values(a.credentials ?? {}).map((c) => c.secret);
let nextId = 100;
let rejectToken = false;
export const setRejectToken = (v) => { rejectToken = v; };
export const mock = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.method === "GET" && req.url === "/jmap/session") { // проверка входа по паролю (Basic)
    const m = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
    const [u, p] = m ? Buffer.from(m[1], "base64").toString().split(/:(.*)/s) : [];
    const ok = [...accounts.values()].some((a) => `${a.name}@${DOMAIN}` === u && secrets(a).includes(p));
    return send(ok ? 200 : 401, {});
  }
  if (req.method !== "POST" || req.url !== "/jmap") return send(404, {});
  if (rejectToken || req.headers.authorization !== "Bearer " + TOKEN) return send(401, {});
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { methodCalls } = JSON.parse(body);
    const out = [];
    let lastIds = [];
    for (const [name, args, id] of methodCalls) {
      if (name === "x:Domain/query") { lastIds = ["b"]; out.push([name, { accountId: "e", ids: ["b"] }, id]); }
      else if (name === "x:Domain/get") out.push([name, { accountId: "e", list: [{ id: "b", name: DOMAIN }], notFound: [] }, id]);
      else if (name === "x:Account/query") { lastIds = [...accounts.keys()]; out.push([name, { accountId: "e", ids: lastIds }, id]); }
      else if (name === "x:Account/get") {
        const ids = args.ids ?? lastIds;
        const list = ids.filter((i) => accounts.has(i)).map((i) => {
          const a = accounts.get(i);
          const o = { id: a.id, name: a.name, roles: a.roles, description: a.description };
          // секреты Stalwart отдаёт скрытыми: прочитать пароль и записать его обратно нельзя
          if (!args.properties || args.properties.includes("credentials")) {
            o.credentials = Object.fromEntries(Object.entries(a.credentials).map(([k, c]) => [k, { ...c, secret: "****", ...(c.otpAuth ? { otpAuth: "****" } : {}) }]));
          }
          return o;
        });
        out.push([name, { accountId: "e", list, notFound: ids.filter((i) => !accounts.has(i)) }, id]);
      } else if (name === "x:Account/set") {
        const r = { accountId: "e" };
        if (args.create) {
          r.created = {};
          for (const [k, v] of Object.entries(args.create)) {
            const nid = "n" + nextId++;
            accounts.set(nid, { id: nid, name: v.name, roles: v.roles, description: v.description ?? null, credentials: Object.fromEntries(Object.entries(v.credentials).map(([k, c]) => [k, { credentialId: k, expiresAt: null, allowedIps: {}, ...c }])), type: v["@type"], domainId: v.domainId });
            r.created[k] = { id: nid };
          }
        }
        if (args.destroy) { r.destroyed = args.destroy.filter((i) => accounts.delete(i)); }
        if (args.update) {
          // поддерживается только точечная правка credentials/<ключ>/secret (как JMAP-патч); остальное отклоняется
          r.updated = {}; r.notUpdated = {};
          for (const [id, patch] of Object.entries(args.update)) {
            const a = accounts.get(id);
            const keys = Object.keys(patch);
            const m = keys.length === 1 && /^credentials\/([^/]+)\/secret$/.exec(keys[0]);
            if (!a) r.notUpdated[id] = { type: "notFound" };
            else if (!m || !a.credentials[m[1]]) r.notUpdated[id] = { type: "invalidPatch" };
            else { a.credentials[m[1]].secret = patch[keys[0]]; r.updated[id] = null; }
          }
        }
        sets.push(JSON.parse(JSON.stringify(args)));
        out.push([name, r, id]);
      } else out.push(["error", { type: "unknownMethod" }, id]);
    }
    send(200, { methodResponses: out, sessionState: "s1" });
  });
});


const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const apps = [];
let hash;

/** Поднимает заглушку (один раз) и админку; возвращает адрес и порт */
export async function start(over = {}) {
  hash ??= await hashPassword(ADMIN_PW);
  if (!mock.listening) await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const p = await freePort();
  const { app } = await createApp({
    stalwartUrl: `http://127.0.0.1:${mock.address().port}`, stalwartToken: TOKEN, passwordHash: hash,
    host: "127.0.0.1", port: p, allowedHosts: [`127.0.0.1:${p}`], allowedOrigins: [`http://127.0.0.1:${p}`], domain: DOMAIN, ...over,
  });
  await app.listen(p, "127.0.0.1");
  apps.push(app);
  return { url: `http://127.0.0.1:${p}`, port: p, hash };
}
export async function stopAll() { for (const a of apps) await a.close(); mock.close(); }

export const H = (url, extra = {}) => ({ "Content-Type": "application/json", "X-Requested-With": "dvmail-admin", Origin: url, ...extra });
export const post = (url, path, body, extra) => fetch(url + path, { method: "POST", headers: H(url, extra), body: JSON.stringify(body) });
export const get = (url, path, cookie) => fetch(url + path, { headers: { Cookie: cookie } });
export const cookieOf = (r) => (r.headers.get("set-cookie") ?? "").split(";")[0];
export async function loggedIn(url) {
  const r = await post(url, "/api/login", { password: ADMIN_PW });
  if (r.status !== 200) throw new Error("вход не удался: " + r.status);
  return cookieOf(r);
}

/** Вход в заглушку по паролю, как почтовый клиент: true, если Stalwart принял бы эту пару */
export const mockLogin = async (email, password) =>
  (await fetch(`http://127.0.0.1:${mock.address().port}/jmap/session`, {
    headers: { Authorization: "Basic " + Buffer.from(`${email}:${password}`).toString("base64") },
  })).status === 200;

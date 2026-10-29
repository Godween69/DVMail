// Связь с сервером. Все запросы своего сайта; своё имя в заголовке нужно для защиты от подделки запросов.
export interface Mailbox { id: string; name: string; role: string | null; parentId: string | null; total: number; unread: number }
export interface Addr { name: string | null; email: string }
export interface EmailItem {
  id: string; from: Addr | null; to: Addr | null; subject: string; receivedAt: string;
  preview: string; hasAttachment: boolean; unread: boolean; draft: boolean;
}
export interface Attachment { blobId: string; name: string; type: string; size: number }
export interface EmailFull {
  id: string; unread: boolean; mailboxIds: string[]; from: Addr | null; to: Addr[]; cc: Addr[]; replyTo: Addr[];
  subject: string; receivedAt: string; sentAt: string; size: number; text: string; html: string;
  truncated: boolean; encrypted: boolean; attachments: Attachment[];
}
export interface Identity { id: string; name: string; email: string }
export interface SendRequest {
  identityId: string; to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; replyTo: string | null;
  attachments: string[]; // файлы, загруженные в этом окне письма (идентификаторы)
  forwardOf: string | null; keep: string[]; // пересылка: письмо-источник и какие его вложения оставить
}
export interface Contact { name: string; email: string }
export interface Limits { file: number; total: number; count: number }
export interface Uploaded { blobId: string; name: string; type: string; size: number }
export interface EmailPage { total: number; position: number; emails: EmailItem[] }

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

let onUnauthorized: (() => void) | null = null;
/** Что делать, когда сервер сообщил, что сессия закончилась */
export const setUnauthorizedHandler = (f: (() => void) | null) => { onUnauthorized = f; };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, {
      method, credentials: "same-origin",
      headers: { "X-Requested-With": "dvmail", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Нет связи с сервером. Проверьте интернет.");
  }
  let data: unknown = null;
  if (r.status !== 204) { try { data = await r.json(); } catch { /* пустой ответ */ } }
  if (!r.ok) {
    if (r.status === 401 && !path.startsWith("/api/auth/login")) onUnauthorized?.();
    const m = (data as { message?: unknown } | null)?.message;
    throw new ApiError(r.status, typeof m === "string" ? m : "Не удалось выполнить запрос");
  }
  return data as T;
}

/** Загрузка файла для вложения. Отдельно от request: нужны полоска прогресса и отмена (fetch не показывает ход отправки). */
function upload(file: File, onProgress: (fraction: number) => void): { promise: Promise<Uploaded>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<Uploaded>((resolve, reject) => {
    xhr.open("POST", `/api/attachments?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("X-Requested-With", "dvmail");
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total); };
    xhr.onerror = () => reject(new ApiError(0, "Нет связи с сервером. Проверьте интернет."));
    xhr.ontimeout = () => reject(new ApiError(0, "Загрузка слишком долгая, попробуйте ещё раз."));
    xhr.onabort = () => reject(new ApiError(-1, "Отменено"));
    xhr.timeout = 10 * 60_000;
    xhr.onload = () => {
      let data: unknown = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* пустой ответ */ }
      if (xhr.status >= 200 && xhr.status < 300 && data && typeof (data as Uploaded).blobId === "string") return resolve(data as Uploaded);
      if (xhr.status === 401) onUnauthorized?.();
      const m = (data as { message?: unknown } | null)?.message;
      reject(new ApiError(xhr.status, typeof m === "string" ? m : "Не удалось загрузить файл"));
    };
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

const enc = encodeURIComponent;
export const api = {
  me: () => request<{ email: string }>("GET", "/api/auth/me"),
  login: (email: string, password: string) => request<{ email: string }>("POST", "/api/auth/login", { email, password }),
  logout: () => request<void>("POST", "/api/auth/logout"),
  mailboxes: () => request<{ mailboxes: Mailbox[] }>("GET", "/api/mailboxes").then((r) => r.mailboxes),
  emails: (mailbox: string, position: number, limit: number, q: string) =>
    request<EmailPage>("GET", `/api/emails?mailbox=${enc(mailbox)}&position=${position}&limit=${limit}${q ? "&q=" + enc(q) : ""}`),
  email: (id: string) => request<EmailFull>("GET", `/api/emails/${enc(id)}`),
  setSeen: (id: string, seen: boolean) => request<{ ok: true }>("POST", `/api/emails/${enc(id)}/seen`, { seen }),
  trash: (id: string) => request<{ ok: true; permanent: boolean }>("POST", `/api/emails/${enc(id)}/trash`, {}),
  identities: () => request<{ identities: Identity[] }>("GET", "/api/identities").then((r) => r.identities),
  send: (b: SendRequest) => request<{ ok: true; filed: boolean }>("POST", "/api/send", b),
  limits: () => request<Limits>("GET", "/api/limits"),
  contacts: () => request<{ contacts: Contact[] }>("GET", "/api/contacts").then((r) => r.contacts),
  upload,
  removeFile: (blobId: string) => request<{ ok: true }>("DELETE", `/api/attachments/${enc(blobId)}`),
  rawUrl: (id: string) => `/api/emails/${enc(id)}/raw`,
  attachmentUrl: (id: string, blobId: string) => `/api/emails/${enc(id)}/attachments/${enc(blobId)}`,
};

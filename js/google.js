// 和 Google 連線的部分：登入、聯絡人（People API）、雲端硬碟（Drive API）、後台。
//
// 登入的通行證（使用者 2026-11-19 選的做法）：
// - Google 給的通行證最長一小時。它會暫存在這支手機的瀏覽器儲存空間裡，所以一小時內關掉 App 再開不用重新登入。
//   過期、登出、或 Google 說它失效時就清掉。通行證不會寫進任何紀錄，也不會傳到 Google 以外的地方（後台驗證身分時除外）。
// - 另外記住上次登入的 Email（只有 Email，不是密碼），下次按登入就不用再選帳號。
// 已告知使用者的風險：同一個網址（github.io）底下他其他專案的網頁，理論上也讀得到暫存的通行證。
import { CONFIG } from "../config.js";

const PEOPLE = "https://people.googleapis.com/v1/";
const DRIVE = "https://www.googleapis.com/drive/v3/";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const SCOPE_CONTACTS = "https://www.googleapis.com/auth/contacts";
const SCOPE_DRIVE = "https://www.googleapis.com/auth/drive.file";
const SCOPE_EMAIL = "https://www.googleapis.com/auth/userinfo.email";
export const PERSON_FIELDS = "names,phoneNumbers,emailAddresses,addresses,organizations,memberships,nicknames,urls,userDefined,biographies,metadata";
const SEARCH_FIELDS = "names,phoneNumbers,emailAddresses,organizations,memberships,metadata";

/** 給使用者看的錯誤（訊息本身就是白話）。 */
export class UserError extends Error {}

const AUTH_KEY = "junpin-card-auth"; // { token, exp, email, client }
const HINT_KEY = "junpin-card-hint"; // 上次登入的 Email

function lsGet(k) {
  try {
    return JSON.parse(localStorage.getItem(k) || "null");
  } catch {
    return null;
  }
}
function lsSet(k, v) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* 存不了（例如無痕模式）就當成沒有暫存，只是每次都要登入 */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = { token: "", tokenExp: 0, email: "", tokenClient: null, pending: null, folderId: "", warmed: false };

/** 把錯誤翻成看得懂的話。 */
export function explain(e) {
  if (e instanceof UserError) return e.message;
  if (e instanceof TypeError) return "連不上網路（或連線中斷）。請確認網路後再試一次，已填的內容都還在。";
  const m = e?.message || String(e);
  if (e?.status === 401) return "登入已失效，請重新登入後再試一次，已填的內容都還在。";
  if (e?.status === 403 && /insufficient|scope/i.test(m)) return "登入時沒有同意全部項目。請重新登入，「聯絡人」和「雲端硬碟」兩項都要勾選。";
  if (e?.status === 429) return "Google 說操作太頻繁，請等一分鐘再試。";
  if (e?.status === 400 && /etag|precondition/i.test(m)) return "這一筆剛剛在別的地方被改過，所以這次沒有寫入。請回上一步重新比對。";
  return `發生錯誤（${e?.status || "?"}）：${m}`;
}

export function account() {
  return state.email;
}

export function loggedIn() {
  return Boolean(state.token) && Date.now() < state.tokenExp;
}

/** 上次登入的 Email（沒有就是空字串）。 */
export function lastAccount() {
  return lsGet(HINT_KEY) || "";
}

/**
 * 開啟 App 時呼叫：手機裡暫存的通行證還沒過期就拿來用，回傳 Email；沒有或過期了回傳空字串。
 * 這裡不連網路；通行證是不是真的還有效，等第一次向 Google 要資料時就知道（失效會被清掉、回到登入頁）。
 */
export function restore() {
  const a = lsGet(AUTH_KEY);
  if (a?.token && a.client === CONFIG.GOOGLE_CLIENT_ID && Number(a.exp) > Date.now() + 30000) {
    state.token = a.token;
    state.tokenExp = Number(a.exp);
    state.email = a.email || "";
    state.warmed = false;
    return state.email || "（已登入）";
  }
  lsSet(AUTH_KEY, null);
  return "";
}

function forgetToken() {
  state.token = "";
  state.tokenExp = 0;
  lsSet(AUTH_KEY, null);
}

/** 登出：請 Google 作廢這個 App 的授權，並清掉手機裡暫存的通行證和記住的帳號。 */
export function logout() {
  if (state.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(state.token, () => {});
  forgetToken();
  state.email = "";
  lsSet(HINT_KEY, null);
}

/**
 * 登入。一定要在按鈕的點擊動作裡直接呼叫（中間不可以先等別的事），登入視窗才不會被瀏覽器擋掉。
 * 成功回傳 Email；失敗丟出 UserError。
 * 記得上次的帳號時，直接用那個帳號登入，不再跳出選帳號的畫面（官方文件：prompt 給空字串＋login_hint）。
 * other=true：改用別的帳號登入，會跳出選帳號的畫面。
 */
export function login({ other = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) {
      reject(new UserError("Google 登入元件還沒載入好，請等幾秒再按一次（或確認網路）。"));
      return;
    }
    if (!state.tokenClient) {
      state.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.GOOGLE_CLIENT_ID,
        scope: [SCOPE_CONTACTS, SCOPE_DRIVE, SCOPE_EMAIL].join(" "),
        hd: CONFIG.WORKSPACE_DOMAIN,
        callback: (resp) => onToken(resp),
        error_callback: (e) => {
          const why = e?.type === "popup_failed_to_open" ? "登入視窗被擋住了。請允許這個網站開啟彈出式視窗；iPhone 請改用 Safari 直接開這個網址。"
            : e?.type === "popup_closed" ? "登入視窗被關掉了，沒有完成登入。" : "登入沒有完成，請再試一次。";
          state.pending?.reject(new UserError(why));
          state.pending = null;
        },
      });
    }
    state.pending = { resolve, reject };
    const hint = other ? "" : lastAccount();
    state.tokenClient.requestAccessToken(hint ? { prompt: "", login_hint: hint } : { prompt: "select_account" });
  });
}

async function onToken(resp) {
  const pending = state.pending;
  state.pending = null;
  try {
    if (resp.error) {
      throw new UserError(resp.error === "access_denied" ? "您沒有同意授權，或這個帳號不能用這個 App（只限公司帳號）。" : `登入失敗：${resp.error}`);
    }
    if (!google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE_CONTACTS, SCOPE_DRIVE)) {
      throw new UserError("登入時沒有同意全部項目。請再登入一次，「聯絡人」和「雲端硬碟」兩項都要勾選。");
    }
    state.token = resp.access_token;
    state.tokenExp = Date.now() + (Number(resp.expires_in) - 60) * 1000;
    const me = await api("GET", "https://www.googleapis.com/oauth2/v3/userinfo");
    if (me.hd !== CONFIG.WORKSPACE_DOMAIN) {
      const email = me.email;
      logout();
      throw new UserError(`這不是公司帳號（${email}）。請改用 ${CONFIG.WORKSPACE_DOMAIN} 的帳號登入。`);
    }
    state.email = me.email;
    lsSet(AUTH_KEY, { token: state.token, exp: state.tokenExp, email: me.email, client: CONFIG.GOOGLE_CLIENT_ID });
    lsSet(HINT_KEY, me.email);
    state.warmed = false;
    warmup().catch(() => {});
    pending?.resolve(me.email);
  } catch (e) {
    forgetToken();
    pending?.reject(e);
  }
}

/** 呼叫 Google 的服務。讀取遇到暫時性錯誤會自動重試；新增只在「太頻繁」（確定沒寫進去）時重試，避免寫兩次。 */
async function api(method, url, { params = {}, body, rawBody, headers = {} } = {}) {
  if (!state.token) throw new UserError("還沒登入，請先登入。");
  if (Date.now() > state.tokenExp) throw new UserError("登入已過期（一小時內有效）。請重新登入後再按一次，已填的內容都還在。");
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(u, {
      method,
      headers: { Authorization: "Bearer " + state.token, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: rawBody ?? (body ? JSON.stringify(body) : undefined),
    });
    const retryable = res.status === 429 || (method === "GET" && res.status >= 500);
    if (retryable && attempt < 2) {
      await sleep(attempt === 0 ? 2000 : 6000);
      continue;
    }
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* 不是 JSON 就當成沒有內容 */
    }
    if (!res.ok) {
      const err = new Error(json?.error?.message || text.slice(0, 200) || res.statusText);
      err.status = res.status;
      if (res.status === 401) forgetToken();
      throw err;
    }
    return json;
  }
}

// ---------- 聯絡人 ----------

/** 使用者自己建的標籤：[{ resourceName, name }] */
export async function listLabels() {
  const r = await api("GET", PEOPLE + "contactGroups", { params: { pageSize: 1000, groupFields: "name,groupType" } });
  return (r.contactGroups || []).filter((g) => g.groupType === "USER_CONTACT_GROUP").map((g) => ({ resourceName: g.resourceName, name: g.name }));
}

export async function createLabel(name) {
  const made = await api("POST", PEOPLE + "contactGroups", { body: { contactGroup: { name } } });
  return { resourceName: made.resourceName, name };
}

export function createContact(body) {
  return api("POST", PEOPLE + "people:createContact", { params: { personFields: PERSON_FIELDS }, body });
}

/**
 * 修改現有聯絡人。mask 裡的欄位是「整欄替換」；body 要帶 etag 和聯絡人來源（由 merge.apply_plan 或 writer.build_restore 組好）。
 * 這一筆如果在這之間被改過，Google 會拒絕（不會寫進去）。
 */
export function updateContact(resourceName, mask, body) {
  return api("PATCH", PEOPLE + resourceName + ":updateContact", { params: { updatePersonFields: mask.join(","), personFields: PERSON_FIELDS }, body });
}

export function getPerson(resourceName) {
  return api("GET", PEOPLE + resourceName, { params: { personFields: PERSON_FIELDS } });
}

/** 官方文件：搜尋前要先送一次空白查詢，讓 Google 更新搜尋用的資料。登入後自動做一次。 */
export async function warmup() {
  if (state.warmed) return;
  await api("GET", PEOPLE + "people:searchContacts", { params: { query: "", readMask: "names" } });
  state.warmed = true;
}

/** 用好幾個字串各搜尋一次（同時最多 4 個），回傳找到的聯絡人（可能重複，由呼叫的人整理）。 */
export async function searchAll(queries) {
  await warmup();
  const out = [];
  let next = 0;
  const worker = async () => {
    while (next < queries.length) {
      const q = queries[next++];
      const r = await api("GET", PEOPLE + "people:searchContacts", { params: { query: q, readMask: SEARCH_FIELDS, pageSize: 30 } });
      for (const x of r.results || []) if (x.person) out.push(x.person);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queries.length) }, worker));
  return out;
}

// ---------- 雲端硬碟（只碰得到本 App 自己建立的檔案） ----------

async function photoFolder() {
  if (state.folderId) return state.folderId;
  const q = `name = '${CONFIG.PHOTO_FOLDER}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const found = await api("GET", DRIVE + "files", { params: { q, fields: "files(id,name)", spaces: "drive" } });
  let folder = (found.files || [])[0];
  if (!folder) {
    folder = await api("POST", DRIVE + "files", { params: { fields: "id,name" }, body: { name: CONFIG.PHOTO_FOLDER, mimeType: "application/vnd.google-apps.folder" } });
  }
  state.folderId = folder.id;
  return folder.id;
}

/** 把一張照片存到使用者自己雲端硬碟的固定資料夾。回傳 { name, shared, link }（link 只有他自己打得開）。 */
export async function uploadPhoto(blob, name) {
  const folderId = await photoFolder();
  const boundary = "junpin" + Math.random().toString(36).slice(2);
  const rawBody = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId] })}\r\n`,
    `--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`, blob, `\r\n--${boundary}--`,
  ]);
  const up = await api("POST", DRIVE_UPLOAD, {
    params: { uploadType: "multipart", fields: "id,name,shared,webViewLink" },
    rawBody, headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
  });
  return { name: up.name, shared: Boolean(up.shared), link: up.webViewLink || (up.id ? `https://drive.google.com/file/d/${up.id}/view` : "") };
}

export const DEMO = false;

// 階段 0 測試頁：確認「手機打開網址就能用」這條路走得通。
// 驗證：能裝到主畫面、能登入公司帳號、能寫入一筆測試聯絡人、能存照片到雲端硬碟、能用手機號碼查到現有聯絡人。
// 只新增測試資料（姓名含「測試」），不修改、不刪除任何現有聯絡人。登入的通行證只放在記憶體，關掉網頁就沒了。
import { CONFIG } from "../config.js";
import * as G from "./gcontact.js";

const PEOPLE = "https://people.googleapis.com/v1/";
const DRIVE = "https://www.googleapis.com/drive/v3/";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const SCOPE_CONTACTS = "https://www.googleapis.com/auth/contacts";
const SCOPE_DRIVE = "https://www.googleapis.com/auth/drive.file";
const SCOPE_EMAIL = "https://www.googleapis.com/auth/userinfo.email";
const PERSON_FIELDS = "names,phoneNumbers,emailAddresses,addresses,organizations,memberships,metadata";
const TEST_CATEGORY = "廠商";
const TRASH_LABEL = "_待刪除";
const LS_KEY = "junpin-card-stage0";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const state = { token: "", tokenExp: 0, tokenClient: null, installEvent: null };
const summary = {}; // 每一步的文字結果，給「複製測試結果」用

function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  $("log").textContent += `${t} ${msg}\n`;
}

/** 在某一步底下顯示結果。lines：[["ok"|"bad"|"warn"|"", 文字], …] */
function show(step, lines) {
  const mark = { ok: "✓ ", bad: "✗ ", warn: "△ ", "": "" };
  $("r-" + step).innerHTML = lines.map(([k, t]) => `<div class="${k}">${mark[k] ?? ""}${esc(t)}</div>`).join("");
  summary[step] = lines.map(([k, t]) => (mark[k] ?? "") + t).join("\n");
}

function saved() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    return {};
  }
}
function save(patch) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...saved(), ...patch }));
  } catch {
    /* 無痕模式等情況存不了，不影響測試 */
  }
}

class UserError extends Error {}

/** 技術紀錄裡的查詢字串：有數字的只留前 4 個字，其餘用「•」蓋掉，避免電話號碼跟著紀錄被複製出去。 */
function maskQuery(q) {
  return /\d{3}/.test(q) ? [...q].map((c, i) => (i >= 4 && /\d/.test(c) ? "•" : c)).join("") : q;
}

/** 把錯誤翻成看得懂的話。 */
function explain(e) {
  if (e instanceof UserError) return e.message;
  if (e instanceof TypeError) return "連不上 Google（可能沒有網路，或連線中斷）。請確認網路後再試一次。";
  const m = e.message || String(e);
  if (e.status === 401) return "登入已失效，請回到第 1 步重新登入。";
  if (e.status === 403 && /has not been used|is disabled|not enabled/i.test(m)) return "Google 後台還沒啟用這項服務（People API 或 Drive API）。請把這段訊息傳給 Claude。";
  if (e.status === 403 && /insufficient|scope/i.test(m)) return "登入時沒有同意全部項目。請回到第 1 步重新登入，兩個項目都要勾選同意。";
  if (e.status === 429) return "Google 說操作太頻繁，請等一分鐘再試。";
  return `發生錯誤（${e.status || "?"}）：${m}`;
}

/** 呼叫 Google 的服務。讀取遇到暫時性錯誤會自動重試；新增只在「太頻繁」（確定沒寫進去）時重試，避免寫兩次。 */
async function api(method, url, { params = {}, body, rawBody, headers = {} } = {}) {
  if (!state.token) throw new UserError("還沒登入，請先做第 1 步。");
  if (Date.now() > state.tokenExp) throw new UserError("登入已過期（Google 的登入一小時內有效），請回到第 1 步重新登入。");
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(u, {
      method,
      headers: { Authorization: "Bearer " + state.token, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: rawBody ?? (body ? JSON.stringify(body) : undefined),
    });
    log(`${method} ${u.pathname}${u.searchParams.has("query") ? "?query=" + maskQuery(u.searchParams.get("query")) : ""} → ${res.status}`);
    const retryable = res.status === 429 || (method === "GET" && res.status >= 500);
    if (retryable && attempt < 2) {
      await sleep(attempt === 0 ? 3000 : 10000);
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
      log("  錯誤內容：" + err.message);
      throw err;
    }
    return json;
  }
}

/** 包住每個按鈕的動作：執行中鎖住按鈕、出錯時顯示看得懂的訊息。 */
function action(btnId, step, fn) {
  $(btnId).addEventListener("click", async () => {
    const b = $(btnId);
    const label = b.textContent;
    b.disabled = true;
    b.textContent = "處理中…";
    try {
      await fn();
    } catch (e) {
      log(`${step} 失敗：${e.status || ""} ${e.message}`);
      show(step, [["bad", explain(e)]]);
    } finally {
      b.textContent = label;
      b.disabled = false;
    }
  });
}

// ---------- 0. 這支手機的狀況 ----------

function checkEnv() {
  const ua = navigator.userAgent;
  const device = /iPhone|iPad|iPod/.test(ua) ? "iPhone／iPad" : /Android/.test(ua) ? "Android" : "電腦";
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const lines = [["", `裝置：${device}`]];
  lines.push(standalone ? ["ok", "目前是從主畫面圖標開啟（全螢幕 App 模式）"] : ["", "目前是在瀏覽器分頁裡開啟（還不是全螢幕 App 模式）"]);
  // 規則程式自我檢查：在這支手機的瀏覽器裡實際跑一次
  try {
    const { body, whole } = G.build_person({
      mode: "category", category: "廠商", name: "王小明", third: "大順廚具",
      phones: [{ value: "0912345678", kind: "手機" }, { value: "(02)2345-6789 分機 123", kind: "公司" }],
      address: { text: "松仁路100號11樓 臺北市", zip: "110" },
    });
    const got = [whole, body.phoneNumbers[0].value, body.phoneNumbers[1].value, body.addresses[0].formattedValue].join("｜");
    const want = "廠商-王小明_大順廚具｜0912-345-678｜02-2345-6789,123｜台北市信義區松仁路100號11樓";
    lines.push(got === want ? ["ok", "規則程式在這支手機上運作正常"] : ["bad", `規則程式結果不對：${got}`]);
  } catch (e) {
    lines.push(["bad", `規則程式在這支手機上跑不起來：${e.message}`]);
  }
  if (device === "iPhone／iPad" && !standalone) lines.push(["", "加到主畫面：按 Safari 下方的「分享」→「加入主畫面」。"]);
  if (device === "Android" && !standalone) lines.push(["", "安裝：按下面的「安裝到主畫面」；沒出現按鈕的話，按 Chrome 右上角「⋮」→「安裝應用程式」或「加到主畫面」。"]);
  show("env", lines);
  log(`UA: ${ua}`);
  log(`standalone: ${standalone}；版本：${CONFIG.VERSION}`);
}

function setupInstall() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").then(
      () => log("背景程式註冊成功"),
      (e) => log("背景程式註冊失敗：" + e.message),
    );
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    state.installEvent = e;
    log("這支手機可以安裝成 App（beforeinstallprompt）");
    if ($("b-install")) return;
    const b = document.createElement("button");
    b.id = "b-install";
    b.textContent = "安裝到主畫面";
    b.style.marginTop = "10px";
    b.addEventListener("click", async () => {
      state.installEvent.prompt();
      const choice = await state.installEvent.userChoice;
      log("安裝提示結果：" + choice.outcome);
      if (choice.outcome === "accepted") b.remove();
    });
    $("r-env").after(b);
  });
  window.addEventListener("appinstalled", () => {
    log("已安裝到主畫面");
    summary.install = "✓ 已安裝到主畫面";
  });
}

// ---------- 1. 登入 ----------

function setLoggedIn(on) {
  for (const id of ["b-write", "b-photo", "b-matrix"]) $(id).disabled = !on;
  const has = Boolean(saved().last);
  for (const id of ["b-reread", "b-search"]) $(id).disabled = !on || !has;
  $("b-mark").disabled = !on || !(saved().created || []).length;
}

function login() {
  if (!window.google?.accounts?.oauth2) {
    show("login", [["bad", "Google 登入元件還沒載入好，請等幾秒再按一次（或確認網路）。"]]);
    return;
  }
  if (!state.tokenClient) {
    state.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.GOOGLE_CLIENT_ID,
      scope: [SCOPE_CONTACTS, SCOPE_DRIVE, SCOPE_EMAIL].join(" "),
      hd: CONFIG.WORKSPACE_DOMAIN,
      callback: onToken,
      error_callback: (e) => {
        log("登入視窗錯誤：" + (e?.type || "") + " " + (e?.message || ""));
        const why = e?.type === "popup_failed_to_open" ? "登入視窗被擋住了。請允許這個網站開啟彈出式視窗，或改用瀏覽器（iPhone 用 Safari）直接開這個網址。"
          : e?.type === "popup_closed" ? "登入視窗被關掉了，沒有完成登入。" : "登入沒有完成。";
        show("login", [["bad", why]]);
      },
    });
  }
  // 一定要在按鈕的點擊動作裡直接呼叫，登入視窗才不會被瀏覽器擋掉
  state.tokenClient.requestAccessToken();
}

async function onToken(resp) {
  try {
    if (resp.error) {
      log("登入回應錯誤：" + resp.error + " " + (resp.error_description || ""));
      const why = resp.error === "access_denied" ? "您沒有同意授權，或這個帳號不能用這個 App（只限公司帳號）。" : `登入失敗：${resp.error}`;
      show("login", [["bad", why]]);
      return;
    }
    state.token = resp.access_token;
    state.tokenExp = Date.now() + (Number(resp.expires_in) - 60) * 1000;
    if (!google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE_CONTACTS, SCOPE_DRIVE)) {
      state.token = "";
      show("login", [["bad", "登入時沒有同意全部項目。請再按一次登入，「聯絡人」和「雲端硬碟」兩項都要勾選。"]]);
      setLoggedIn(false);
      return;
    }
    const me = await api("GET", "https://www.googleapis.com/oauth2/v3/userinfo");
    if (me.hd !== CONFIG.WORKSPACE_DOMAIN) {
      google.accounts.oauth2.revoke(state.token, () => {});
      state.token = "";
      setLoggedIn(false);
      show("login", [["bad", `這不是公司帳號（${me.email}）。請改用 ${CONFIG.WORKSPACE_DOMAIN} 的帳號登入。`]]);
      summary.login = "✗ 登入的不是公司帳號（已擋下）";
      return;
    }
    show("login", [["ok", `已登入：${me.email}`], ["", "一小時內有效，過期再按一次登入就好。"]]);
    summary.login = `✓ 已登入公司帳號（網域 ${me.hd}）`;
    setLoggedIn(true);
  } catch (e) {
    log("登入後檢查失敗：" + e.message);
    state.token = "";
    setLoggedIn(false);
    show("login", [["bad", explain(e)]]);
  }
}

// ---------- 2. 寫入測試聯絡人 ----------

/** 找到同名的標籤；沒有就新增一個。回傳 { resourceName, created }。 */
async function findOrCreateLabel(name) {
  const r = await api("GET", PEOPLE + "contactGroups", { params: { pageSize: 1000, groupFields: "name,groupType" } });
  const hit = (r.contactGroups || []).find((g) => g.groupType === "USER_CONTACT_GROUP" && g.name === name);
  if (hit) return { resourceName: hit.resourceName, created: false };
  const made = await api("POST", PEOPLE + "contactGroups", { body: { contactGroup: { name } } });
  return { resourceName: made.resourceName, created: true };
}

function maskPhone(v) {
  const d = v.replace(/\D/g, "");
  return d.length > 4 ? "…" + d.slice(-3) : v;
}

async function writeTest() {
  const mobileIn = $("i-mobile").value.trim();
  const extIn = $("i-ext").value.trim();
  const card = {
    mode: "category", category: TEST_CATEGORY, name: "測試王小明", third: "大順廚具",
    // 沒填就用假號碼；公司電話故意寫成「#123」，確認存進去會變成一個逗號
    phones: [{ value: mobileIn || "0912345678", kind: "手機" }, { value: extIn || "(02)2345-6789 #123", kind: "公司" }],
    emails: ["test-card@example.com"],
    address: { text: "松仁路100號11樓 臺北市", zip: "110" },
    company: "大順廚具股份有限公司", title: "業務經理（測試資料）",
  };
  const pre = G.build_person(card);
  if (pre.warnings.length) {
    show("write", [["bad", "您填的號碼程式看不懂，所以先不寫入："], ...pre.warnings.map((w) => ["", w]), ["", "請改一下號碼再按一次（手機 10 碼；市話要含區碼）。"]]);
    return;
  }
  const label = await findOrCreateLabel(TEST_CATEGORY);
  const { body, whole } = G.build_person({ ...card, groupResourceName: label.resourceName });
  log("送出內容：" + JSON.stringify({ ...body, phoneNumbers: body.phoneNumbers.map((p) => ({ ...p, value: maskPhone(p.value) })) }));
  const made = await api("POST", PEOPLE + "people:createContact", { params: { personFields: PERSON_FIELDS }, body });
  const got = await api("GET", PEOPLE + made.resourceName, { params: { personFields: PERSON_FIELDS } });
  const probs = G.verify_created(body, got);
  log("讀回的地址：" + JSON.stringify((got.addresses || []).map(({ metadata, ...x }) => x)));
  log("讀回的姓名：" + JSON.stringify((got.names || []).map(({ metadata, ...x }) => x)));
  const all = saved().created || [];
  save({ last: { rn: made.resourceName, sent: body, whole }, created: [...all, made.resourceName] });
  setLoggedIn(true);
  const mobile = body.phoneNumbers[0].value;
  const work = body.phoneNumbers[1].value;
  const lines = [["ok", `已新增「${whole}」`]];
  lines.push(probs.length ? ["bad", "寫入後讀回來核對，有地方不一樣："] : ["ok", "寫入後讀回來核對：姓名整串、標籤、電話、地址都符合規則"]);
  for (const p of probs) lines.push(["", "・" + p]);
  lines.push(["", `標籤「${TEST_CATEGORY}」：${label.created ? "原本沒有，已新增" : "用現有的"}`]);
  lines.push(["", `手機 ${mobile}；公司電話 ${work}`]);
  lines.push(["", "接下來請您看四件事，再回來按「複製測試結果」："]);
  lines.push(["", "① 電腦開 Google 聯絡人，這一筆的姓名是不是整串顯示"]);
  lines.push(["", "② 手機通訊錄裡是不是也是整串（可能要等幾分鐘同步）"]);
  lines.push(["", "③ 用您填的那支電話打過來，來電畫面顯示什麼"]);
  lines.push(["", "④ 在通訊錄點那支有分機的公司電話撥出，會不會停一下再自動按分機"]);
  show("write", lines);
  summary.write = lines.slice(0, 3 + probs.length).map(([k, t]) => (k === "ok" ? "✓ " : k === "bad" ? "✗ " : "") + t).join("\n")
    .replace(mobile, maskPhone(mobile));
}

async function reread() {
  const last = saved().last;
  const got = await api("GET", PEOPLE + last.rn, { params: { personFields: PERSON_FIELDS } });
  const probs = G.verify_created(last.sent, got);
  log("重新讀取的地址：" + JSON.stringify((got.addresses || []).map(({ metadata, ...x }) => x)));
  log("重新讀取的姓名：" + JSON.stringify((got.names || []).map(({ metadata, ...x }) => x)));
  const lines = probs.length
    ? [["warn", `「${last.whole}」現在和當初寫入的不一樣（如果是您自己在網頁上改的，屬正常）：`], ...probs.map((p) => ["", "・" + p])]
    : [["ok", `「${last.whole}」和當初寫入的內容一致，地址仍是安全寫法`]];
  show("write", lines);
  summary.reread = "（重新讀取）" + lines.map(([k, t]) => (k === "ok" ? "✓ " : k === "warn" ? "△ " : "") + t).join("\n");
}

// ---------- 3. 照片存到雲端硬碟 ----------

/** 把照片縮到長邊 2000 以內的 JPEG（之後送去辨識也用這個大小）。縮不了就用原檔。 */
async function shrink(file) {
  try {
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((ok, no) => {
      img.onload = ok;
      img.onerror = no;
      img.src = url;
    });
    const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.85));
    if (blob) return { blob, note: `${c.width}×${c.height}` };
  } catch (e) {
    log("縮圖失敗，改用原檔：" + e.message);
  }
  return { blob: file, note: "原檔" };
}

async function uploadPhoto(file) {
  const { blob, note } = await shrink(file);
  const q = `name = '${CONFIG.PHOTO_FOLDER}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const found = await api("GET", DRIVE + "files", { params: { q, fields: "files(id,name)", spaces: "drive" } });
  let folder = (found.files || [])[0];
  const folderNew = !folder;
  if (!folder) {
    folder = await api("POST", DRIVE + "files", { params: { fields: "id,name" }, body: { name: CONFIG.PHOTO_FOLDER, mimeType: "application/vnd.google-apps.folder" } });
  }
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const who = saved().last?.whole || "測試照片";
  const name = `${ymd}_${who}_正面.jpg`;
  const boundary = "junpin" + Math.random().toString(36).slice(2);
  const meta = { name, parents: [folder.id] };
  const rawBody = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`, blob, `\r\n--${boundary}--`,
  ]);
  const up = await api("POST", DRIVE_UPLOAD, {
    params: { uploadType: "multipart", fields: "id,name,size,shared" },
    rawBody, headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
  });
  const kb = Math.round(Number(up.size || blob.size) / 1024);
  show("photo", [
    ["ok", `已存到雲端硬碟「${CONFIG.PHOTO_FOLDER}」${folderNew ? "（資料夾是剛剛新建的）" : ""}`],
    ["", `檔名：${up.name}（${note}，約 ${kb} KB）`],
    up.shared ? ["bad", "注意：這個檔案顯示為「已分享」，不應該這樣，請告訴 Claude"] : ["ok", "沒有分享給任何人"],
  ]);
}

// ---------- 4. 用手機號碼找現有聯絡人 ----------

async function searchTest() {
  const last = saved().last;
  const mobile = last.sent.phoneNumbers[0].value;
  const digits = mobile.replace(/\D/g, "");
  const tries = [
    ["手機（有橫線，和存的一樣）", mobile],
    ["手機（只有數字）", digits],
    ["手機前 7 碼（有橫線）", mobile.slice(0, 8)],
    ["手機前 7 碼（只有數字）", digits.slice(0, 7)],
    ["Email", last.sent.emailAddresses[0].value],
    ["姓名（不含類別）", "測試王小明"],
    ["整串姓名", last.whole],
    ["公司名", "大順廚具"],
  ];
  const foundAt = tries.map(() => null);
  const render = (waiting) => {
    const rows = tries.map(([label], i) => `<tr><td>${esc(label)}</td><td>${foundAt[i] === null ? '<span class="pill">還沒查到</span>' : `<span class="pill ok">查到了（第 ${foundAt[i]} 秒）</span>`}</td></tr>`).join("");
    $("r-search").innerHTML = `<table><tr><th>查法</th><th>結果</th></tr>${rows}</table>${waiting ? `<div>${esc(waiting)}</div>` : ""}`;
  };
  // 官方文件：搜尋前要先送一次空白查詢，讓 Google 更新搜尋用的資料
  await api("GET", PEOPLE + "people:searchContacts", { params: { query: "", readMask: "names" } });
  const t0 = Date.now();
  for (const wait of [2, 5, 10, 15, 28]) {
    render(`等 ${wait} 秒再查…`);
    await sleep(wait * 1000);
    for (let i = 0; i < tries.length; i++) {
      if (foundAt[i] !== null) continue;
      const r = await api("GET", PEOPLE + "people:searchContacts", { params: { query: tries[i][1], readMask: "names,phoneNumbers,emailAddresses", pageSize: 30 } });
      if ((r.results || []).some((x) => x.person?.resourceName === last.rn)) foundAt[i] = Math.round((Date.now() - t0) / 1000);
      await sleep(250);
    }
    render("");
    if (foundAt.every((x) => x !== null)) break;
  }
  const phoneOk = foundAt[0] !== null || foundAt[1] !== null;
  const verdict = phoneOk ? "✓ 用手機號碼查得到現有聯絡人" : "✗ 一分鐘內用手機號碼查不到（可能要換一種查法，請把結果傳給 Claude）";
  $("r-search").insertAdjacentHTML("afterbegin", `<div class="${phoneOk ? "ok" : "bad"}">${esc(verdict)}</div>`);
  summary.search = verdict + "\n" + tries.map(([label], i) => `  ${label}：${foundAt[i] === null ? "查不到" : `第 ${foundAt[i]} 秒查到`}`).join("\n");
}

// ---------- 4b. 進階查重：同一支號碼存成不同寫法，哪些查法找得到 ----------

// 全部是假號碼。目的：通訊錄裡的號碼不一定都是規則的寫法（例如手機上手動新增的），要知道怎麼查才不會漏。
const MATRIX_STORED = [
  ["A", "0987-654-321", "規則的寫法"], ["B", "0987654321", "只有數字"], ["C", "0987 654 321", "用空白隔開"],
  ["D", "+886987654321", "+886 連寫"], ["E", "+886 987 654 321", "+886 用空白隔開"], ["F", "0987-654321", "只有一條橫線"],
];
const MATRIX_QUERIES = ["0987-654-321", "0987654321", "0987 654 321", "+886987654321", "+886 987 654 321", "0987-654321",
  "0987", "0987-654", "654-321", "654", "321", "987654321", "886987654321", "+886 987", "+886"];

async function matrixTest() {
  const label = await findOrCreateLabel(TEST_CATEGORY);
  const made = { ...(saved().matrix || {}) };
  for (const [L, value] of MATRIX_STORED) {
    if (made[L]) continue; // 之前按過就沿用，不重複新增
    $("r-matrix").textContent = `新增假聯絡人 ${L}…`;
    const body = {
      names: [{ givenName: `${TEST_CATEGORY}-測試查重${L}` }],
      phoneNumbers: [{ value, type: "mobile" }],
      memberships: [{ contactGroupMembership: { contactGroupResourceName: label.resourceName } }],
    };
    const r = await api("POST", PEOPLE + "people:createContact", { params: { personFields: "names,phoneNumbers" }, body });
    made[L] = r.resourceName;
    save({ matrix: made, created: [...(saved().created || []), r.resourceName] });
    const stored = (r.phoneNumbers || []).map((x) => x.value).join("、");
    if (stored !== value) log(`注意：${L} 存進去的寫法被改了：送「${value}」，讀到「${stored}」`);
  }
  setLoggedIn(true);
  const byRn = Object.fromEntries(Object.entries(made).map(([L, rn]) => [rn, L]));
  const found = MATRIX_QUERIES.map(() => new Set());
  const render = (waiting) => {
    const head = "<tr><th>查的字</th><th>找到哪幾筆</th></tr>";
    const rows = MATRIX_QUERIES.map((q, i) => `<tr><td>${esc(q)}</td><td>${[...found[i]].sort().join(" ") || "—"}</td></tr>`).join("");
    const legend = MATRIX_STORED.map(([L, v, d]) => `${L}＝${v}（${d}）`).join("\n");
    $("r-matrix").innerHTML = `<div>${esc(legend)}</div><table>${head}${rows}</table>${waiting ? `<div>${esc(waiting)}</div>` : ""}`;
  };
  await api("GET", PEOPLE + "people:searchContacts", { params: { query: "", readMask: "names" } });
  let lastTotal = -1;
  for (const wait of [5, 10, 15, 25]) {
    render(`等 ${wait} 秒再查（Google 需要一點時間才查得到新資料）…`);
    await sleep(wait * 1000);
    for (let i = 0; i < MATRIX_QUERIES.length; i++) {
      const r = await api("GET", PEOPLE + "people:searchContacts", { params: { query: MATRIX_QUERIES[i], readMask: "names,phoneNumbers", pageSize: 30 } });
      for (const x of r.results || []) if (byRn[x.person?.resourceName]) found[i].add(byRn[x.person.resourceName]);
      await sleep(250);
    }
    const total = found.reduce((n, s) => n + s.size, 0);
    render("");
    if (total === lastTotal && total > 0) break; // 連續兩輪結果一樣就不用再等
    lastTotal = total;
  }
  const all = MATRIX_STORED.map(([L]) => L).join("");
  const full = MATRIX_QUERIES.filter((q, i) => [...found[i]].sort().join("") === all);
  $("r-matrix").insertAdjacentHTML("afterbegin", `<div class="ok">✓ 測完了。請按最下面的「複製測試結果」貼給 Claude，由他判斷查重要怎麼做。</div>`);
  summary.matrix = "存法：" + MATRIX_STORED.map(([L, v]) => `${L}=${v}`).join("；") + "\n"
    + MATRIX_QUERIES.map((q, i) => `  查「${q}」→ ${[...found[i]].sort().join("") || "（都沒找到）"}`).join("\n")
    + `\n  六筆都找得到的查法：${full.join("、") || "沒有"}`;
}

// ---------- 6. 請您親眼確認（用選的） ----------

const OBS = [["o-mode", "從主畫面圖標開啟"], ["o-web", "電腦的 Google 聯絡人"], ["o-phone", "手機通訊錄"], ["o-call", "來電畫面"], ["o-ext", "撥分機"]];

function setupObs() {
  const keep = saved().obs || {};
  const update = () => {
    const obs = Object.fromEntries(OBS.map(([id]) => [id, $(id).value]));
    save({ obs });
    const lines = OBS.filter(([id]) => obs[id]).map(([id, title]) => `${title}：${obs[id]}`);
    if (lines.length) summary.obs = lines.join("\n");
    else delete summary.obs;
  };
  for (const [id] of OBS) {
    if (keep[id]) $(id).value = keep[id];
    $(id).addEventListener("change", update);
  }
  update();
}

// ---------- 5. 掛「_待刪除」 ----------

async function markTrash() {
  const rns = [...new Set(saved().created || [])];
  if (!rns.length) throw new UserError("這支手機上沒有測試頁新增過的聯絡人紀錄。");
  const label = await findOrCreateLabel(TRASH_LABEL);
  const r = await api("POST", PEOPLE + label.resourceName + "/members:modify", { body: { resourceNamesToAdd: rns } });
  const missing = (r.notFoundResourceNames || []).length;
  show("mark", [
    ["ok", `已把 ${rns.length - missing} 筆測試聯絡人掛上「${TRASH_LABEL}」${label.created ? "（這個標籤原本沒有，已新增）" : ""}`],
    ...(missing ? [["", `另有 ${missing} 筆已經不存在（可能您已經刪掉了）`]] : []),
    ["", "請到 Google 聯絡人左邊點「_待刪除」標籤，自己確認後刪除。這個測試頁不會刪任何東西。"],
  ]);
}

// ---------- 複製結果 ----------

async function copyResults() {
  const order = [["env", "0 手機狀況"], ["install", "安裝"], ["login", "1 登入"], ["write", "2 寫入"], ["reread", "2 寫入"], ["photo", "3 照片"], ["search", "4 查重"], ["matrix", "4b 進階查重"], ["obs", "6 親眼確認"], ["mark", "5 待刪除"]];
  const text = [`【雋品名片 階段0 測試結果】${CONFIG.VERSION}`, new Date().toLocaleString("zh-TW")]
    .concat(order.filter(([k]) => summary[k]).map(([k, title]) => `■ ${title}\n${summary[k]}`))
    .concat(["■ 技術紀錄", $("log").textContent.trim()])
    .join("\n\n");
  try {
    await navigator.clipboard.writeText(text);
    $("r-copy").innerHTML = '<div class="ok">✓ 已複製。回到電腦貼給 Claude 就可以了。</div>';
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "width:100%;height:160px;margin-top:8px;font-size:13px";
    $("r-copy").innerHTML = "<div>這支手機不能自動複製，請長按下面的文字 → 全選 → 複製：</div>";
    $("r-copy").append(ta);
    ta.select();
  }
}

// ---------- 啟動 ----------

$("ver").textContent = CONFIG.VERSION;
checkEnv();
setupInstall();
setLoggedIn(false);
if (!CONFIG.GOOGLE_CLIENT_ID) {
  $("banner").textContent = "這個測試頁還沒接上 Google 登入（要等 Google 後台設定完成）。現在只有第 0 項看得到結果。";
  $("b-login").disabled = true;
} else {
  $("b-login").addEventListener("click", login);
}
action("b-write", "write", writeTest);
action("b-reread", "write", reread);
action("b-search", "search", searchTest);
action("b-matrix", "matrix", matrixTest);
action("b-mark", "mark", markTrash);
setupObs();
$("b-photo").addEventListener("click", () => $("i-photo").click());
$("i-photo").addEventListener("change", async () => {
  const file = $("i-photo").files[0];
  if (!file) return;
  $("b-photo").disabled = true;
  show("photo", [["", "上傳中…"]]);
  try {
    await uploadPhoto(file);
  } catch (e) {
    log("照片上傳失敗：" + (e.status || "") + " " + e.message);
    show("photo", [["bad", explain(e)]]);
  } finally {
    $("b-photo").disabled = false;
    $("i-photo").value = "";
  }
});
$("b-copy").addEventListener("click", copyResults);

// 雋品名片：正式畫面的動作。
// 流程：登入 →（第一次選姓名模式）→ 首頁 → 拍照／輸入 → 表單（每格可改、即時預覽整串）→ 查重 → 存入 → 完成。
// 規則都在 rules.js、address.js、gcontact.js、dedupe.js（有自動測試）；這個檔只管畫面。
// 「辨識」還沒接上（等 Claude 額度），現在是手動輸入。
import { CONFIG } from "../config.js";
import { cn_digits, to_half } from "./cnnum.js";
import * as D from "./dedupe.js";
import * as GC from "./gcontact.js";
import * as L from "./labels.js";
import * as M from "./merge.js";
import * as R from "./rules.js";
import * as W from "./writer.js";

const demo = new URLSearchParams(location.search).has("demo");
const LS_KEY = demo ? "junpin-card-demo" : "junpin-card";
const TRASH_LABEL = "_待刪除";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let G; // 連 Google 的那一層（正式：google.js；示範模式：google_mock.js）
const S = {
  mode: "", // "category"（類別模式）或 "plain"（一般模式）
  labels: [], // 使用者的標籤：{ resourceName, name }；剛在這裡新增、還沒存進 Google 的，resourceName 是空的
  photos: { front: null, back: null }, // { orig（原圖）, turns（順時針轉了幾次 90°）, blob（要存的圖）, url }
  thirdTouched: false, // 使用者自己改過第三段，就不再自動帶入建議
  plainLabels: new Set(), // 一般模式點選的標籤（存名稱）
  warnSeen: "", // 已經提醒過的黃色警告（同樣的警告不重複擋）
  pendingCard: null, // 查重畫面上等待決定的那一張
  upd: null, // 「更新這一筆」進行中的資料：{ rn, person（比對時讀到的完整資料）, plan, choices }
  lastUpdate: null, // 剛完成的更新（用來「復原這次更新」）：{ rn, name }
};

// ---------- 小工具 ----------

// 這支手機上記住的東西（姓名模式、上次用的類別、還沒存的草稿）是「跟著帳號」分開記的：
// 同一支手機換另一個帳號登入，不會看到前一個人的模式和草稿。
let ACCT = "";
const storeKey = () => (ACCT ? `${LS_KEY}/${ACCT}` : LS_KEY);

function store() {
  try {
    return JSON.parse(localStorage.getItem(storeKey()) || "{}");
  } catch {
    return {};
  }
}
function keep(patch) {
  try {
    localStorage.setItem(storeKey(), JSON.stringify({ ...store(), ...patch }));
  } catch {
    /* 存不了（例如無痕模式）不影響使用，只是不會記住 */
  }
}

/** 登入後呼叫：之後記的東西都歸這個帳號。舊版記在「整支手機共用」的設定，搬給第一個登入的帳號。 */
function useAccount(email) {
  ACCT = email || "";
  if (!ACCT) return;
  try {
    const old = localStorage.getItem(LS_KEY);
    if (old !== null) {
      if (localStorage.getItem(storeKey()) === null) localStorage.setItem(storeKey(), old);
      localStorage.removeItem(LS_KEY);
    }
  } catch {
    /* 搬不了就當成第一次使用 */
  }
}

function view(name) {
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== "v-" + name;
  const inApp = G?.loggedIn() && name !== "mode";
  $("b-settings").hidden = !inApp || name === "settings";
  $("b-home").hidden = !inApp || name === "home" || name === "form";
  window.scrollTo(0, 0);
}

function busy(text) {
  $("busy").hidden = !text;
  $("busy-text").textContent = text || "";
}

/** 在某個訊息區顯示錯誤；登入失效的話，附上「重新登入」按鈕。 */
function showError(id, e) {
  const box = $(id);
  box.className = "msg bad";
  box.textContent = G.explain(e);
  if (!G.loggedIn()) {
    const b = document.createElement("button");
    b.className = "second";
    b.textContent = "重新登入";
    b.addEventListener("click", async () => {
      try {
        const p = G.login(); // 直接在點擊裡呼叫，登入視窗才不會被擋
        box.className = "msg";
        box.textContent = "登入中…";
        await p;
        await loadLabels();
        box.className = "msg ok";
        box.textContent = "已重新登入，請再按一次剛才的按鈕。";
      } catch (err) {
        showError(id, err);
      }
    });
    box.append(b);
  }
}

const toHalf = to_half; // 全形數字與符號轉半形（名片辨識、手機輸入法常見）

// ---------- 登入與開場 ----------

async function loadLabels() {
  const pending = S.labels.filter((l) => !l.resourceName); // 剛新增、還沒存進 Google 的先留著
  const got = await G.listLabels();
  S.labels = [...got, ...pending.filter((p) => !got.some((g) => g.name === p.name))];
  L.learn_categories(S.labels);
}

/** 確保清單裡有這個名稱的標籤（沒有就先記成「待新增」，存入聯絡人時才真的建立）。 */
function ensureLabel(name) {
  let l = S.labels.find((x) => x.name === name);
  if (!l) {
    l = { resourceName: "", name };
    S.labels.push(l);
    L.learn_categories([l]);
  }
  return l;
}

async function afterLogin() {
  busy("讀取您的標籤…");
  try {
    await loadLabels();
  } finally {
    busy("");
  }
  useAccount(G.account());
  S.mode = store().mode || "";
  if (!S.mode) view("mode");
  else goHome();
}

/** 顯示登入頁。記得上次的帳號時，按鈕直接寫明用哪個帳號，另外給「用別的帳號」。 */
function showLogin() {
  const last = G.lastAccount();
  $("b-login").textContent = last ? `登入（${last}）` : "用公司帳號登入";
  $("b-login-other").hidden = !last;
  $("m-login").textContent = "";
  view("login");
}

function goHome() {
  $("home-acct").textContent = "登入帳號：" + G.account() + "　｜　版本：" + CONFIG.VERSION;
  $("home-mode-name").textContent = S.mode === "category" ? "類別模式" : "一般模式";
  $("home-mode-desc").textContent = S.mode === "category"
    ? "姓名會存成「類別-姓名_公司或專長」，例如：廠商-王小明_大順廚具，並掛上和類別同名的標籤。"
    : "只存姓名，例如：王小明；標籤可以自己點選。";
  const d = store().draft;
  const has = d && (d.name || d.company || (d.phones || []).some((p) => p.value) || (d.emails || []).some(Boolean));
  $("draft-box").hidden = !has;
  if (has) $("draft-desc").textContent = [d.name, d.company].filter(Boolean).join("　") || "（已填了一些內容）";
  view("home");
}

// ---------- 表單 ----------

const SIMPLE = { "i-name": "name", "i-third": "third", "i-company": "company", "i-dept": "department", "i-title": "title", "i-addr": "address", "i-zip": "zip", "i-en": "englishName", "i-tax": "taxId", "i-web": "website", "i-note": "note" };
const KINDS = ["手機", "公司", "傳真"];

function phoneRow(kind = "手機", value = "") {
  const row = document.createElement("div");
  row.innerHTML = `<div class="row"><select aria-label="電話種類">${KINDS.map((k) => `<option${k === kind ? " selected" : ""}>${k}</option>`).join("")}</select>
    <div class="grow"><input type="tel" inputmode="tel" autocomplete="off" value="${esc(value)}"></div><button type="button" class="x" aria-label="刪掉這支電話">×</button></div><div class="note warn"></div>`;
  const input = row.querySelector("input");
  const sel = row.querySelector("select");
  const tidy = () => {
    tidyPhone(row);
    saveDraft();
  };
  input.addEventListener("blur", tidy);
  sel.addEventListener("change", tidy);
  input.addEventListener("input", saveDraft);
  row.querySelector(".x").addEventListener("click", () => {
    row.remove();
    saveDraft();
  });
  $("phones").append(row);
  return row;
}

/** 照規則整理一支電話；看不懂的不硬改，標黃色並說明原因（規則文件 5.4）。 */
function tidyPhone(row) {
  const input = row.querySelector("input");
  const sel = row.querySelector("select");
  const note = row.querySelector(".note");
  const raw = toHalf(input.value).trim();
  input.classList.remove("warn");
  note.textContent = "";
  note.className = "note";
  if (!raw) {
    input.value = "";
    return "";
  }
  const r = GC.prepare_phone(raw, sel.value);
  if (r.ok) {
    input.value = r.value;
    const says = [];
    const kind = { mobile: "手機", work: "公司", workFax: "傳真" }[r.type];
    if (kind && kind !== sel.value) {
      sel.value = kind;
      says.push(`09 開頭是手機，已改成「${kind}」。`);
    }
    if (r.note) says.push(r.note + "，請看一下對不對。");
    note.textContent = says.join("");
    return "";
  }
  input.value = raw;
  input.classList.add("warn");
  note.className = "note warn";
  note.textContent = `這支號碼程式看不懂（${r.reason}），會照您寫的原樣存。請看一下有沒有打錯。`;
  return `電話:${raw}`;
}

function emailRow(value = "") {
  const row = document.createElement("div");
  row.innerHTML = `<div class="row"><div class="grow"><input type="email" inputmode="email" autocomplete="off" autocapitalize="off" value="${esc(value)}"></div><button type="button" class="x" aria-label="刪掉這個 Email">×</button></div><div class="note warn"></div>`;
  const input = row.querySelector("input");
  input.addEventListener("blur", () => {
    tidyEmail(row);
    saveDraft();
  });
  input.addEventListener("input", saveDraft);
  row.querySelector(".x").addEventListener("click", () => {
    row.remove();
    saveDraft();
  });
  $("emails").append(row);
  return row;
}

function tidyEmail(row) {
  const input = row.querySelector("input");
  const note = row.querySelector(".note");
  const v = toHalf(input.value).trim();
  input.value = v;
  input.classList.remove("warn");
  note.textContent = "";
  if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    input.classList.add("warn");
    note.textContent = "這個 Email 的格式看起來不對，請看一下有沒有打錯。";
    return `Email:${v}`;
  }
  return "";
}

/** 照規則整理地址；看不懂的不硬改，標黃色（規則文件 7.1）。順序反了的附上排正的建議，由使用者決定要不要用。 */
function tidyAddress() {
  const input = $("i-addr");
  const note = $("n-addr");
  const raw = toHalf(input.value).trim();
  input.classList.remove("warn");
  note.textContent = "";
  if (!raw) {
    input.value = "";
    return "";
  }
  note.className = "note";
  $("i-zip").value = cn_digits(toHalf($("i-zip").value)).trim();
  const a = GC.prepare_address(raw, $("i-zip").value);
  if (a.ok) {
    input.value = a.text;
    if (a.zip && !$("i-zip").value.trim()) $("i-zip").value = a.zip;
    if (a.note) note.textContent = a.note + "，請看一下對不對。";
    return "";
  }
  note.className = "note warn";
  input.value = raw;
  // 英文、國外地址本來就不整理，不算問題，不用標黃色
  if (a.reason === "不是中文地址" || a.reason.startsWith("國家不是台灣")) return "";
  input.classList.add("warn");
  note.textContent = a.suggest
    ? "這個地址的順序看起來是反的（樓或號寫在路名前面）。不改的話會照您寫的原樣存；也可以按下面的按鈕改成建議的寫法。"
    : `這個地址程式看不懂（${a.reason}），會照您寫的原樣存。`;
  if (a.suggest) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "second";
    b.textContent = `改成「${a.suggest}」`;
    b.addEventListener("click", () => {
      input.value = a.suggest;
      tidyAddress();
      saveDraft();
    });
    note.append(document.createElement("br"), b);
  }
  return `地址:${raw}`;
}

function nameProblem() {
  const name = $("i-name").value.trim();
  if (!name) return "請填姓名。";
  if (S.mode === "category" && /[-_－＿–—]/.test(name)) return "姓名裡不要有「-」或「_」，這兩個符號是用來隔開類別和第三段的。";
  return "";
}

/** 第三段的建議（規則文件 3.3）：技師、財務找專長；雋品、建築師空白；其他用公司簡稱。只是建議，可改可清空。 */
function refreshThird() {
  if (S.mode !== "category") return;
  const sug = $("i-cat").value ? GC.suggest_third($("i-cat").value, { title: $("i-title").value.trim(), company: $("i-company").value.trim() }) : "";
  if (!S.thirdTouched) $("i-third").value = sug;
  const box = $("third-sug");
  box.innerHTML = "";
  if (sug && $("i-third").value.trim() !== sug) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = `建議：${sug}`;
    b.addEventListener("click", () => {
      S.thirdTouched = false;
      refreshThird();
      refreshPreview();
      saveDraft();
    });
    box.append(b);
  }
}

function wholeName() {
  const name = $("i-name").value.trim();
  if (S.mode === "plain") return name;
  return R.compose($("i-cat").value, name, $("i-third").value.trim());
}

function refreshPreview() {
  const name = $("i-name").value.trim();
  if (S.mode === "plain") {
    const picked = [...S.plainLabels];
    $("pv").innerHTML = `會存成：<strong>${esc(name || "（還沒填姓名）")}</strong><br>標籤：${esc(picked.join("、") || "不掛標籤")}`;
    return;
  }
  const cat = $("i-cat").value;
  $("pv").innerHTML = cat
    ? `會存成：<strong>${esc(name ? wholeName() : cat + "-（還沒填姓名）")}</strong><br>標籤：${esc(cat)}`
    : "請先選類別。";
}

function renderLabelChips() {
  const box = $("label-chips");
  box.innerHTML = "";
  for (const l of L.order_labels(S.labels)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (S.plainLabels.has(l.name) ? " on" : "");
    b.textContent = l.name + (l.resourceName ? "" : "（新）");
    b.addEventListener("click", () => {
      if (S.plainLabels.has(l.name)) S.plainLabels.delete(l.name);
      else S.plainLabels.add(l.name);
      b.classList.toggle("on");
      refreshPreview();
      saveDraft();
    });
    box.append(b);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.className = "chip";
  add.textContent = "＋ 新增標籤";
  add.addEventListener("click", () => showNewLabel(true));
  box.append(add);
}

/** 類別模式的下拉選單：選項是使用者自己的標籤，最後一項是「新增標籤」。 */
function renderCategoryOptions(selected) {
  const opts = L.order_labels(S.labels).map((l) => `<option value="${esc(l.name)}">${esc(l.name)}${l.resourceName ? "" : "（新）"}</option>`);
  $("i-cat").innerHTML = '<option value="">（請選擇）</option>' + opts.join("") + '<option value="__new__">＋ 新增標籤…</option>';
  $("i-cat").value = S.labels.some((l) => l.name === selected) ? selected : "";
}

function showNewLabel(on) {
  $("new-label").hidden = !on;
  $("n-new-label").textContent = "";
  if (on) {
    $("i-new-label").value = "";
    $("i-new-label").focus();
  }
}

/** 按「加入」：檢查名稱 → 記成待新增（存入聯絡人時才真的建立）→ 直接選用。 */
function addNewLabel() {
  const asCategory = S.mode === "category";
  const r = L.check_new_label($("i-new-label").value, S.labels.map((l) => l.name), asCategory);
  if (!r.ok) {
    $("n-new-label").textContent = r.reason;
    return;
  }
  ensureLabel(r.name);
  showNewLabel(false);
  if (asCategory) {
    renderCategoryOptions(r.name);
    $("i-cat").classList.remove("bad");
    refreshThird();
  } else {
    S.plainLabels.add(r.name);
    renderLabelChips();
  }
  refreshPreview();
  saveDraft();
}

function setPhoto(side, photo) {
  if (S.photos[side]?.url) URL.revokeObjectURL(S.photos[side].url);
  S.photos[side] = photo;
  const tile = $("p-" + side);
  tile.classList.toggle("has", Boolean(photo));
  tile.style.backgroundImage = photo ? `url(${photo.url})` : "";
  tile.textContent = photo ? (side === "front" ? "正面（點一下更換）" : "反面（點一下更換）") : side === "front" ? "＋正面" : "＋反面（選填）";
  $("r-" + side).hidden = !photo;
  tile.classList.remove("tall");
  if (photo) {
    const im = new Image();
    im.onload = () => {
      if (S.photos[side] === photo) tile.classList.toggle("tall", im.naturalHeight > im.naturalWidth);
    };
    im.src = photo.url;
  }
}

/** 把原圖順時針轉 turns 次 90°。每次都從原圖重畫，轉幾次畫質都不會變差。 */
async function turned(orig, turns) {
  if (!turns) return orig;
  const url = URL.createObjectURL(orig);
  try {
    const img = new Image();
    await new Promise((ok, no) => {
      img.onload = ok;
      img.onerror = no;
      img.src = url;
    });
    const c = document.createElement("canvas");
    const swap = turns % 2 === 1;
    c.width = swap ? img.naturalHeight : img.naturalWidth;
    c.height = swap ? img.naturalWidth : img.naturalHeight;
    const g = c.getContext("2d");
    g.translate(c.width / 2, c.height / 2);
    g.rotate((turns * Math.PI) / 2);
    g.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    return (await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.9))) || orig;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function rotatePhoto(side) {
  const ph = S.photos[side];
  if (!ph) return;
  const turns = (ph.turns + 1) % 4;
  const blob = await turned(ph.orig, turns);
  setPhoto(side, { orig: ph.orig, turns, blob, url: URL.createObjectURL(blob) });
}

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
    if (blob) return blob;
  } catch {
    /* 縮圖失敗就用原檔 */
  }
  return file;
}

/** 點照片格子：出現小選單（拍照／從相簿選／移除）。 */
function openPhotoMenu(side) {
  const menu = $("photo-menu");
  if (!menu.hidden && menu.dataset.side === side) {
    menu.hidden = true; // 再點一次同一格就收起來
    return;
  }
  menu.dataset.side = side;
  $("photo-menu-title").textContent = side === "front" ? "名片正面" : "名片反面";
  $("pm-remove").hidden = !S.photos[side];
  menu.hidden = false;
}

/** inputId：這次是從哪一個入口來的（f-正反面＝相機；f-正反面-pick＝相簿）。 */
async function onPhotoPicked(side, inputId) {
  const input = $(inputId);
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  const blob = await shrink(file);
  setPhoto(side, { orig: blob, turns: 0, blob, url: URL.createObjectURL(blob) });
}

/** 把畫面上的內容收成一張「名片」資料（格式見 gcontact.build_person）。 */
function collect() {
  const phones = [...$("phones").children].map((row) => ({ kind: row.querySelector("select").value, value: row.querySelector("input").value.trim() })).filter((p) => p.value);
  const emails = [...$("emails").children].map((row) => row.querySelector("input").value.trim()).filter(Boolean);
  const card = { mode: S.mode, category: S.mode === "category" ? $("i-cat").value : "", phones, emails };
  for (const [id, key] of Object.entries(SIMPLE)) card[key] = $(id).value.trim();
  if (S.mode === "plain") card.third = "";
  card.address = { text: card.address, zip: card.zip };
  card.note = $("i-note").value; // 備註照使用者打的原樣，不去頭尾空白以外的任何處理
  return card;
}

function saveDraft() {
  const c = collect();
  keep({
    draft: {
      ...c, address: c.address.text, zip: c.address.zip, thirdTouched: S.thirdTouched, plainLabels: [...S.plainLabels],
      phones: [...$("phones").children].map((row) => ({ kind: row.querySelector("select").value, value: row.querySelector("input").value })),
      emails: [...$("emails").children].map((row) => row.querySelector("input").value),
    },
  });
}

/** 開啟表單。draft 有內容就照著填回去（上次沒存完的）。 */
function openForm(draft = null) {
  const d = draft || {};
  $("blk-cat").hidden = $("blk-third").hidden = S.mode !== "category";
  $("blk-labels").hidden = S.mode !== "plain";
  if (d.category) ensureLabel(d.category);
  for (const n of d.plainLabels || []) if (typeof n === "string" && n && !n.startsWith("contactGroups/")) ensureLabel(n);
  renderCategoryOptions(d.category || store().lastCategory || "");
  showNewLabel(false);
  for (const [id, key] of Object.entries(SIMPLE)) $(id).value = d[key] || "";
  S.thirdTouched = Boolean(d.thirdTouched);
  S.plainLabels = new Set((d.plainLabels || []).filter((n) => S.labels.some((l) => l.name === n)));
  $("phones").innerHTML = "";
  $("emails").innerHTML = "";
  const phones = d.phones?.length ? d.phones : [{ kind: "手機", value: "" }, { kind: "公司", value: "" }];
  for (const p of phones) phoneRow(p.kind, p.value);
  for (const e of d.emails?.length ? d.emails : [""]) emailRow(e);
  if (!draft) {
    setPhoto("front", null);
    setPhoto("back", null);
  }
  $("more").open = Boolean(d.englishName || d.taxId || d.website || d.note);
  for (const id of ["n-name", "n-addr", "m-form"]) $(id).textContent = "";
  for (const el of document.querySelectorAll("#v-form .warn, #v-form .bad")) if (el.tagName !== "DIV") el.classList.remove("warn", "bad");
  S.warnSeen = "";
  renderLabelChips();
  refreshThird();
  refreshPreview();
  for (const row of $("phones").children) tidyPhone(row);
  tidyAddress();
  view("form");
}

// ---------- 存入 ----------

async function onSave() {
  const msg = $("m-form");
  msg.className = "msg";
  msg.textContent = "";
  // 1. 每一格再整理一次（有些手機按存入時，最後那一格還沒失去焦點）
  const warns = [...[...$("phones").children].map(tidyPhone), ...[...$("emails").children].map(tidyEmail), tidyAddress()].filter(Boolean);
  refreshThird();
  refreshPreview();
  saveDraft();
  // 2. 一定要有的欄位
  const np = nameProblem();
  $("n-name").textContent = np;
  $("i-name").classList.toggle("bad", Boolean(np));
  const needCat = S.mode === "category" && !$("i-cat").value;
  $("i-cat").classList.toggle("bad", needCat);
  if (np || needCat) {
    msg.className = "msg bad";
    msg.textContent = needCat ? "請先選類別。" : np;
    (needCat ? $("i-cat") : $("i-name")).scrollIntoView({ block: "center" });
    return;
  }
  // 3. 有黃色的格子：第一次先請他看一眼；看過（內容沒變）再按就照存
  const sig = warns.join("|");
  if (sig && sig !== S.warnSeen) {
    S.warnSeen = sig;
    msg.className = "msg warn";
    msg.textContent = `有 ${warns.length} 格標了黃色（程式看不懂的內容），請看一下。確定沒問題的話，再按一次「存入聯絡人」，會照您寫的原樣存。`;
    document.querySelector("#v-form input.warn")?.scrollIntoView({ block: "center" });
    return;
  }
  const card = collect();
  // 4. 查重（只用搜尋）
  let matches;
  busy("檢查通訊錄裡有沒有這個人…");
  try {
    const queries = D.build_queries(card);
    const found = queries.length ? await G.searchAll(queries) : [];
    const trash = S.labels.filter((l) => l.name === TRASH_LABEL).map((l) => l.resourceName);
    matches = D.find_matches(card, found, trash);
  } catch (e) {
    busy("");
    showError("m-form", e);
    return;
  }
  busy("");
  if (matches.length) {
    S.pendingCard = card;
    renderDup(card, matches);
    view("dup");
    return;
  }
  await writeNew(card, "m-form");
}

function renderDup(card, matches) {
  $("dup-new").textContent = card.mode === "plain" ? card.name : R.compose(card.category, card.name, card.third);
  $("m-dup").textContent = "";
  $("dup-list").innerHTML = matches.map((m) => {
    const s = D.summarize(m.person);
    return `<div class="card dup ${m.level === "strong" ? "strong" : ""}">
      <div class="why">${esc(m.title)}</div>
      <div class="who">${esc(s.name)}</div>
      <div class="more">${esc([...s.orgs, ...s.phones, ...s.emails].join("　｜　") || "（沒有其他資料）")}</div>
      <button class="second" data-update="${esc(m.person.resourceName)}" style="margin-top:10px">更新這一筆</button>
    </div>`;
  }).join("");
  for (const b of $("dup-list").querySelectorAll("[data-update]")) b.addEventListener("click", () => startUpdate(b.dataset.update));
}

/** 這一張有拍的照片，先用「待上傳」佔位，讓比對結果看得到「會加上照片連結」。 */
function pendingPhotoLinks() {
  return [["front", "名片正面"], ["back", "名片反面"]].filter(([side]) => S.photos[side]).map(([, label]) => ({ label, url: "（存入時上傳）" }));
}

/**
 * 把照片存到雲端硬碟，回傳 { photoLinks, photoLines }。存過的會記住，重試時不會重複上傳。
 * 照片沒存成功不擋後面的步驟（只是少了連結）；登入失效則整個停下來。
 */
async function uploadPhotos(nameForFile) {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const photoLinks = [];
  const photoLines = [];
  for (const [side, zh] of [["front", "正面"], ["back", "反面"]]) {
    const ph = S.photos[side];
    if (!ph) continue;
    const fileName = `${ymd}_${nameForFile}_${zh}.jpg`;
    try {
      if (!ph.uploaded || ph.uploaded.name !== fileName) {
        busy(`存${zh}照片到雲端硬碟…`);
        ph.uploaded = await G.uploadPhoto(ph.blob, fileName);
      }
      if (ph.uploaded.link) photoLinks.push({ label: `名片${zh}`, url: ph.uploaded.link });
      photoLines.push(ph.uploaded.shared ? ["warn", `${zh}照片已存，但顯示為「已分享」，請告訴 Claude`]
        : ["ok", `${zh}照片已存到雲端硬碟「${CONFIG.PHOTO_FOLDER}」，連結放在聯絡人的網站欄「名片${zh}」`]);
    } catch (e) {
      if (!G.loggedIn()) throw e; // 登入失效：整個停下來，重新登入後再按一次
      photoLines.push(["bad", `${zh}照片沒存成功，所以聯絡人裡沒有「名片${zh}」的連結：${G.explain(e)}`]);
    }
  }
  if (!S.photos.front && !S.photos.back) photoLines.push(["", "這一張沒有拍照。"]);
  return { photoLinks, photoLines };
}

function finish(title, lines, undo = null) {
  busy("");
  setPhoto("front", null);
  setPhoto("back", null);
  S.pendingCard = null;
  S.upd = null;
  S.lastUpdate = undo;
  $("done-title").textContent = title;
  $("done-box").innerHTML = lines.map(([k, t]) => `<div class="result-line ${k}">${esc(t)}</div>`).join("");
  $("undo-box").hidden = !undo;
  $("m-undo").textContent = "";
  $("b-undo").disabled = false;
  view("done");
}

// ---------- 更新現有那一筆（只補缺的、不覆蓋） ----------

async function startUpdate(rn) {
  busy("讀取那一筆的完整資料…");
  try {
    const person = await G.getPerson(rn);
    S.upd = { rn, person, choices: {}, plan: M.plan_update({ ...S.pendingCard, photoLinks: pendingPhotoLinks() }, person) };
    $("m-upd").textContent = "";
    renderUpd();
    view("upd");
  } catch (e) {
    showError("m-dup", e);
  } finally {
    busy("");
  }
}

function renderUpd() {
  const { plan, choices } = S.upd;
  $("upd-who").textContent = plan.existing || "（沒有姓名）";
  const adds = [...plan.adds.map((a) => `補上${a.label}：${a.text}`), ...plan.fills.map((f) => `補上${f.label}：${f.text}`)];
  $("upd-adds").innerHTML = adds.length
    ? adds.map((t) => `<div class="result-line ok">${esc(t)}</div>`).join("")
    : '<div class="sub">名片上的資料，這一筆都已經有了，沒有東西需要補。</div>';
  $("upd-conf-box").hidden = !plan.conflicts.length;
  $("upd-conf").innerHTML = plan.conflicts.map((c) => `<div class="conf"><div class="why">${esc(c.label)}不一樣</div>${
    c.options.map((o) => `<button type="button" data-conf="${esc(c.id)}" data-pick="${o.key}" class="${(choices[c.id] || "keep") === o.key ? "on" : ""}">${esc(o.text)}</button>`).join("")
  }</div>`).join("");
  for (const b of $("upd-conf").querySelectorAll("button")) {
    b.addEventListener("click", () => {
      S.upd.choices[b.dataset.conf] = b.dataset.pick;
      renderUpd();
    });
  }
  $("upd-notes-box").hidden = !plan.notes.length;
  $("upd-notes").innerHTML = plan.notes.map((t) => `<div class="result-line warn">${esc(t)}</div>`).join("");
  $("b-upd-go").disabled = !M.has_changes(plan, choices);
}

async function applyUpdate() {
  const u = S.upd;
  const card = S.pendingCard;
  const msg = $("m-upd");
  msg.className = "msg";
  msg.textContent = "";
  let wrote = false;
  const lines = [];
  try {
    busy("準備中…");
    const { photoLinks, photoLines } = await uploadPhotos(u.plan.existing || "聯絡人");

    // 規則文件 13 的教訓 8：寫入前重新讀取，和剛才給他看的不一樣就停下來
    busy("重新讀取那一筆，確認沒有被改過…");
    const now = await G.getPerson(u.rn);
    const diff = W.changed_fields(now, u.person, M.APP_CHECK);
    if (diff.length) {
      u.person = now;
      u.choices = {};
      u.plan = M.plan_update({ ...card, photoLinks: pendingPhotoLinks() }, now);
      renderUpd();
      busy("");
      msg.className = "msg warn";
      msg.textContent = `這一筆在您查看之後被改過（${diff.map((f) => M.FIELD_LABEL[f] || f).join("、")}），所以這次沒有寫入。上面已經照最新的內容重新比對，請再看一次，沒問題再按「確定更新」。`;
      return;
    }
    const plan = M.plan_update({ ...card, photoLinks }, now);
    const [mask, body] = M.apply_plan(now, plan, u.choices);
    if (!mask.length) {
      busy("");
      msg.className = "msg warn";
      msg.textContent = "沒有東西需要更新（照片沒存成功的話，連結也不會加）。";
      return;
    }
    // 修改前先存檔（只存會被改到的欄位和姓名，不存備註）；存不成功就不可以寫入
    const snap = { resourceName: now.resourceName, names: now.names };
    for (const f of M.APP_MASK) if (now[f]) snap[f] = now[f];
    const t = new Date();
    const run = t.toISOString().replace(/[-:T]/g, "").slice(0, 14);
    try {
      W.save_snapshot(localStorage, snap, run);
      W.prune_snapshots(localStorage, 20);
    } catch (e) {
      throw new G.UserError("這支手機沒辦法存「修改前的樣子」（可能是無痕模式或儲存空間滿了），為了安全，這次不更新。");
    }

    busy("更新聯絡人…");
    await G.updateContact(u.rn, mask, body);
    wrote = true;
    lines.push(["ok", `已更新「${plan.existing}」`]);
    for (const t2 of M.describe_changes(plan, u.choices)) lines.push(["", "・" + t2]);
    keep({ draft: null, lastCategory: card.category || store().lastCategory || "" });

    try {
      const got = await G.getPerson(u.rn);
      const probs = W.verify(got, now, mask, body, ["memberships"], M.APP_CHECK);
      if (probs.length) {
        lines.push(["warn", "更新之後讀回來核對，有地方和預期不一樣，請把這個畫面截圖給 Claude："]);
        for (const p of probs) lines.push(["", "・" + p.replace(/^(\w+)/, (f) => M.FIELD_LABEL[f] || f)]);
      } else {
        lines.push(["ok", "讀回來核對過：補的都在，姓名、備註和其他內容都沒有變"]);
      }
    } catch (e) {
      lines.push(["warn", "已更新，但讀回來核對時出錯：" + G.explain(e)]);
    }
    lines.push(...photoLines);
    for (const n of plan.notes) lines.push(["warn", n]);
    finish("更新好了", lines, { rn: u.rn, name: plan.existing });
  } catch (e) {
    busy("");
    if (wrote) {
      lines.push(["warn", "已更新，但後續步驟出錯：" + G.explain(e)]);
      finish("更新好了", lines, { rn: u.rn, name: u.plan.existing });
      return;
    }
    showError("m-upd", e);
  }
}

/** 復原剛才那次更新：把改過的欄位整欄換回更新前的樣子（用更新前存的檔）。 */
async function undoUpdate() {
  const msg = $("m-undo");
  const last = S.lastUpdate;
  if (!last) return;
  $("b-undo").disabled = true;
  busy("復原中…");
  try {
    const [, snap] = W.latest_snapshot(localStorage, last.rn);
    if (!snap) throw new G.UserError("找不到更新前的存檔，沒辦法復原。");
    const now = await G.getPerson(last.rn);
    const [mask, body] = W.build_restore(now, snap, M.APP_MASK);
    if (mask.length) await G.updateContact(last.rn, mask, body);
    const got = await G.getPerson(last.rn);
    const left = W.changed_fields(got, snap, M.APP_MASK);
    busy("");
    if (left.length) {
      msg.className = "msg warn";
      msg.textContent = `復原之後還有地方和更新前不一樣（${left.map((f) => M.FIELD_LABEL[f] || f).join("、")}），請把這個畫面截圖給 Claude。`;
    } else {
      msg.className = "msg ok";
      msg.textContent = `已復原「${last.name}」，和更新前一樣了。已經存到雲端硬碟的照片還在，不需要的話請自己刪。`;
      S.lastUpdate = null;
    }
  } catch (e) {
    busy("");
    $("b-undo").disabled = false;
    showError("m-undo", e);
  }
}

/** 新增一筆聯絡人：找標籤 → 寫入 → 讀回核對 → 存照片。寫入成功後，後面的步驟失敗也不會重寫一次。 */
async function writeNew(card, msgId) {
  let made = null;
  const lines = [];
  try {
    busy("準備中…");
    let groups = [];
    let labelNote = "";
    const wanted = card.mode === "category" ? [card.category] : [...S.plainLabels];
    const created = [];
    for (const name of wanted) {
      const l = ensureLabel(name);
      if (!l.resourceName) {
        l.resourceName = (await G.createLabel(name)).resourceName;
        created.push(name);
      }
      groups.push(l.resourceName);
    }
    labelNote = wanted.length ? `標籤：${wanted.join("、")}` : "沒有掛標籤";
    if (created.length) labelNote += `（「${created.join("」「")}」是新標籤，已新增）`;
    // 先把照片存到雲端硬碟，拿到連結，再和聯絡人一起寫入（網站欄的「名片正面／反面」）。
    const whole = card.mode === "plain" ? card.name : R.compose(card.category, card.name, card.third);
    const { photoLinks, photoLines } = await uploadPhotos(whole);

    busy("存入聯絡人…");
    const { body } = GC.build_person({ ...card, groupResourceNames: groups, photoLinks });
    made = await G.createContact(body);
    lines.push(["ok", `已存入「${whole}」`], ["", labelNote]);
    keep({ draft: null, lastCategory: card.category || store().lastCategory || "" });

    // 讀回來核對（規則文件 14）
    try {
      const got = await G.getPerson(made.resourceName);
      const probs = GC.verify_created(body, got);
      if (probs.length) {
        lines.push(["warn", "存進去之後讀回來核對，有地方和預期不一樣，請把這個畫面截圖給 Claude："]);
        for (const p of probs) lines.push(["", "・" + p]);
      } else {
        lines.push(["ok", "讀回來核對過，內容和格式都正確"]);
      }
    } catch (e) {
      lines.push(["warn", "聯絡人已存入，但讀回來核對時出錯：" + G.explain(e)]);
    }
    lines.push(...photoLines);
  } catch (e) {
    busy("");
    if (!made) {
      showError(msgId, e);
      if (msgId === "m-dup") return;
      view("form");
      return;
    }
    lines.push(["warn", "聯絡人已存入，但後續步驟出錯：" + G.explain(e)]);
  }
  finish("存好了", lines);
}

/** source："camera"（直接開相機）、"gallery"（從相簿選）、""（不拍照）。 */
function startCard(source) {
  openForm(null);
  $("photo-menu").hidden = true;
  if (source === "camera") $("f-front").click(); // 要在點擊動作裡直接開，才不會被瀏覽器擋掉
  if (source === "gallery") $("f-front-pick").click();
}

// ---------- 啟動 ----------

async function main() {
  G = await import(demo ? "./google_mock.js" : "./google.js");
  $("demo-banner").hidden = !demo;
  $("set-ver").textContent = $("login-ver").textContent = CONFIG.VERSION + (demo ? "（示範）" : "");

  const doLogin = async (other) => {
    const msg = $("m-login");
    try {
      const p = G.login({ other }); // 直接在點擊裡呼叫
      msg.className = "msg";
      msg.textContent = "已開啟登入視窗，請在視窗裡完成登入…";
      await p;
      msg.textContent = "";
      await afterLogin();
    } catch (e) {
      showLogin();
      showError("m-login", e);
      msg.querySelector("button")?.remove(); // 登入頁本身就有登入按鈕
    }
  };
  $("b-login").addEventListener("click", () => doLogin(false));
  $("b-login-other").addEventListener("click", () => doLogin(true));

  for (const b of document.querySelectorAll("[data-mode]")) {
    b.addEventListener("click", () => {
      S.mode = b.dataset.mode;
      keep({ mode: S.mode });
      goHome();
    });
  }
  for (const b of document.querySelectorAll("[data-setmode]")) {
    b.addEventListener("click", () => {
      S.mode = b.dataset.setmode;
      keep({ mode: S.mode, draft: null });
      goHome();
    });
  }

  $("b-shoot").addEventListener("click", () => startCard("camera"));
  $("b-pick").addEventListener("click", () => startCard("gallery"));
  $("b-manual").addEventListener("click", () => startCard(""));
  $("b-resume").addEventListener("click", () => openForm(store().draft));
  $("b-discard").addEventListener("click", () => {
    keep({ draft: null });
    goHome();
  });
  $("b-home").addEventListener("click", goHome);
  $("b-settings").addEventListener("click", () => {
    $("set-acct").textContent = G.account();
    $("set-mode-now").textContent = S.mode === "category" ? "類別模式" : "一般模式";
    for (const b of document.querySelectorAll("[data-setmode]")) b.classList.toggle("second", b.dataset.setmode !== S.mode);
    view("settings");
  });
  $("b-home-settings").addEventListener("click", () => $("b-settings").click());
  $("b-logout").addEventListener("click", () => {
    G.logout();
    ACCT = "";
    showLogin();
  });

  $("b-new-label").addEventListener("click", addNewLabel);
  $("i-new-label").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addNewLabel();
  });
  $("r-front").addEventListener("click", () => rotatePhoto("front"));
  $("r-back").addEventListener("click", () => rotatePhoto("back"));
  $("p-front").addEventListener("click", () => openPhotoMenu("front"));
  $("p-back").addEventListener("click", () => openPhotoMenu("back"));
  $("pm-camera").addEventListener("click", () => {
    $("photo-menu").hidden = true;
    $("f-" + $("photo-menu").dataset.side).click();
  });
  $("pm-gallery").addEventListener("click", () => {
    $("photo-menu").hidden = true;
    $("f-" + $("photo-menu").dataset.side + "-pick").click();
  });
  $("pm-remove").addEventListener("click", () => {
    $("photo-menu").hidden = true;
    setPhoto($("photo-menu").dataset.side, null);
  });
  $("pm-cancel").addEventListener("click", () => ($("photo-menu").hidden = true));
  for (const side of ["front", "back"]) {
    $("f-" + side).addEventListener("change", () => onPhotoPicked(side, "f-" + side));
    $("f-" + side + "-pick").addEventListener("change", () => onPhotoPicked(side, "f-" + side + "-pick"));
  }

  $("i-cat").addEventListener("change", () => {
    if ($("i-cat").value === "__new__") {
      $("i-cat").value = "";
      showNewLabel(true);
    } else {
      showNewLabel(false);
    }
    $("i-cat").classList.remove("bad");
    refreshThird();
    refreshPreview();
    saveDraft();
  });
  $("i-name").addEventListener("input", () => {
    $("n-name").textContent = "";
    $("i-name").classList.remove("bad");
    refreshPreview();
    saveDraft();
  });
  $("i-third").addEventListener("input", () => {
    S.thirdTouched = true;
    refreshThird();
    refreshPreview();
    saveDraft();
  });
  for (const id of ["i-company", "i-title"]) {
    $(id).addEventListener("input", () => {
      refreshThird();
      refreshPreview();
      saveDraft();
    });
  }
  for (const id of ["i-dept", "i-zip", "i-en", "i-tax", "i-web", "i-note", "i-addr"]) $(id).addEventListener("input", saveDraft);
  for (const id of ["i-addr", "i-zip"]) {
    $(id).addEventListener("blur", () => {
      tidyAddress();
      saveDraft();
    });
  }
  for (const id of ["i-web", "i-en"]) $(id).addEventListener("blur", () => ($(id).value = toHalf($(id).value).trim()));
  $("i-tax").addEventListener("blur", () => {
    $("i-tax").value = cn_digits(toHalf($("i-tax").value)).trim();
    saveDraft();
  });
  $("b-add-phone").addEventListener("click", () => phoneRow("手機", "").querySelector("input").focus());
  $("b-add-email").addEventListener("click", () => emailRow("").querySelector("input").focus());

  $("b-save").addEventListener("click", onSave);
  $("b-cancel").addEventListener("click", () => {
    saveDraft();
    goHome();
  });
  $("b-dup-new").addEventListener("click", () => writeNew(S.pendingCard, "m-dup"));
  $("b-dup-back").addEventListener("click", () => view("form"));
  $("b-upd-go").addEventListener("click", applyUpdate);
  $("b-upd-back").addEventListener("click", () => view("dup"));
  $("b-undo").addEventListener("click", undoUpdate);
  $("b-next").addEventListener("click", () => startCard("camera"));
  $("b-done-home").addEventListener("click", goHome);

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (demo) {
    await G.login();
    await afterLogin();
  } else if (G.restore()) {
    // 一小時內關掉再開：用手機裡暫存的通行證，不用重新登入
    try {
      await afterLogin();
    } catch (e) {
      showLogin();
      showError("m-login", e);
      $("m-login").querySelector("button")?.remove();
    }
  } else {
    showLogin();
  }
}

main().catch((e) => {
  document.querySelector("main").insertAdjacentHTML("afterbegin", `<div class="card msg bad">App 啟動失敗：${esc(e?.message || e)}</div>`);
});

// 雋品名片：正式畫面的動作。
// 流程：登入 →（第一次選姓名模式）→ 首頁 → 拍照／輸入 → 表單（每格可改、即時預覽整串）→ 查重 → 存入 → 完成。
// 規則都在 rules.js、address.js、gcontact.js、dedupe.js（有自動測試）；這個檔只管畫面。
// 「辨識」：拍好或選好照片就自動送去後台辨識（後台還沒放金鑰時不會送，維持手動輸入）。
// 辨識結果只填空著的格子；整理成表單內容的規則在 recognize.js、裁切位置的計算在 cardimg.js（都有自動測試）。
import { CONFIG } from "../config.js";
import * as CI from "./cardimg.js";
import { cn_digits, to_half } from "./cnnum.js";
import * as D from "./dedupe.js";
import * as GC from "./gcontact.js";
import * as L from "./labels.js";
import * as M from "./merge.js";
import * as REC from "./recognize.js";
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
  // 照片：{ file（手機給的原檔）, raw（縮小後、沒裁過的圖）, orig（目前用的底圖：raw 或自動裁好的）, turns（順時針轉了幾次 90°）,
  //         blob（要存的圖）, url, auto（自動裁切的結果 { orig, turns }，沒有就是沒裁）, useAuto（現在用的是不是自動裁好的） }
  photos: { front: null, back: null },
  recog: null, // 後台的辨識功能準備好了沒（Promise："ready"、"nokey"、"old"、"unknown"）
  rec: { front: null, back: null }, // 各面的辨識結果說明：[[種類, 文字, 動作?], …]
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
  checkRecognize();
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
  $("home-acct").textContent = "登入帳號：" + G.account();
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
  $("a-" + side).hidden = !photo?.auto;
  $("a-" + side).textContent = photo?.useAuto ? "用原圖" : "用裁切後的";
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
  setPhoto(side, { ...ph, uploaded: undefined, turns, blob, url: URL.createObjectURL(blob) });
}

/** 在「自動裁切、轉正後的照片」和「原圖」之間切換。 */
async function toggleAuto(side) {
  const ph = S.photos[side];
  if (!ph?.auto) return;
  const useAuto = !ph.useAuto;
  const orig = useAuto ? ph.auto.orig : ph.raw;
  const turns = useAuto ? ph.auto.turns : 0;
  const blob = await turned(orig, turns);
  setPhoto(side, { ...ph, uploaded: undefined, orig, turns, blob, useAuto, url: URL.createObjectURL(blob) });
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
  setPhoto(side, { file, raw: blob, orig: blob, turns: 0, blob, url: URL.createObjectURL(blob) });
  S.rec[side] = null;
  renderRec();
  await autoRecognize(side);
}

// ---------- 辨識 ----------

/** 登入後在背景問一次後台：辨識功能準備好了沒。 */
function checkRecognize() {
  S.recog = G.ping().then((p) => (p.recognize ? (p.hasKey ? "ready" : "nokey") : "old"), () => "unknown");
  S.recog.then(renderPhotoHint);
}

function renderPhotoHint(st) {
  const keep = "照片會在存入時存到您的雲端硬碟，並在聯絡人的「網站」欄留一個連結，之後點連結就能看原本的名片。";
  $("photo-hint").textContent = "點格子可以拍照、從相簿選，或移除。" + (st === "ready"
    ? "拍好或選好後會自動辨識（照片會送到 Claude），把讀到的內容填進下面空著的格子，請逐格核對。" + keep
    : "辨識功能還沒開通，現在請先自己輸入。" + keep);
}

async function loadImg(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((ok, no) => {
      img.onload = ok;
      img.onerror = no;
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}
const toJpeg = (canvas, q) => new Promise((ok) => canvas.toBlob(ok, "image/jpeg", q));
const toBase64 = (blob) => new Promise((ok, no) => {
  const fr = new FileReader();
  fr.onload = () => ok(String(fr.result).split(",")[1] || "");
  fr.onerror = no;
  fr.readAsDataURL(blob);
});

/**
 * 準備送去辨識的圖：JPEG，大小在 Claude 不會再縮小的範圍內（這樣它回報的名片位置才對得回來）。
 * 回傳 { image（base64）, width, height }。
 */
async function imageForRecognize(blob) {
  let img;
  try {
    img = await loadImg(blob);
  } catch {
    throw new G.UserError("這張照片手機讀不了，請重拍一張，或自己輸入。");
  }
  const [w, h] = CI.resized_size(img.naturalWidth, img.naturalHeight);
  let out = blob;
  if (w !== img.naturalWidth || h !== img.naturalHeight || blob.type !== "image/jpeg") {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    out = await toJpeg(c, 0.85);
    if (!out) throw new G.UserError("這張照片手機處理不了，請重拍一張，或自己輸入。");
  }
  return { image: await toBase64(out), width: w, height: h };
}

/** 照比例裁出名片的範圍。從手機給的原檔裁（畫質最好），長邊縮到 2000 以內。 */
async function cropped(file, crop) {
  const img = await loadImg(file);
  const sx = Math.round(crop.x * img.naturalWidth);
  const sy = Math.round(crop.y * img.naturalHeight);
  const sw = Math.max(1, Math.round(crop.w * img.naturalWidth));
  const sh = Math.max(1, Math.round(crop.h * img.naturalHeight));
  const scale = Math.min(1, 2000 / Math.max(sw, sh));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(sw * scale));
  c.height = Math.max(1, Math.round(sh * scale));
  c.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return toJpeg(c, 0.9);
}

/** 依辨識回報的名片位置自動裁切、轉正。裁不了就維持原圖。回傳說明文字（沒有動就是空字串）。 */
async function applyCrop(side, card, sent) {
  const ph = S.photos[side];
  const plan = CI.crop_plan(card.box, card.rotate, { w: sent.width, h: sent.height });
  if (!plan.crop && !plan.turns) return "";
  try {
    const base = plan.crop ? await cropped(ph.file, plan.crop) : ph.raw;
    if (!base) return "";
    const blob = await turned(base, plan.turns);
    setPhoto(side, { file: ph.file, raw: ph.raw, orig: base, turns: plan.turns, blob, url: URL.createObjectURL(blob), auto: { orig: base, turns: plan.turns }, useAuto: true });
    return `照片已自動${[plan.crop ? "裁切" : "", plan.turns ? "轉正" : ""].filter(Boolean).join("、")}。不滿意可以按照片下面的「用原圖」。`;
  } catch {
    return "";
  }
}

const ID_OF = { name: "i-name", company: "i-company", department: "i-dept", title: "i-title", address: "i-addr", zip: "i-zip", englishName: "i-en", taxId: "i-tax", website: "i-web" };

/** 把辨識結果填進表單（只填空著的格子），回傳要顯示的說明。 */
function applyRecognized(side, card) {
  const now = collect();
  const plan = REC.fill_plan({ ...now, address: now.address.text, zip: now.address.zip }, card, side);
  const lines = [];
  const touched = new Set(); // 這次有填東西的欄位
  for (const [key, value] of Object.entries(plan.set)) {
    $(ID_OF[key]).value = value;
    touched.add(key);
  }
  const addedPhones = [];
  for (const p of plan.phones) {
    const rows = [...$("phones").children].filter((r) => !r.querySelector("input").value.trim());
    const row = rows.find((r) => r.querySelector("select").value === p.kind) || rows[0] || phoneRow(p.kind, "");
    row.querySelector("select").value = p.kind;
    row.querySelector("input").value = p.value;
    addedPhones.push(row);
  }
  const addedEmails = [];
  for (const e of plan.emails) {
    const row = [...$("emails").children].find((r) => !r.querySelector("input").value.trim()) || emailRow("");
    row.querySelector("input").value = e;
    addedEmails.push(row);
  }
  if (addedPhones.length) touched.add("phones");
  if (addedEmails.length) touched.add("emails");

  // 照原本那套規則整理格式（和自己打字時一樣）
  for (const row of $("phones").children) tidyPhone(row);
  for (const row of $("emails").children) tidyEmail(row);
  tidyAddress();
  $("i-tax").value = cn_digits(toHalf($("i-tax").value)).trim();
  for (const id of ["i-web", "i-en"]) $(id).value = toHalf($(id).value).trim();
  if (["englishName", "taxId", "website"].some((k) => touched.has(k))) $("more").open = true;
  $("n-name").textContent = "";
  $("i-name").classList.remove("bad");
  refreshThird();
  refreshPreview();
  saveDraft();

  // 要請使用者特別核對的格子標黃色：Claude 自己說沒把握的，以及程式看到可能是簡體字或亂碼的
  const doubt = new Set([...card.unsure, ...card.flags.map((f) => f.field)].filter((k) => touched.has(k)));
  for (const key of doubt) {
    if (key === "phones") for (const row of addedPhones) row.querySelector("input").classList.add("check");
    else if (key === "emails") for (const row of addedEmails) row.querySelector("input").classList.add("check");
    else $(ID_OF[key]).classList.add("check");
  }

  const n = touched.size;
  lines.push(n ? ["ok", `填了 ${Object.keys(plan.set).length + addedPhones.length + addedEmails.length} 格，請逐格核對。`] : ["", "讀到的內容表單裡都已經有了，沒有更動。"]);
  const sure = card.unsure.filter((k) => touched.has(k)).map((k) => REC.FIELD_LABEL[k]);
  if (sure.length) lines.push(["warn", `辨識時沒把握，已標黃色，請特別核對：${sure.join("、")}`]);
  const blank = card.unsure.filter((k) => !touched.has(k) && !plan.skipped.some((x) => x.field === k) && (k === "phones" ? !card.phones.length : k === "emails" ? !card.emails.length : !card[k])).map((k) => REC.FIELD_LABEL[k]);
  if (blank.length) lines.push(["warn", `看不清楚，所以沒有填：${blank.join("、")}`]);
  for (const f of card.flags) if (touched.has(f.field)) lines.push(["warn", f.text + "，請核對。"]);
  if (plan.skipped.length) lines.push(["", `這些格子已經有內容，沒有更動：${plan.skipped.map((x) => `${x.label}（名片上讀到「${x.value}」）`).join("；")}`]);
  if (card.other.length) {
    lines.push(["", `名片上還有這些，沒有對應的格子：${card.other.join("；")}`, { text: "加到備註", run: () => {
      const note = $("i-note");
      note.value = [note.value.trim(), ...card.other.filter((o) => !note.value.includes(o))].filter(Boolean).join("\n");
      $("more").open = true;
      saveDraft();
    } }]);
  }
  return lines;
}

function renderRec() {
  const box = $("rec-lines");
  box.innerHTML = "";
  let any = false;
  for (const [side, zh] of [["front", "正面"], ["back", "反面"]]) {
    const lines = S.rec[side];
    if (!lines) continue;
    any = true;
    const head = document.createElement("div");
    head.className = "side";
    head.textContent = `${zh}的辨識結果`;
    box.append(head);
    for (const [kind, text, action] of lines) {
      const d = document.createElement("div");
      d.className = "result-line " + kind;
      d.textContent = text;
      if (action) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "second";
        b.textContent = action.text;
        b.addEventListener("click", () => {
          action.run();
          b.disabled = true;
          b.textContent = "已" + action.text;
        });
        d.append(b);
      }
      box.append(d);
    }
  }
  $("rec-box").hidden = !any;
  $("b-rec-again").hidden = !(S.photos.front || S.photos.back);
}

/** 辨識這一面的照片，把讀到的內容填進空著的格子，並自動裁切、轉正。後台還沒開通就什麼都不做。 */
async function autoRecognize(side) {
  const ph = S.photos[side];
  if (!ph) return;
  let st = await S.recog;
  if (st === "unknown") {
    checkRecognize(); // 剛才沒問到（多半是網路），再問一次
    st = await S.recog;
  }
  if (st !== "ready") {
    if (st === "unknown") {
      S.rec[side] = [["warn", "現在連不上辨識功能（可能是網路不穩）。請先自己輸入，或稍後按「再辨識一次」。"]];
      renderRec();
    } else {
      checkRecognize(); // 後台還沒開通：在背景再問一次，開通之後下一張照片就會自動辨識
    }
    return;
  }
  busy(`辨識名片${side === "front" ? "正面" : "反面"}中…`);
  const t0 = Date.now();
  try {
    const sent = await imageForRecognize(ph.raw);
    const res = await G.recognize({ ...sent, side });
    if (S.photos[side] !== ph) return; // 等的時候照片被換掉了
    const card = REC.clean_result(res.result);
    let lines;
    if (!card.found) {
      lines = [["warn", "這張照片裡沒有找到名片。請重拍一張（點照片格子），或自己輸入。"]];
    } else {
      const cropNote = await applyCrop(side, card, sent);
      lines = REC.has_content(card) ? applyRecognized(side, card) : [["warn", "名片上的字讀不出來。請重拍一張清楚一點的，或自己輸入。"]];
      if (cropNote) lines.push(["", cropNote]);
    }
    // 測試期間用（2026-11-24 使用者同意）：顯示這次等了幾秒、用量多少，方便估算每張的花費。測試結束後拿掉。
    lines.push(["stat", REC.stat_line(Date.now() - t0, res)]);
    S.rec[side] = lines;
  } catch (e) {
    S.rec[side] = [["bad", G.explain(e)]];
    if (!G.loggedIn()) showError("m-form", e); // 登入失效：下面出現「重新登入」按鈕
  } finally {
    busy("");
    renderRec();
  }
}

async function recognizeAgain() {
  for (const side of ["front", "back"]) if (S.photos[side]) await autoRecognize(side);
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
  S.rec = { front: null, back: null };
  renderRec();
  $("more").open = Boolean(d.englishName || d.taxId || d.website || d.note);
  for (const id of ["n-name", "n-addr", "m-form"]) $(id).textContent = "";
  for (const el of document.querySelectorAll("#v-form .warn, #v-form .bad, #v-form .check")) if (el.tagName !== "DIV") el.classList.remove("warn", "bad", "check");
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
  // 辨識時沒把握、使用者還沒動過的格子（黃色）也算
  for (const el of document.querySelectorAll("#v-form input.check, #v-form textarea.check")) warns.push(`核對:${el.value}`);
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
    msg.textContent = `有 ${warns.length} 格標了黃色（程式看不懂，或辨識時沒把握的內容），請看一下。確定沒問題的話，再按一次「存入聯絡人」，會照目前的內容存。`;
    document.querySelector("#v-form input.warn, #v-form input.check")?.scrollIntoView({ block: "center" });
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
  $("foot-ver").textContent = CONFIG.VERSION + (demo ? "（示範）" : "");

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
  $("a-front").addEventListener("click", () => toggleAuto("front"));
  $("a-back").addEventListener("click", () => toggleAuto("back"));
  $("b-rec-again").addEventListener("click", recognizeAgain);
  $("v-form").addEventListener("input", (e) => e.target.classList?.remove("check")); // 改過的格子就不再標「請核對」
  renderPhotoHint("");
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
    S.rec[$("photo-menu").dataset.side] = null;
    renderRec();
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

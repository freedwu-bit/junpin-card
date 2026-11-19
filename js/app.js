// 雋品名片：正式畫面的動作。
// 流程：登入 →（第一次選姓名模式）→ 首頁 → 拍照／輸入 → 表單（每格可改、即時預覽整串）→ 查重 → 存入 → 完成。
// 規則都在 rules.js、address.js、gcontact.js、dedupe.js（有自動測試）；這個檔只管畫面。
// 「辨識」還沒接上（等 Claude 額度），現在是手動輸入。
import { CONFIG } from "../config.js";
import * as D from "./dedupe.js";
import * as GC from "./gcontact.js";
import * as R from "./rules.js";

const demo = new URLSearchParams(location.search).has("demo");
const LS_KEY = demo ? "junpin-card-demo" : "junpin-card";
const TRASH_LABEL = "_待刪除";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let G; // 連 Google 的那一層（正式：google.js；示範模式：google_mock.js）
const S = {
  mode: "", // "category"（類別模式）或 "plain"（一般模式）
  labels: [], // 使用者現有的標籤
  photos: { front: null, back: null }, // { blob, url }
  thirdTouched: false, // 使用者自己改過第三段，就不再自動帶入建議
  plainLabels: new Set(), // 一般模式點選的標籤
  warnSeen: "", // 已經提醒過的黃色警告（同樣的警告不重複擋）
  pendingCard: null, // 查重畫面上等待決定的那一張
};

// ---------- 小工具 ----------

function store() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    return {};
  }
}
function keep(patch) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...store(), ...patch }));
  } catch {
    /* 存不了（例如無痕模式）不影響使用，只是不會記住 */
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

/** 全形數字與符號轉半形（名片辨識、手機輸入法常見）。 */
function toHalf(s) {
  return (s || "").replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, " ");
}

// ---------- 登入與開場 ----------

async function loadLabels() {
  S.labels = await G.listLabels();
}

async function afterLogin() {
  busy("讀取您的標籤…");
  try {
    await loadLabels();
  } finally {
    busy("");
  }
  S.mode = store().mode || "";
  if (!S.mode) view("mode");
  else goHome();
}

function goHome() {
  $("home-acct").textContent = "登入帳號：" + G.account() + "　｜　" + (S.mode === "category" ? "類別模式" : "一般模式") + "　｜　版本：" + CONFIG.VERSION;
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
  if (!raw) {
    input.value = "";
    return "";
  }
  const r = GC.prepare_phone(raw, sel.value);
  if (r.ok) {
    input.value = r.value;
    const kind = { mobile: "手機", work: "公司", workFax: "傳真" }[r.type];
    if (kind && kind !== sel.value) {
      sel.value = kind;
      note.textContent = `09 開頭是手機，已改成「${kind}」。`;
    }
    return "";
  }
  input.value = raw;
  input.classList.add("warn");
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
  const a = GC.prepare_address(raw, $("i-zip").value);
  if (a.ok) {
    input.value = a.text;
    if (a.zip && !$("i-zip").value.trim()) $("i-zip").value = a.zip;
    return "";
  }
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
    const picked = S.labels.filter((l) => S.plainLabels.has(l.resourceName)).map((l) => l.name);
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
  const usable = S.labels.filter((l) => !l.name.startsWith("_"));
  if (!usable.length) box.innerHTML = '<span class="sub">您的通訊錄還沒有自己建的標籤。</span>';
  for (const l of usable) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (S.plainLabels.has(l.resourceName) ? " on" : "");
    b.textContent = l.name;
    b.addEventListener("click", () => {
      if (S.plainLabels.has(l.resourceName)) S.plainLabels.delete(l.resourceName);
      else S.plainLabels.add(l.resourceName);
      b.classList.toggle("on");
      refreshPreview();
      saveDraft();
    });
    box.append(b);
  }
}

function setPhoto(side, photo) {
  if (S.photos[side]?.url) URL.revokeObjectURL(S.photos[side].url);
  S.photos[side] = photo;
  const tile = $("p-" + side);
  tile.classList.toggle("has", Boolean(photo));
  tile.style.backgroundImage = photo ? `url(${photo.url})` : "";
  tile.textContent = photo ? (side === "front" ? "正面（點一下重拍）" : "反面（點一下重拍）") : side === "front" ? "＋拍正面" : "＋拍反面（選填）";
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

async function onPhotoPicked(side) {
  const input = $("f-" + side);
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  const blob = await shrink(file);
  setPhoto(side, { blob, url: URL.createObjectURL(blob) });
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
  $("i-cat").innerHTML = '<option value="">（請選擇）</option>' + R.COMPANY_CATEGORIES.map((c) => `<option>${c}</option>`).join("");
  $("i-cat").value = d.category || store().lastCategory || "";
  for (const [id, key] of Object.entries(SIMPLE)) $(id).value = d[key] || "";
  S.thirdTouched = Boolean(d.thirdTouched);
  S.plainLabels = new Set((d.plainLabels || []).filter((rn) => S.labels.some((l) => l.resourceName === rn)));
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
      <button class="second" disabled style="margin-top:10px">更新這一筆（下一版才有）</button>
    </div>`;
  }).join("");
}

/** 新增一筆聯絡人：找標籤 → 寫入 → 讀回核對 → 存照片。寫入成功後，後面的步驟失敗也不會重寫一次。 */
async function writeNew(card, msgId) {
  let made = null;
  const lines = [];
  try {
    busy("準備中…");
    let groups = [];
    let labelNote = "";
    if (card.mode === "category") {
      let label = S.labels.find((l) => l.name === card.category);
      if (!label) {
        label = await G.createLabel(card.category);
        S.labels.push(label);
        labelNote = "（這個標籤原本沒有，已新增）";
      }
      groups = [label.resourceName];
      labelNote = `標籤：${card.category}${labelNote}`;
    } else {
      groups = [...S.plainLabels];
      const names = S.labels.filter((l) => S.plainLabels.has(l.resourceName)).map((l) => l.name);
      labelNote = names.length ? `標籤：${names.join("、")}` : "沒有掛標籤";
    }
    // 先把照片存到雲端硬碟，拿到連結，再和聯絡人一起寫入（網站欄的「名片正面／反面」）。
    // 照片沒存成功也照樣存聯絡人，只是少了連結。存過的照片會記住，重試時不會重複上傳。
    const whole = card.mode === "plain" ? card.name : R.compose(card.category, card.name, card.third);
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const photoLinks = [];
    const photoLines = [];
    for (const [side, zh] of [["front", "正面"], ["back", "反面"]]) {
      const ph = S.photos[side];
      if (!ph) continue;
      const fileName = `${ymd}_${whole}_${zh}.jpg`;
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
  busy("");
  setPhoto("front", null);
  setPhoto("back", null);
  S.pendingCard = null;
  $("done-box").innerHTML = lines.map(([k, t]) => `<div class="result-line ${k}">${esc(t)}</div>`).join("");
  view("done");
}

function startCard(withCamera) {
  openForm(null);
  if (withCamera) $("f-front").click(); // 要在點擊動作裡直接開相機
}

// ---------- 啟動 ----------

async function main() {
  G = await import(demo ? "./google_mock.js" : "./google.js");
  $("demo-banner").hidden = !demo;
  $("set-ver").textContent = $("login-ver").textContent = CONFIG.VERSION + (demo ? "（示範）" : "");

  $("b-login").addEventListener("click", async () => {
    const msg = $("m-login");
    try {
      const p = G.login(); // 直接在點擊裡呼叫
      msg.className = "msg";
      msg.textContent = "已開啟登入視窗，請在視窗裡完成登入…";
      await p;
      msg.textContent = "";
      await afterLogin();
    } catch (e) {
      showError("m-login", e);
      if (!G.loggedIn()) msg.querySelector("button")?.remove(); // 登入頁本身就有登入按鈕
    }
  });

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

  $("b-shoot").addEventListener("click", () => startCard(true));
  $("b-manual").addEventListener("click", () => startCard(false));
  $("b-resume").addEventListener("click", () => openForm(store().draft));
  $("b-discard").addEventListener("click", () => {
    keep({ draft: null });
    goHome();
  });
  $("b-home").addEventListener("click", goHome);
  $("b-settings").addEventListener("click", () => {
    $("set-acct").textContent = G.account();
    for (const b of document.querySelectorAll("[data-setmode]")) b.classList.toggle("second", b.dataset.setmode !== S.mode);
    view("settings");
  });
  $("b-logout").addEventListener("click", () => {
    G.logout();
    view("login");
  });

  $("p-front").addEventListener("click", () => $("f-front").click());
  $("p-back").addEventListener("click", () => $("f-back").click());
  $("f-front").addEventListener("change", () => onPhotoPicked("front"));
  $("f-back").addEventListener("change", () => onPhotoPicked("back"));

  $("i-cat").addEventListener("change", () => {
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
  for (const id of ["i-tax", "i-web", "i-en"]) $(id).addEventListener("blur", () => ($(id).value = toHalf($(id).value).trim()));
  $("b-add-phone").addEventListener("click", () => phoneRow("手機", "").querySelector("input").focus());
  $("b-add-email").addEventListener("click", () => emailRow("").querySelector("input").focus());

  $("b-save").addEventListener("click", onSave);
  $("b-cancel").addEventListener("click", () => {
    saveDraft();
    goHome();
  });
  $("b-dup-new").addEventListener("click", () => writeNew(S.pendingCard, "m-dup"));
  $("b-dup-back").addEventListener("click", () => view("form"));
  $("b-next").addEventListener("click", () => startCard(true));
  $("b-done-home").addEventListener("click", goHome);

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (demo) {
    await G.login();
    await afterLogin();
  } else {
    view("login");
  }
}

main().catch((e) => {
  document.querySelector("main").insertAdjacentHTML("afterbegin", `<div class="card msg bad">App 啟動失敗：${esc(e?.message || e)}</div>`);
});

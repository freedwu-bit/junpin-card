// 把 Claude 的辨識結果整理成表單用的內容，並決定哪些格子要填（純計算，不碰畫面，可以自動測試）。
//
// 分工（需求報告 5.1）：Claude 只負責「讀出名片上寫什麼、分到哪一欄」（後台 Code.gs 的 RESULT_SCHEMA）；
// 電話、地址的格式整理仍然是表單原本那套固定規則（gcontact.prepare_phone／prepare_address），這個檔不做。
// 這個檔做的事：
// - clean_result：去掉空白與佔位文字、統編誤放進電話的拿掉、列出要請使用者特別核對的地方（沒把握的欄位、可能的簡體字）。
// - fill_plan：只填「目前空著」的格子，已經有內容的不動（使用者自己打的字不會被蓋掉）。
// - rotate_from_top：Claude 回報「字的頭頂朝照片哪一邊」→ 要轉幾度（2026-11-25：直接問「順時針轉幾度」它會答反）。
// - needs_recheck／recheck_plan：讀到的電話不合理時，用轉正後的照片再讀一次，挑出可以更正的號碼。
import { cn_digits, to_half } from "./cnnum.js";
import * as GC from "./gcontact.js";
import * as py from "./pyre.js";
import * as R from "./rules.js";

export const KINDS = ["手機", "公司", "傳真"];
/** 表單欄位（和 gcontact.build_person 的名片資料同名）→ 畫面上的名稱。 */
export const FIELD_LABEL = {
  name: "姓名", englishName: "英文姓名", company: "公司全名", department: "部門", title: "職稱",
  phones: "電話", emails: "Email", address: "地址", zip: "郵遞區號", taxId: "統一編號", website: "網站",
};
/** Claude 回傳的欄位名稱 → 表單欄位。 */
const API_KEY = { english_name: "englishName", tax_id: "taxId" };
const SIMPLE = ["name", "englishName", "company", "department", "title", "address", "zip", "taxId", "website"];

const text = (v) => (typeof v === "string" ? py.strip(v.replace(/\s+/g, " ")) : "");
const clean = (v) => {
  const s = text(v);
  return R.is_placeholder(s) ? "" : s;
};
const digits = (s) => py.sub(String.raw`\D`, "", s || "");

const TOP_TO_ROTATE = { 上: 0, 右: 270, 下: 180, 左: 90 };
/**
 * 名片上的字，頭頂朝向照片的哪一邊（上、右、下、左）→ 照片要順時針轉幾度字才是正的。
 * 例：頭頂朝右（要把頭往右歪才讀得正）→ 要逆時針轉 90°，也就是順時針 270°。認不得的回傳 null。
 */
export function rotate_from_top(top) {
  return typeof top === "string" && Object.hasOwn(TOP_TO_ROTATE, top) ? TOP_TO_ROTATE[top] : null;
}
const same = (a, b) => R.norm_text(a || "") === R.norm_text(b || "");

/** 一支電話用來比對「是不是同一支」的依據：整理得出來的用整理後的號碼＋分機，整理不出來的用純數字。 */
function phone_key(p) {
  const v = cn_digits(to_half(p.value || "")); // 國字、全形數字先轉成一般數字再比
  const r = R.normalize_phone(v, "", "公司");
  return (r.key || digits(v) || text(v)) + "," + (r.ext || "");
}

/**
 * 整理 Claude 回傳的內容。raw：後台回傳的 result。
 * 回傳 {
 *   found    照片裡有沒有名片
 *   name…website  各欄位的文字（沒有就是空字串）
 *   phones   [{ kind, value }]；emails [字串]
 *   other    名片上其他沒有欄位可放的資訊（只顯示給使用者看，不會自動寫進任何欄位）
 *   unsure   Claude 自己說沒把握的表單欄位（例如 ["name", "phones"]）
 *   flags    程式另外發現要請使用者看的地方：[{ field, text }]
 *   box, rotate  名片在照片裡的位置、要轉幾度（交給 cardimg.crop_plan）
 * }
 */
export function clean_result(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const card = {
    found: r.card_found === true,
    name: clean(r.name), englishName: clean(r.english_name), company: clean(r.company), department: clean(r.department),
    title: clean(r.title), address: clean(r.address), zip: text(r.zip), taxId: text(r.tax_id), website: text(r.website),
    phones: [], emails: [], other: [], unsure: [], flags: [],
    box: r.card_box && typeof r.card_box === "object" ? r.card_box : null,
    rotate: rotate_from_top(r.card_top) ?? r.rotate_clockwise, // 新版後台回報 card_top；舊版回報 rotate_clockwise
  };

  // 電話：種類只有三種；同一支重複的只留一個；和統編相同的 8 碼不是電話（規則文件 12.3 看過的錯）
  const seen = new Set();
  for (const p of Array.isArray(r.phones) ? r.phones : []) {
    const value = text(p?.value);
    if (!value) continue;
    const d = digits(cn_digits(to_half(value)));
    if (d.length === 8 && d === digits(cn_digits(to_half(card.taxId)))) continue;
    const kind = KINDS.includes(p?.kind) ? p.kind : "公司";
    const k = phone_key({ value });
    if (seen.has(k)) continue;
    seen.add(k);
    card.phones.push({ kind, value });
  }
  const mails = new Set();
  for (const e of Array.isArray(r.emails) ? r.emails : []) {
    const v = text(e).replace(/\s+/g, "");
    if (!v || mails.has(R.norm_email(v))) continue;
    mails.add(R.norm_email(v));
    card.emails.push(v);
  }
  card.other = (Array.isArray(r.other) ? r.other : []).map(text).filter(Boolean);

  const unsure = new Set();
  for (const u of Array.isArray(r.unsure) ? r.unsure : []) {
    const key = API_KEY[u] || u;
    if (key in FIELD_LABEL) unsure.add(key);
  }
  card.unsure = [...unsure];

  // 辨識常見的錯：繁體變簡體、亂碼（規則文件 12.3）。只提醒，不自動改。
  for (const key of ["name", "company", "department", "title", "address"]) {
    const simp = R.simplified_chars(card[key]);
    if (simp.length) card.flags.push({ field: key, text: `${FIELD_LABEL[key]}裡的「${simp.join("、")}」可能是簡體字或認錯的字` });
    const bad = R.looks_garbled(card[key]);
    if (bad) card.flags.push({ field: key, text: `${FIELD_LABEL[key]}${bad}，可能認錯了` });
  }
  return card;
}

/**
 * 決定辨識結果要填進表單的哪些格子。
 * current：表單目前的內容 { name, englishName, company, department, title, address, zip, taxId, website, phones: [{kind,value}], emails: [字串] }
 * card：clean_result 的結果。side："front"（正面）或 "back"（反面）。
 * 規則：只填目前空著的格子；已經有內容、而且和辨識結果不一樣的，不動，列在 skipped 讓使用者知道。
 * 回傳 {
 *   set       要填的單一欄位 { 欄位: 文字 }
 *   phones    要加的電話 [{ kind, value }]（表單裡已經有的同一支不加）
 *   emails    要加的 Email
 *   skipped   沒有放進去的 [{ field, label, value }]
 * }
 */
export function fill_plan(current, card, side = "front") {
  const cur = current || {};
  const set = {};
  const skipped = [];
  const got = { ...card };
  // 名片上只有英文姓名（沒有中文姓名）：正面的英文姓名就當作姓名
  if (side === "front" && !got.name && got.englishName && !py.strip(cur.name || "")) {
    got.name = got.englishName;
    got.englishName = "";
  }
  for (const key of SIMPLE) {
    const mine = got[key];
    if (!mine) continue;
    const theirs = py.strip(cur[key] || "");
    if (key === "zip") continue; // 郵遞區號跟著地址走，下面一起處理
    if (!theirs) set[key] = mine;
    else if (!same(mine, theirs)) skipped.push({ field: key, label: FIELD_LABEL[key], value: mine });
  }
  // 郵遞區號：這次有填地址，或表單的地址就是同一個，才跟著填（免得把別的地址的郵遞區號配到現有地址上）
  if (got.zip && !py.strip(cur.zip || "") && ("address" in set || (got.address && same(got.address, cur.address)))) set.zip = got.zip;

  const have = new Set((cur.phones || []).filter((p) => py.strip(p.value || "")).map(phone_key));
  const phones = [];
  for (const p of got.phones || []) {
    const k = phone_key(p);
    if (have.has(k)) continue;
    have.add(k);
    phones.push({ kind: p.kind, value: p.value });
  }
  const haveMail = new Set((cur.emails || []).filter(Boolean).map((e) => R.norm_email(e)));
  const emails = [];
  for (const e of got.emails || []) {
    if (haveMail.has(R.norm_email(e))) continue;
    haveMail.add(R.norm_email(e));
    emails.push(e);
  }
  return { set, phones, emails, skipped };
}

/**
 * 只給管理者看、顯示在辨識結果最下面的那一行：這次等了幾秒、用量多少。
 * totalMs：從開始處理照片到結果出來，使用者實際等的時間（毫秒）。res：後台回傳的 { ms（Claude 花的時間）, usage: { input, output } }。
 * 後台沒有回報的項目就不寫。
 */
export function stat_line(totalMs, res) {
  const sec = (ms) => (ms / 1000).toFixed(1);
  const num = (n) => Number(n).toLocaleString("en-US");
  const ok = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const r = res && typeof res === "object" ? res : {};
  let s = `測試用：這次共等 ${sec(ok(totalMs) ? totalMs : 0)} 秒`;
  if (ok(r.ms)) s += `（Claude ${sec(r.ms)} 秒）`;
  s += "。";
  const u = r.usage && typeof r.usage === "object" ? r.usage : {};
  if (ok(u.input) && ok(u.output)) s += `用量：輸入 ${num(u.input)}、輸出 ${num(u.output)}。`;
  return s;
}

/**
 * 這支電話要不要「用轉正後的照片再讀一次」：程式整理不出來（多半是多讀或少讀了一碼）才要。
 * 國外號碼本來就不整理，不算。
 */
export function needs_recheck(value, kind) {
  const v = text(value);
  if (!v) return false;
  const r = GC.prepare_phone(v, KINDS.includes(kind) ? kind : "公司");
  return !r.ok && !/^國外號碼/.test(r.reason || "");
}

/** 比對用的數字：國字、全形先轉掉，開頭的 886（國碼）換成 0，這樣「+886 3…」和「03…」比得起來。 */
function national_digits(value) {
  const d = digits(cn_digits(to_half(value || "")));
  if (!d.startsWith("886")) return d;
  const rest = d.slice(3);
  return rest.startsWith("0") ? rest : "0" + rest;
}

/** 兩串數字差幾碼（多一碼、少一碼、錯一碼各算 1）。 */
function digit_distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/**
 * 再讀一次之後，哪些看不懂的電話可以換成新讀到的。
 * bad：第一次讀到、程式看不懂的電話 [{ kind, value }]。card：第二次辨識的 clean_result。
 * 規則：新讀到的號碼要「程式整理得出來」，而且和原本那支只差 1～2 碼（確定是同一支，不是名片上別的號碼）；
 * 差得一樣少時優先選同一種（手機／公司／傳真）。每支新號碼只用一次。
 * 回傳 [{ value: 原本的寫法, kind, fixed: 新讀到的寫法 }]；找不到可以換的就不列。
 */
export function recheck_plan(bad, card) {
  const pool = (card?.phones || []).filter((p) => GC.prepare_phone(p.value, p.kind).ok).map((p) => ({ ...p, d: national_digits(p.value) }));
  const out = [];
  for (const b of bad || []) {
    const mine = national_digits(b.value);
    let best = null;
    for (const p of pool) {
      if (p.used) continue;
      const dist = digit_distance(mine, p.d);
      if (dist < 1 || dist > 2) continue;
      const score = dist * 2 + (p.kind === b.kind ? 0 : 1);
      if (!best || score < best.score) best = { p, score };
    }
    if (!best) continue;
    best.p.used = true;
    out.push({ value: b.value, kind: b.kind, fixed: best.p.value });
  }
  return out;
}

/**
 * 電話的排列順序：手機 → 公司 → 傳真（使用者 2026-11-25 決定）；同一種的維持原本的先後；空的排最後。
 * list：[{ kind, value, … }]。回傳排好的新陣列（不改原本的）。
 */
export function sort_phones(list) {
  const rank = (p) => (text(p?.value) ? (KINDS.includes(p.kind) ? KINDS.indexOf(p.kind) : KINDS.length) : KINDS.length + 1);
  return (list || []).map((p, i) => ({ p, i, r: rank(p) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.p);
}

/** 這次辨識有沒有讀到任何可以填的東西。 */
export function has_content(card) {
  return SIMPLE.some((k) => card[k]) || card.phones.length > 0 || card.emails.length > 0;
}

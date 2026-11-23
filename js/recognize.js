// 把 Claude 的辨識結果整理成表單用的內容，並決定哪些格子要填（純計算，不碰畫面，可以自動測試）。
//
// 分工（需求報告 5.1）：Claude 只負責「讀出名片上寫什麼、分到哪一欄」（後台 Code.gs 的 RESULT_SCHEMA）；
// 電話、地址的格式整理仍然是表單原本那套固定規則（gcontact.prepare_phone／prepare_address），這個檔不做。
// 這個檔做的事：
// - clean_result：去掉空白與佔位文字、統編誤放進電話的拿掉、列出要請使用者特別核對的地方（沒把握的欄位、可能的簡體字）。
// - fill_plan：只填「目前空著」的格子，已經有內容的不動（使用者自己打的字不會被蓋掉）。
import { cn_digits, to_half } from "./cnnum.js";
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
    rotate: r.rotate_clockwise,
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
 * 測試期間顯示在辨識結果最下面的那一行：這次等了幾秒、用量多少。
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

/** 這次辨識有沒有讀到任何可以填的東西。 */
export function has_content(card) {
  return SIMPLE.some((k) => card[k]) || card.phones.length > 0 || card.emails.length > 0;
}

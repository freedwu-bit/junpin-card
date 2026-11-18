// 存檔前查重（純計算，不連網路）。使用者 2026-11-18 決定：只用 Google 的搜尋，不整批讀取通訊錄。
//
// 2026-11-18 實測：Google 的搜尋只照字面比（同一支號碼寫法不同就找不到），所以
// 1. 同一支手機用多種常見寫法各查一次（phone_variants）；
// 2. 搜尋回來的每一筆，再用規則程式把號碼整理成純數字後比對，數字真的相同才算（match）。
// 已知限制：通訊錄裡如果是少見的寫法（例如 09-8765-4321），仍然可能查不到。
import * as R from "./rules.js";
import * as py from "./pyre.js";
import { items } from "./twoacct.js";

/** 一支手機（10 碼數字）要拿去搜尋的各種寫法。對照表見 CLAUDE.md。 */
export function phone_variants(key) {
  if (!/^09[0-9]{8}$/.test(key)) return key ? [key] : [];
  const a = key.slice(0, 4);
  const b = key.slice(4, 7);
  const c = key.slice(7);
  const intl = key.slice(1); // 去掉開頭的 0，接在 +886 後面
  return [
    `${a}-${b}-${c}`, // 規則的寫法
    key, // 只有數字
    `${a} ${b} ${c}`, // 空白隔開（也找得到有橫線的）
    `${a}-${b}${c}`, // 只有一條橫線
    `+886${intl}`, // +886 連寫
    `+886 ${intl.slice(0, 3)} ${b} ${c}`, // +886 空白隔開
    a, // 前四碼：補漏用（其他 0 開頭的寫法）
  ];
}

function phoneFacts(list) {
  const mobiles = new Set();
  const landlines = new Set();
  for (const { value, type } of list) {
    const r = R.normalize_phone(value || "", type, "公司");
    if (!r.key) continue;
    if (r.kind === "mobile") mobiles.add(r.key);
    else if (r.kind === "landline" || r.kind === "tollfree") landlines.add(r.key);
  }
  return { mobiles, landlines };
}

/** 名片（表單）上用來比對的資料。card 的格式和 gcontact.build_person 相同。 */
export function card_facts(card) {
  const kindToType = { 手機: "mobile", 公司: "work", 傳真: "workFax" };
  const { mobiles, landlines } = phoneFacts(
    (card.phones || []).filter((p) => p.kind !== "傳真").map((p) => ({ value: p.value, type: kindToType[p.kind] || "work" })),
  );
  const emails = new Set((card.emails || []).map(R.norm_email).filter(Boolean));
  const company = R.norm_text(R.company_short(card.company || ""));
  return { name: py.strip(card.name || ""), mobiles, landlines, emails, companies: new Set(company ? [company] : []) };
}

/** 現有聯絡人用來比對的資料（只看來源是「聯絡人」的項目）。 */
export function person_facts(person) {
  const n = items(person, "names")[0] || {};
  const parsed = R.parse_name(n.honorificPrefix, n.familyName, n.middleName, n.givenName, n.honorificSuffix);
  const { mobiles, landlines } = phoneFacts(items(person, "phoneNumbers").filter((x) => R.map_type(x.type) !== "傳真"));
  const emails = new Set(items(person, "emailAddresses").map((x) => R.norm_email(x.value)).filter(Boolean));
  const companies = new Set(items(person, "organizations").map((x) => R.norm_text(R.company_short(x.name || ""))).filter(Boolean));
  return { name: parsed.name_key || parsed.name || "", display: n.displayName || n.givenName || "", mobiles, landlines, emails, companies };
}

/** 要送去搜尋的字串（不重複）。只查手機、Email、本名；市話不查（同事共用公司市話屬正常）。 */
export function build_queries(card) {
  const f = card_facts(card);
  const out = [];
  const add = (q) => {
    if (q && !out.includes(q)) out.push(q);
  };
  for (const m of f.mobiles) for (const v of phone_variants(m)) add(v);
  for (const e of f.emails) add(e);
  if ([...f.name].length >= 2) add(f.name);
  return out;
}

function overlap(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/**
 * 這筆現有聯絡人和名片是不是疑似重複。不是就回 null。
 * 會提醒的情況（需求報告第 6 節、規則文件 9.1）：手機相同、Email 相同、本名相同。只有市話或公司相同不提醒。
 * 回傳 { level, title, same }：
 *   level 'strong'  本名相同，而且手機、Email、公司名稱、公司電話至少兩項相同 → 很可能是同一個人
 *         'name'    本名相同，其他相同的不到兩項
 *         'mobile'  手機相同但名字不同（可能是夫妻、助理，也可能資料有誤）
 *         'email'   只有 Email 相同（同公司共用信箱屬正常）
 */
export function match(card, person) {
  const c = card_facts(card);
  const p = person_facts(person);
  const same = {
    name: Boolean(c.name) && c.name === p.name,
    mobile: overlap(c.mobiles, p.mobiles),
    email: overlap(c.emails, p.emails),
    company: overlap(c.companies, p.companies),
    landline: overlap(c.landlines, p.landlines),
  };
  if (!same.name && !same.mobile && !same.email) return null;
  const others = [same.mobile, same.email, same.company, same.landline].filter(Boolean).length;
  const what = [same.mobile && "手機", same.email && "Email", same.company && "公司", same.landline && "公司電話"].filter(Boolean);
  let level;
  let title;
  if (same.name && others >= 2) {
    level = "strong";
    title = `很可能是同一個人（姓名相同，${what.join("、")}也相同）`;
  } else if (same.name) {
    level = "name";
    title = what.length ? `姓名相同，${what.join("、")}也相同` : "姓名相同";
  } else if (same.mobile) {
    level = "mobile";
    title = "手機相同，但姓名不同（可能是夫妻、助理，也可能資料有誤）";
  } else {
    level = "email";
    title = "Email 相同，但姓名不同（同公司共用信箱屬正常）";
  }
  return { level, title, same };
}

const ORDER = { strong: 0, name: 1, mobile: 2, email: 3 };

/**
 * 從搜尋回來的聯絡人裡挑出疑似重複的。persons 可以有重複（同一筆被不同查法找到）。
 * skipGroups：掛著這些標籤（例如「_待刪除」）的不算。回傳 [{ person, level, title, same }]，最像的排前面。
 */
export function find_matches(card, persons, skipGroups = []) {
  const seen = new Set();
  const out = [];
  for (const person of persons) {
    if (!person || seen.has(person.resourceName)) continue;
    seen.add(person.resourceName);
    const groups = (person.memberships || []).map((m) => m?.contactGroupMembership?.contactGroupResourceName);
    if (groups.some((g) => skipGroups.includes(g))) continue;
    const m = match(card, person);
    if (m) out.push({ person, ...m });
  }
  out.sort((x, y) => ORDER[x.level] - ORDER[y.level]);
  return out;
}

/** 給畫面顯示用：這筆現有聯絡人的姓名、公司、電話、Email。 */
export function summarize(person) {
  const n = items(person, "names")[0] || {};
  const orgs = items(person, "organizations")
    .map((x) => [x.name, x.title].filter(Boolean).join("　"))
    .filter(Boolean);
  return {
    name: n.displayName || n.givenName || "（沒有姓名）",
    orgs,
    phones: items(person, "phoneNumbers").map((x) => x.value).filter(Boolean),
    emails: items(person, "emailAddresses").map((x) => x.value).filter(Boolean),
  };
}

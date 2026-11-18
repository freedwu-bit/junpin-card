// 把「名片上的資料」組成要送給 Google 聯絡人（People API）的內容。純計算，不連網路，可以自動測試。
//
// - 地址安全寫法（規則文件 7.3）：clean_fv()、safe()、is_safe() 是 ~/通訊錄整理/程式/41_地址修正.py 的移植。
// - build_person() 是名片 App 新寫的：照規則文件第 12 節把各欄位組起來。
import { normalize_address } from "./address.js";
import * as py from "./pyre.js";
import * as R from "./rules.js";

export const TYPE_TO_GOOGLE = { 手機: "mobile", 公司: "work", 傳真: "workFax", 住家: "home" };
// Google 讀回來才有、送出時不能帶的欄位（writer.py 的 OUTPUT_ONLY）
const OUTPUT_ONLY = ["metadata", "canonicalForm", "formattedType", "displayName", "displayNameLastFirst"];
const DROP_KEYS = ["city", "region", "extendedAddress", "poBox", "country", "streetAddress", "formattedValue"];
const TW_LINE = String.raw`^TW(\s*\d{3,6})?$`;

function lines(fv) {
  return py.strip(fv || "").split("\n").filter((s) => py.strip(s));
}

/** 在 Google 網頁存檔後，地址後面會多一行「TW 郵遞區號」（無害），比對前先拿掉這一行。 */
export function clean_fv(fv) {
  const ls = lines(fv);
  while (ls.length > 1 && py.match(TW_LINE, py.strip(ls[ls.length - 1]))) ls.pop();
  return ls.join("\n");
}

/** 把一個現有的地址項目改成安全寫法（文字不變）。 */
export function safe(x) {
  const fv = clean_fv(x.formattedValue);
  const it = {};
  for (const [k, v] of Object.entries(x)) if (!OUTPUT_ONLY.includes(k) && !DROP_KEYS.includes(k)) it[k] = v;
  it.formattedValue = fv;
  it.streetAddress = lines(fv).map((s) => py.strip(s)).join(" ");
  return it;
}

/** 這個地址項目是不是安全寫法：整行同時寫在 formattedValue 和 streetAddress，沒有城市、區域等分欄。 */
export function is_safe(x) {
  if (clean_fv(x.formattedValue) !== py.strip(x.formattedValue || "")) return false;
  const fv = py.strip(x.formattedValue || "");
  return (
    (x.streetAddress || "") === lines(fv).map((s) => py.strip(s)).join(" ") &&
    !["city", "region", "extendedAddress", "poBox", "country"].some((k) => x[k])
  );
}

/** 新增一個地址項目（安全寫法）。 */
export function new_address(line, postalCode = "", type = "work") {
  const it = { formattedValue: line, streetAddress: line, type };
  if (postalCode) it.postalCode = postalCode;
  return it;
}

/**
 * 整理一支電話。回傳 { value, type, ok, reason }：
 * ok=true 表示已照規則整理好；ok=false 表示看不懂，value 保持原樣，畫面要標出來請使用者看（規則文件 5.4）。
 * kind：名片上這支電話是「手機」「公司」還是「傳真」。
 */
export function prepare_phone(value, kind = "公司") {
  const r = R.normalize_phone(value, TYPE_TO_GOOGLE[kind] || "work", "公司");
  if (r.status === "ok") return { value: r.new_value, type: TYPE_TO_GOOGLE[r.new_type], ok: true, reason: "" };
  return { value: value || "", type: TYPE_TO_GOOGLE[kind] || "work", ok: false, reason: r.reason };
}

/**
 * 整理一個地址。回傳 { text, zip, ok, reason, suggest }：
 * ok=false 表示看不懂或不是中文地址，text 保持原樣，畫面要標出來請使用者看（規則文件 7.1）。
 */
export function prepare_address(text, zip = "") {
  const sc = R.simplified_chars(text || "");
  const garbled = R.looks_garbled(text || "") || (sc.length ? "含簡體字" : "");
  const r = normalize_address(text, zip, "", garbled);
  if (r.status === "ok") return { text: r.new, zip: r.zip || "", ok: true, reason: "", suggest: "" };
  return { text: py.strip(text || ""), zip: py.sub(String.raw`\D`, "", zip || ""), ok: false, reason: r.reason, suggest: r.suggest };
}

/**
 * 類別模式下，第三段的預設建議（規則文件 3.3、12.1）：
 * 技師、財務從職稱或公司名找專長；雋品、建築師空白；其他類別用公司簡稱。只是建議，使用者可改、可清空。
 */
export function suggest_third(category, { title = "", company = "" } = {}) {
  const c = R.completion(category, "某某", "", { titles: title ? [title] : [], companies: company ? [company] : [] });
  return c.third || "";
}

/**
 * 組出新增聯絡人要送出的內容（people:createContact 的 body）。
 * card：{ mode: "category"|"plain", category, name, third,
 *         phones: [{ value, kind }], emails: [..], address: { text, zip },
 *         company, department, title, englishName, taxId, website, note, groupResourceName }
 * 回傳 { body, whole, warnings }。warnings 是需要使用者看一眼的地方（看不懂的電話、地址）。
 */
export function build_person(card) {
  const warnings = [];
  const whole = card.mode === "plain" ? py.strip(card.name || "") : R.compose(card.category || "", py.strip(card.name || ""), py.strip(card.third || ""));
  // 整串只寫在「名」；姓、前稱謂、後稱謂、中間名都不送（規則文件 3.1）
  const body = { names: [{ givenName: whole }] };

  const phones = [];
  for (const p of card.phones || []) {
    if (!py.strip(p.value || "")) continue;
    const r = prepare_phone(p.value, p.kind);
    if (!r.ok) warnings.push(`電話「${p.value}」看不懂（${r.reason}），照原樣存`);
    if (!phones.some((q) => q.value === r.value && q.type === r.type)) phones.push({ value: r.value, type: r.type });
  }
  if (phones.length) body.phoneNumbers = phones;

  const emails = [];
  for (const e of card.emails || []) {
    const v = py.strip(e || "");
    if (v && !emails.some((q) => R.norm_email(q.value) === R.norm_email(v))) emails.push({ value: v, type: "work" });
  }
  if (emails.length) body.emailAddresses = emails;

  if (card.address && py.strip(card.address.text || "")) {
    const a = prepare_address(card.address.text, card.address.zip);
    if (!a.ok) warnings.push(`地址「${a.text}」看不懂（${a.reason}），照原樣存`);
    body.addresses = [new_address(a.text, a.zip, "work")];
  }

  const org = {};
  if (py.strip(card.company || "") && !R.is_placeholder(card.company)) org.name = py.strip(card.company);
  if (py.strip(card.department || "")) org.department = py.strip(card.department);
  if (py.strip(card.title || "") && !R.is_placeholder(card.title)) org.title = py.strip(card.title);
  if (Object.keys(org).length) body.organizations = [org];

  if (py.strip(card.englishName || "")) body.nicknames = [{ value: py.strip(card.englishName) }];
  if (py.strip(card.taxId || "")) body.userDefined = [{ key: "統編", value: py.strip(card.taxId) }];
  if (py.strip(card.website || "")) body.urls = [{ value: py.strip(card.website), type: "work" }];
  if (py.strip(card.note || "")) body.biographies = [{ value: card.note, contentType: "TEXT_PLAIN" }];
  if (card.groupResourceName) {
    body.memberships = [{ contactGroupMembership: { contactGroupResourceName: card.groupResourceName } }];
  }
  return { body, whole, warnings };
}

/**
 * 寫入後讀回來核對（規則文件 14：每筆寫入後再讀一次逐欄核對）。
 * 回傳問題清單；空清單＝完全符合。Google 會調動電話順序、省略公司欄的類型，這些不算問題。
 */
export function verify_created(sent, got) {
  const probs = [];
  const mine = (f) => (got[f] || []).filter((x) => x?.metadata?.source?.type === "CONTACT");
  const n = mine("names")[0] || {};
  const want = sent.names[0].givenName;
  if (n.givenName !== want) probs.push(`「名」那一格不是整串（讀到「${n.givenName ?? ""}」）`);
  for (const k of ["familyName", "middleName", "honorificPrefix", "honorificSuffix"]) {
    if (n[k]) probs.push(`姓名的其他格子不是空的（${k}＝${n[k]}）`);
  }
  if (n.displayName !== want) probs.push(`顯示名稱不是整串（讀到「${n.displayName ?? ""}」）`);
  // 在 Google 網頁存檔後，類型會被改寫成同義的中文（mobile → 行動電話），規則文件 5.2：當成同一種
  const kind = (t) => R.map_type(t) || t || "";
  const gotPhones = mine("phoneNumbers").map((x) => `${x.value}｜${kind(x.type)}`);
  for (const p of sent.phoneNumbers || []) {
    if (!gotPhones.includes(`${p.value}｜${kind(p.type)}`)) probs.push(`電話「${p.value}」（${kind(p.type)}）讀回來不一樣：${gotPhones.join("、")}`);
  }
  const gotMails = mine("emailAddresses").map((x) => x.value);
  for (const e of sent.emailAddresses || []) if (!gotMails.includes(e.value)) probs.push(`Email「${e.value}」沒有讀到`);
  const gotAddr = mine("addresses");
  for (const a of sent.addresses || []) {
    const hit = gotAddr.find((x) => clean_fv(x.formattedValue) === a.formattedValue);
    if (!hit) {
      probs.push(`地址讀回來不一樣：${gotAddr.map((x) => x.formattedValue).join("／")}`);
    } else {
      // 在 Google 網頁存檔後會多一行「TW 郵遞區號」和 country 欄位，這是無害的（規則文件 7.3），核對時不算
      const view = { ...hit, formattedValue: clean_fv(hit.formattedValue) };
      delete view.country;
      if (!is_safe(view)) probs.push("地址不是安全寫法（被拆到城市、區域等分欄了）");
    }
  }
  const gotOrg = mine("organizations");
  for (const o of sent.organizations || []) {
    if (!gotOrg.some((x) => (x.name || "") === (o.name || "") && (x.title || "") === (o.title || ""))) probs.push("公司欄讀回來不一樣");
  }
  const groups = (got.memberships || []).map((m) => m?.contactGroupMembership?.contactGroupResourceName);
  for (const m of sent.memberships || []) {
    if (!groups.includes(m.contactGroupMembership.contactGroupResourceName)) probs.push("標籤沒有掛上");
  }
  return probs;
}

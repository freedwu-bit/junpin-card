// 修改現有聯絡人時的安全檢查（寫入前比對、組寫入內容、寫完驗收、還原）。純計算，不連網路。
//
// 這個檔是 ~/通訊錄整理/程式/writer.py「純函式」那一段的逐行移植，函式名稱相同；
// 原版的 18 項測試移植在 tests/writer.test.mjs。存檔與連線的部分原版是寫 Mac mini 的檔案和用 Python 連線，
// 名片 App 改成存在手機瀏覽器（snapshot_store）和 google.js。
//
// 重點（規則文件 14）：
// - 修改用 updateContact，指定的欄位是「整欄替換」：沒改的項目也要一起送回去；送空的清單會真的清空。
// - 要帶該筆的 etag 和聯絡人來源；聯絡人在這之間被改過，Google 會拒絕。
// - 只處理來源是「聯絡人」的項目；公司網域目錄帶進來的不看也不改。
// - 備註欄絕對不寫入。
import * as py from "./pyre.js";
import * as R from "./rules.js";

export const ALLOWED_MASK = ["names", "phoneNumbers", "addresses", "organizations", "emailAddresses"];
export const CHANGE_TO_FIELD = { 姓名: "names", 電話: "phoneNumbers", 地址: "addresses", 公司: "organizations", Email: "emailAddresses" };
export const TYPE_TO_GOOGLE = { 手機: "mobile", 公司: "work", 傳真: "workFax", 住家: "home" };
export const OUTPUT_ONLY = ["metadata", "canonicalForm", "formattedType", "displayName", "displayNameLastFirst"];
export const ADDR_MODE = "formatted_only";
export const NAME_MODE = "given_and_unstructured";
const ADDR_DROP_KEYS = ["streetAddress", "extendedAddress", "city", "region", "poBox", "neighborhood"];
const NAME_CLEAR_KEYS = ["honorificPrefix", "familyName", "middleName", "honorificSuffix"];
export const CHECK_FIELDS = [...ALLOWED_MASK, "biographies"];

/** Google 上的資料和計畫當時看到的不一樣：不寫，要重新比對。 */
export class PlanMismatch extends Error {}

/** 兩份資料內容是否完全相同（物件的欄位順序不同不算不同；清單的順序不同算不同）。等於 Python 的 ==。 */
export function deep_equal(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deep_equal(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deep_equal(a[k], b[k]));
}

export function src_type(x) {
  return x?.metadata?.source?.type;
}

/** 只取聯絡人本身（CONTACT 來源）的項目，順序照 Google 給的。 */
export function contact_items(person, field) {
  return (person[field] || []).filter((x) => src_type(x) === "CONTACT");
}

export function contact_source(person) {
  const s = (person.metadata?.sources || []).filter((x) => x.type === "CONTACT");
  if (s.length !== 1) throw new PlanMismatch("找不到唯一的聯絡人來源");
  const out = {};
  for (const k of ["type", "id", "etag"]) if (k in s[0]) out[k] = s[0][k];
  return out;
}

/** 拿掉 Google 讀回來才有、送出時不能帶的欄位。 */
export function strip(item) {
  const it = structuredClone(item);
  for (const k of OUTPUT_ONLY) delete it[k];
  return it;
}

export function comparable(person, fields = CHECK_FIELDS) {
  const out = {};
  for (const f of fields) out[f] = contact_items(person, f).map(strip);
  return out;
}

/** 兩份聯絡人資料，哪些欄位不一樣（只回欄位名稱）。 */
export function changed_fields(a, b, fields = CHECK_FIELDS) {
  const ca = comparable(a, fields);
  const cb = comparable(b, fields);
  return fields.filter((f) => !deep_equal(ca[f], cb[f]));
}

/** 寫入前：Google 上現在的資料要和當初看到的一模一樣（含備註），否則不寫。只回報欄位名稱，不印內容。 */
export function check_unchanged(person_now, person_backup, fields = CHECK_FIELDS) {
  const diff = changed_fields(person_now, person_backup, fields);
  if (diff.length) throw new PlanMismatch(`分析之後這筆在 Google 上被改過（${diff.join("、")}），這次不寫，請重新讀取再分析`);
}

export function one_line(t) {
  return py.strip(py.sub(String.raw`\s+`, " ", t || ""));
}

function _aligned(items, entries, field, old_of, now_of) {
  if (items.length !== entries.length) throw new PlanMismatch(`${field} 的數量和計畫不同`);
  items.forEach((it, i) => {
    if (!deep_equal(old_of(entries[i]), now_of(it))) throw new PlanMismatch(`${field} 的內容和計畫不同`);
  });
}

/**
 * 依「整理計畫」組出 updateContact 要送的 [遮罩, 內容]（通訊錄整理用的格式；名片 App 的補資料用 merge.js）。
 * 只改計畫裡有的欄位；計畫裡標「不動」的項目原樣送回。
 */
export function build_update(person_now, plan, addr_mode = ADDR_MODE, name_mode = NAME_MODE) {
  const ch = plan.changes;
  const unknown = Object.keys(ch).filter((k) => !(k in CHANGE_TO_FIELD) && k !== "標籤").sort();
  if (unknown.length) throw new Error(`計畫裡有不認得的欄位：${unknown.join("、")}`);
  const body = { etag: person_now.etag, metadata: { sources: [contact_source(person_now)] } };
  const mask = [];

  if (plan.new_name) {
    const items = contact_items(person_now, "names");
    const it = items.length ? strip(items[0]) : {};
    for (const k of NAME_CLEAR_KEYS) delete it[k];
    const whole = plan.new_name.givenName;
    it.givenName = whole;
    if (name_mode === "given_and_unstructured") it.unstructuredName = whole;
    else delete it.unstructuredName;
    body.names = [it]; // 姓名只能有一個
    mask.push("names");
  }

  if ("電話" in ch) {
    const items = contact_items(person_now, "phoneNumbers");
    _aligned(items, ch["電話"], "電話", (e) => e.old_value, (it) => it.value ?? "");
    const out = [];
    items.forEach((it, i) => {
      const e = ch["電話"][i];
      if (e.action === "drop") return;
      if (e.action === "keep") {
        out.push(strip(it));
        return;
      }
      for (const v of e.values?.length ? e.values : [e.new_value]) {
        const n = strip(it);
        n.value = v;
        if (e.new_type && R.map_type(it.type) !== e.new_type) n.type = TYPE_TO_GOOGLE[e.new_type];
        out.push(n);
      }
    });
    body.phoneNumbers = out;
    mask.push("phoneNumbers");
  }

  if ("地址" in ch) {
    const items = contact_items(person_now, "addresses");
    _aligned(items, ch["地址"], "地址", (e) => e.old, (it) => one_line(it.formattedValue));
    const out = [];
    items.forEach((it, i) => {
      const e = ch["地址"][i];
      if (e.action === "drop") return;
      const n = strip(it);
      if (e.action === "change") {
        n.formattedValue = e.new;
        if (addr_mode === "formatted_only") for (const k of ADDR_DROP_KEYS) delete n[k];
      }
      out.push(n);
    });
    body.addresses = out;
    mask.push("addresses");
  }

  if ("公司" in ch) {
    const items = contact_items(person_now, "organizations");
    _aligned(items, ch["公司"], "公司", (e) => [e.old_name, e.old_title], (it) => [py.strip(it.name || ""), py.strip(it.title || "")]);
    const out = [];
    items.forEach((it, i) => {
      const e = ch["公司"][i];
      if (e.action === "drop") return;
      const n = strip(it);
      if (e.action === "change") {
        for (const [k, v] of [["name", e.new_name], ["title", e.new_title]]) {
          if (v) n[k] = v;
          else delete n[k];
        }
      }
      out.push(n);
    });
    body.organizations = out;
    mask.push("organizations");
  }

  if ("Email" in ch) {
    const items = contact_items(person_now, "emailAddresses");
    _aligned(items, ch.Email, "Email", (e) => e.old, (it) => it.value ?? "");
    const out = [];
    items.forEach((it, i) => {
      const e = ch.Email[i];
      if (e.action === "drop") return;
      const n = strip(it);
      if (e.action === "change") n.value = e.new;
      out.push(n);
    });
    body.emailAddresses = out;
    mask.push("emailAddresses");
  }

  guard(mask, body);
  return [mask, body];
}

/** 最後一道關：遮罩只能是允許的那幾種；備註絕對不能出現；內容裡不能有遮罩以外的欄位。 */
export function guard(mask, body, allowed = ALLOWED_MASK) {
  const bad = mask.filter((f) => !allowed.includes(f)).sort();
  if (bad.length) throw new Error(`不允許寫入的欄位：${bad.join("、")}`);
  if (mask.includes("biographies") || "biographies" in body) throw new Error("備註欄不可以寫入");
  const extra = Object.keys(body).filter((k) => !mask.includes(k) && !["etag", "metadata", "resourceName"].includes(k)).sort();
  if (extra.length) throw new Error(`內容裡有遮罩以外的欄位：${extra.join("、")}`);
}

/** 還原：把這幾種欄位整個換回存檔時的樣子。只送有差別的欄位；備註不在範圍內（本來就沒改過）。 */
export function build_restore(person_now, snapshot, fields = ALLOWED_MASK) {
  const mask = changed_fields(person_now, snapshot, fields);
  const body = { etag: person_now.etag, metadata: { sources: [contact_source(person_now)] } };
  for (const f of mask) body[f] = contact_items(snapshot, f).map(strip);
  guard(mask, body, fields);
  return [mask, body];
}

/** actual 是否包含 expected 的每一個欄位值（Google 可能另外補 canonicalForm 等，不算錯）。 */
function _sub(expected, actual) {
  return Object.entries(expected).every(([k, v]) => deep_equal(actual[k], v));
}

/**
 * 寫完再讀一次：遮罩外的欄位（含備註）要和寫入前完全一樣；遮罩內的要等於送出的內容。回傳問題清單（只有欄位名稱）。
 * check_fields：要檢查哪些欄位（原版固定是那 5 種加備註；名片 App 會多檢查網站、暱稱、自訂欄位）。
 */
export function verify(after, before, mask, body, ignore = ["memberships"], check_fields = CHECK_FIELDS) {
  const problems = [];
  for (const f of check_fields.filter((x) => !mask.includes(x) && !ignore.includes(x))) {
    if (!deep_equal(comparable(after, [f]), comparable(before, [f]))) problems.push(`${f} 不該變卻變了`);
  }
  for (const f of mask) {
    const got = contact_items(after, f).map(strip);
    const exp = body[f] || [];
    // Google 會自己調整順序（例如手機排到最前面），內容相同就算對，不看順序
    const left = [...got];
    let ok = got.length === exp.length;
    for (let e of exp) {
      if (f === "organizations" && e.type === "work") {
        // Google 會把公司欄的類型「work」省略不回傳，內容其實一樣
        e = Object.fromEntries(Object.entries(e).filter(([k]) => k !== "type"));
      }
      const hit = left.findIndex((g) => _sub(e, g));
      if (hit < 0) {
        ok = false;
        break;
      }
      left.splice(hit, 1);
    }
    if (!ok) problems.push(`${f} 和預期不同`);
  }
  return problems;
}

/** 整批寫入的硬閘：只收名單裡、而且在計畫內的；超過 limit 筆要另外允許。（名片 App 一次只改一筆，用不到，照原版留著。） */
export function check_gate(rns, plan_rns, allow_many = false, limit = 6) {
  if (!rns.length) throw new Error("名單是空的");
  const missing = rns.filter((x) => !plan_rns.has(x));
  if (missing.length) throw new Error(`名單裡有 ${missing.length} 筆不在修改計畫內`);
  if (new Set(rns).size !== rns.length) throw new Error("名單裡有重複");
  if (rns.length > limit && !allow_many) throw new Error(`一次超過 ${limit} 筆，要另外允許`);
}

// ---------------- 存檔（修改前的原始資料，用來還原） ----------------

export function person_id(rn) {
  return rn.split("/").pop();
}

/**
 * 修改前存檔。原版存成 Mac mini 上的檔案；名片 App 存在手機瀏覽器的儲存空間（storage 用 localStorage，測試時用假的）。
 * 和原版一樣的規矩：同一個名稱已經存過就報錯、不覆蓋；存完讀回來核對，不一致就報錯（存不成功就不可以寫入）。
 * run：這次修改的時間代號（例如 20261119-153000）。
 */
export function save_snapshot(storage, person, run, tag = "") {
  const key = `junpin-card-snap/${run}/${person_id(person.resourceName)}${tag ? "_" + tag : ""}`;
  if (storage.getItem(key) !== null) throw new Error("這個存檔已經存在，不覆蓋：" + key);
  storage.setItem(key, JSON.stringify(person));
  if (!deep_equal(JSON.parse(storage.getItem(key)), person)) throw new Error("存檔讀回來不一致：" + key);
  return key;
}

function snapshot_keys(storage) {
  const keys = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k?.startsWith("junpin-card-snap/")) keys.push(k);
  }
  return keys.sort();
}

/** 還原預設用「最早」的存檔（同一人可能被改過不只一次，最新的存檔不是原始狀態）。回傳 [名稱, 資料]。 */
export function earliest_snapshot(storage, rn) {
  const id = person_id(rn);
  const hit = snapshot_keys(storage).find((k) => k.split("/")[2] === id);
  return hit ? [hit, JSON.parse(storage.getItem(hit))] : [null, null];
}

/** 這個人最近一次修改前的存檔。回傳 [名稱, 資料]。 */
export function latest_snapshot(storage, rn) {
  const id = person_id(rn);
  const hits = snapshot_keys(storage).filter((k) => k.split("/")[2] === id);
  const hit = hits[hits.length - 1];
  return hit ? [hit, JSON.parse(storage.getItem(hit))] : [null, null];
}

/** 只留最近 keep 次修改的存檔，舊的清掉（手機的儲存空間有限）。 */
export function prune_snapshots(storage, keep = 20) {
  const runs = [...new Set(snapshot_keys(storage).map((k) => k.split("/")[1]))].sort();
  const drop = new Set(runs.slice(0, Math.max(0, runs.length - keep)));
  for (const k of snapshot_keys(storage)) if (drop.has(k.split("/")[1])) storage.removeItem(k);
}

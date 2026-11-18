// 比對兩筆聯絡人用的小函式（純函式，不連網路）：兩個地址是不是同一個、甲那筆比乙那筆多了哪些資料。
//
// 這個檔是 ~/通訊錄整理/程式/twoacct.py 的逐行移植。名片 App 的「更新那一筆」會用到：
// 把名片上有、現有那筆沒有的資料找出來（只補缺的、不覆蓋）。
import * as py from "./pyre.js";
import * as R from "./rules.js";

const ROAD = "[一-鿿]{1,6}?(?:路|街|大道)";
const HAO = String.raw`(\d+(?:-\d+)?)\s*號`;

/** 只取來源是「聯絡人」的項目（公司網域目錄帶進來的不看也不改）。 */
export function items(p, f) {
  return (p[f] || []).filter((x) => x?.metadata?.source?.type === "CONTACT");
}

export function addr_tokens(s) {
  s = (s || "").replaceAll("臺", "台");
  const digits = py.counter(py.findall(String.raw`\d+`, s));
  // 路名只取最後一個「市區鄉鎮縣號樓巷弄」之後的部分（例如「中山區明水路」→「明水路」）
  const roads = new Set();
  for (const m of py.sub(String.raw`\s`, "", s).matchAll(py.re(ROAD, "g"))) {
    const last = m[0].split(py.re("[市區鄉鎮縣號樓巷弄村里]")).pop();
    if (last !== "") roads.add(last);
  }
  return [digits, roads];
}

function covers(db, da, maxLen = Infinity) {
  for (const [k, v] of da) if ([...k].length < maxLen && (db.get(k) || 0) < v) return false;
  return true;
}

/**
 * 地址 a 是否就是地址 b。名片辨識常把順序弄反、郵遞區號和國名混在裡面，
 * 所以先比「路名＋門牌號（號前面的數字）」，兩個都對得上就算同一個地址；比不出來才比全部數字。
 */
export function same_address(a, b) {
  const ra2 = addr_tokens(a)[1];
  const rb2 = addr_tokens(b)[1];
  const ha = py.findall(HAO, a || "");
  const hb = py.findall(HAO, b || "");
  if (ra2.size && rb2.size && ha.length && hb.length) {
    const road = [...ra2].some((x) => [...rb2].some((y) => y.includes(x) || x.includes(y)));
    if (road && ha.some((h) => hb.includes(h))) return true;
    // 名片辨識把「11-1號」拆成「1號 11」這種，比數字（「11-1」拆成 11 和 1）
    const da = py.counter(py.findall(String.raw`\d+`, a || ""));
    const db = py.counter(py.findall(String.raw`\d+`, b || ""));
    return road && da.size > 0 && covers(db, da, 5);
  }
  const [da, ra] = addr_tokens(a);
  const [db, rb] = addr_tokens(b);
  if (!da.size && !ra.size) return R.norm_text(a) === R.norm_text(b);
  const nums_ok = covers(db, da);
  const joined = [...rb].join("");
  const road_ok = !ra.size || [...ra].some((x) => joined.includes(x) || [...rb].some((y) => y.includes(x) || x.includes(y)));
  return nums_ok && road_ok && (da.size > 0 || ra.size > 0);
}

function phoneKey(x) {
  const a = R.normalize_phone(x.value || "", x.type, "公司");
  return [a.key || py.sub(String.raw`\D`, "", x.value || ""), a.ext || ""];
}

/** 這筆聯絡人所有電話的比對鍵（「數字|分機」）。 */
export function phone_keys(p) {
  return new Set(items(p, "phoneNumbers").map((x) => phoneKey(x).join("|")));
}

export function emails(p) {
  return new Set(items(p, "emailAddresses").filter((x) => x.value).map((x) => R.norm_email(x.value)));
}

export function orgs(p) {
  const out = new Set(items(p, "organizations").filter((x) => x.name).map((x) => R.norm_text(R.company_short(x.name))));
  out.delete("");
  return out;
}

export function note(p) {
  return py.strip(items(p, "biographies").map((x) => py.strip(x.value || "")).join("\n"));
}

export function has_photo(p) {
  return items(p, "photos").some((x) => !x.default);
}

function withoutMeta(x) {
  return JSON.stringify(Object.fromEntries(Object.entries(x).filter(([k]) => k !== "metadata")));
}

/** p 那筆有、q 那筆沒有的資料。回傳：欄位 → 清單（備註只回「有」，不回內容）。 */
export function extras(p, q) {
  const out = {};
  const pk = phone_keys(q);
  const pk_main = new Set([...pk].map((k) => k.split("|")[0]));

  const phone_new = (x) => {
    const k = phoneKey(x);
    if (pk.has(k.join("|"))) return false;
    // 這支沒寫分機、對方同號碼有分機，算同一支
    return !(!k[1] && pk_main.has(k[0]));
  };
  const ph = items(p, "phoneNumbers").filter(phone_new).map((x) => x.value || "");
  if (ph.length) out["電話"] = ph;
  const qe = emails(q);
  const em = items(p, "emailAddresses").filter((x) => x.value && !qe.has(R.norm_email(x.value))).map((x) => x.value);
  if (em.length) out["Email"] = em;
  const qa = items(q, "addresses").map((x) => x.formattedValue || "");
  const ad = items(p, "addresses")
    .filter((x) => !qa.some((b) => same_address(x.formattedValue || "", b)))
    .map((x) => x.formattedValue || "");
  if (ad.length) out["地址"] = ad;
  const qo = orgs(q);
  const og = items(p, "organizations")
    .filter((x) => {
      if (!x.name || R.is_placeholder(x.name)) return false;
      const n = R.norm_text(R.company_short(x.name));
      return ![...qo].some((y) => y.includes(n) || n.includes(y));
    })
    .map((x) => x.name);
  if (og.length) out["公司"] = og;
  if (note(p) && !note(q).includes(note(p))) out["備註"] = ["有（公司那筆沒有這段）"];
  if (has_photo(p) && !has_photo(q)) out["照片"] = ["有（公司那筆沒有）"];
  for (const [f, lab] of [["birthdays", "生日"], ["urls", "網址"], ["events", "紀念日"], ["relations", "關係"],
    ["userDefined", "自訂欄位"], ["nicknames", "暱稱"]]) {
    const qv = new Set(items(q, f).map(withoutMeta));
    const pv = items(p, f).filter((x) => !qv.has(withoutMeta(x)));
    if (pv.length) out[lab] = pv.map((x) => x.value || x.formattedValue || String(x.date ?? ""));
  }
  return out;
}

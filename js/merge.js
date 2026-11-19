// 「更新這一筆」：把名片上有、現有那筆沒有的資料補進去（純計算，不連網路）。
//
// 規矩（需求報告第 6 節、規則文件 9.2、13、14）：
// - 只補缺的，不覆蓋現有內容；不改現有姓名；不動標籤；備註絕對不寫入。
// - 內容互相衝突的（例如職稱不同）列出來讓使用者選，沒選就是「保留現有的」。
// - 同一支號碼、同一個 Email、同一個地址、同一家公司，判斷方式和通訊錄整理時相同（twoacct.js、rules.js）。
// - 要送給 Google 的內容由 apply_plan 組出來：有變動的欄位才放進遮罩，而且該欄現有的項目要原樣一起送回去（整欄替換）。
import { clean_fv } from "./gcontact.js";
import * as GC from "./gcontact.js";
import * as py from "./pyre.js";
import * as R from "./rules.js";
import { same_address } from "./twoacct.js";
import * as W from "./writer.js";

/** 名片 App 修改現有聯絡人時，允許寫入的欄位。姓名、標籤、備註都不在裡面。 */
export const APP_MASK = ["phoneNumbers", "emailAddresses", "addresses", "organizations", "urls", "nicknames", "userDefined"];
/** 寫入前後要核對的欄位：允許寫入的，加上絕對不該變的姓名和備註。 */
export const APP_CHECK = ["names", ...APP_MASK, "biographies"];
export const FIELD_LABEL = {
  names: "姓名", phoneNumbers: "電話", emailAddresses: "Email", addresses: "地址", organizations: "公司",
  urls: "網站", nicknames: "英文姓名", userDefined: "統編", biographies: "備註",
};
const TYPE_ZH = { mobile: "手機", work: "公司", workFax: "傳真", home: "住家" };

function phoneKey(x) {
  const r = R.normalize_phone(x.value || "", x.type, "公司");
  return [r.key || py.sub(String.raw`\D`, "", x.value || ""), r.ext || ""];
}

/** 是不是同一家公司（規則文件 8.1）：去掉「有限公司」等字後相同，或一個包含另一個而且至少 4 個字。 */
export function same_company(a, b) {
  const x = R.norm_text(R.company_short(a || ""));
  const y = R.norm_text(R.company_short(b || ""));
  if (!x || !y) return false;
  if (x === y) return true;
  const [s, l] = [...x].length <= [...y].length ? [x, y] : [y, x];
  return [...s].length >= 4 && l.includes(s);
}

const same_text = (a, b) => R.norm_text(a || "") === R.norm_text(b || "");
const norm_url = (u) => py.strip(u || "").toLowerCase().replace(/\/+$/, "");

/**
 * 比對名片和現有那一筆，列出要怎麼補。
 * card：表單收來的名片資料（格式同 gcontact.build_person，可帶 photoLinks）；person：現有那一筆的完整資料。
 * 回傳：
 *   adds      要新增的項目：[{ field, item, label, text }]
 *   fills     現有項目裡空著的格子要補的：[{ field, index, key, value, label, text }]（index 是該欄聯絡人來源項目的順序）
 *   conflicts 內容不一樣、要使用者選的：[{ id, field, index, key, label, current, proposed, options: [{ key, text }] }]
 *   notes     不會做、但要讓使用者知道的事
 *   existing  現有那一筆的顯示名稱
 */
export function plan_update(card, person) {
  const { body } = GC.build_person(card);
  const adds = [];
  const fills = [];
  const conflicts = [];
  const notes = [];
  const add = (field, item, label, text) => adds.push({ field, item, label, text });

  // 電話：號碼（含分機）相同就算已經有；現有的同號碼有分機、名片沒寫分機，也算已經有
  const havePhones = W.contact_items(person, "phoneNumbers");
  const keys = havePhones.map(phoneKey);
  for (const p of body.phoneNumbers || []) {
    const k = phoneKey(p);
    const i = keys.findIndex((e) => e[0] === k[0] && (e[1] === k[1] || !k[1]));
    if (i < 0) {
      add("phoneNumbers", p, "電話", `${p.value}（${TYPE_ZH[p.type] || p.type}）`);
      keys.push(k);
      continue;
    }
    // 號碼相同但類型不同：不自動改（規則文件 5.3），只提醒
    const was = R.map_type(havePhones[i]?.type);
    const now = R.map_type(p.type);
    if (havePhones[i] && was && now && was !== now) notes.push(`電話 ${p.value}：現有那筆標成「${was}」，名片上是「${now}」。沒有更動，請您自己確認。`);
  }

  const haveMails = new Set(W.contact_items(person, "emailAddresses").map((x) => R.norm_email(x.value)));
  for (const e of body.emailAddresses || []) {
    if (!haveMails.has(R.norm_email(e.value))) {
      add("emailAddresses", e, "Email", e.value);
      haveMails.add(R.norm_email(e.value));
    }
  }

  // 地址：路名＋門牌相同就算同一個（兩個方向都比）
  const haveAddrs = W.contact_items(person, "addresses").map((x) => clean_fv(x.formattedValue));
  for (const a of body.addresses || []) {
    if (!haveAddrs.some((b) => same_address(a.formattedValue, b) || same_address(b, a.formattedValue))) {
      add("addresses", a, "地址", a.formattedValue);
    }
  }

  // 公司欄
  const org = (body.organizations || [])[0];
  if (org) {
    const have = W.contact_items(person, "organizations");
    let idx = org.name ? have.findIndex((x) => same_company(x.name, org.name)) : -1;
    let fillName = false;
    if (idx < 0 && have.length === 1 && (!org.name || !have[0].name)) {
      // 名片只有職稱沒有公司 → 接到現有唯一的那家；現有唯一那欄只有職稱沒有公司 → 把公司名補上去
      idx = 0;
      fillName = Boolean(org.name) && !have[0].name;
    }
    if (idx < 0 && !org.name && have.length > 1) {
      notes.push("名片上的職稱沒有寫是哪一家公司，而現有那筆有兩家以上的公司，所以沒有補。請您自己確認要放哪一家。");
    } else if (idx < 0) {
      add("organizations", org, "公司", [org.name, org.department, org.title].filter(Boolean).join("　"));
    } else {
      const cur = have[idx];
      if (fillName) fills.push({ field: "organizations", index: idx, key: "name", value: org.name, label: "公司名稱", text: org.name });
      for (const [key, label] of [["department", "部門"], ["title", "職稱"]]) {
        const mine = org[key];
        const theirs = R.is_placeholder(cur[key]) ? "" : py.strip(cur[key] || "");
        if (!mine || same_text(mine, theirs)) continue;
        if (!theirs) {
          fills.push({ field: "organizations", index: idx, key, value: mine, label, text: mine });
        } else {
          conflicts.push({
            id: `organizations.${idx}.${key}`, field: "organizations", index: idx, key, label, current: theirs, proposed: mine,
            options: [
              { key: "keep", text: `保留現有的「${theirs}」` },
              { key: "replace", text: `改成名片上的「${mine}」` },
              { key: "both", text: `兩個都留：「${theirs}、${mine}」` },
            ],
          });
        }
      }
    }
  }

  // 網站：公司網站沒有才補；名片照片的連結每次都加（是這一次拍的照片）
  const haveUrls = new Set(W.contact_items(person, "urls").map((x) => norm_url(x.value)));
  for (const u of body.urls || []) {
    if (u.type === "work") {
      if (!haveUrls.has(norm_url(u.value))) add("urls", u, "網站", u.value);
    } else {
      add("urls", u, "照片連結", `${u.type}（這次拍的照片）`);
    }
  }

  // 英文姓名（暱稱）
  const nick = (body.nicknames || [])[0];
  if (nick) {
    const have = W.contact_items(person, "nicknames");
    if (!have.length) {
      add("nicknames", nick, "英文姓名", nick.value);
    } else if (!have.some((x) => same_text(x.value, nick.value))) {
      conflicts.push({
        id: "nicknames.0.value", field: "nicknames", index: 0, key: "value", label: "英文姓名", current: have[0].value, proposed: nick.value,
        options: [{ key: "keep", text: `保留現有的「${have[0].value}」` }, { key: "replace", text: `改成名片上的「${nick.value}」` }],
      });
    }
  }

  // 統編（自訂欄位「統編」）
  const tax = (body.userDefined || [])[0];
  if (tax) {
    const have = W.contact_items(person, "userDefined");
    const idx = have.findIndex((x) => x.key === "統編");
    if (idx < 0) {
      add("userDefined", tax, "統編", tax.value);
    } else if (py.strip(have[idx].value || "") !== tax.value) {
      conflicts.push({
        id: `userDefined.${idx}.value`, field: "userDefined", index: idx, key: "value", label: "統編", current: have[idx].value, proposed: tax.value,
        options: [{ key: "keep", text: `保留現有的「${have[idx].value}」` }, { key: "replace", text: `改成名片上的「${tax.value}」` }],
      });
    }
  }

  if (py.strip(card.note || "")) {
    notes.push("您在表單填的備註不會寫進去：現有那筆的備註一個字都不動。需要的話，請您自己到聯絡人裡補上。");
  }

  const n = W.contact_items(person, "names")[0] || {};
  return { adds, fills, conflicts, notes, existing: n.displayName || n.givenName || "" };
}

/** 這份計畫有沒有東西要寫（衝突全部選「保留現有的」時，就只看新增和補空格）。 */
export function has_changes(plan, choices = {}) {
  return plan.adds.length > 0 || plan.fills.length > 0 || plan.conflicts.some((c) => (choices[c.id] || "keep") !== "keep");
}

/**
 * 依計畫和使用者的選擇，組出要送給 Google 的 [遮罩, 內容]。
 * person_now：送出前「剛剛重新讀取」的那一筆（etag 用它的）。choices：{ 衝突的 id: "keep" | "replace" | "both" }。
 * 沒有變動的欄位不放進遮罩；有變動的欄位，現有的項目原樣送回、新的接在後面。
 */
export function apply_plan(person_now, plan, choices = {}) {
  const body = { etag: person_now.etag, metadata: { sources: [W.contact_source(person_now)] } };
  const lists = {};
  const list = (f) => (lists[f] ??= W.contact_items(person_now, f).map(W.strip));

  for (const f of plan.fills) {
    const it = list(f.field)[f.index];
    if (!it) throw new W.PlanMismatch(`${FIELD_LABEL[f.field]} 的內容和剛才看到的不同`);
    it[f.key] = f.value;
  }
  for (const c of plan.conflicts) {
    const pick = choices[c.id] || "keep";
    if (pick === "keep") continue;
    const it = list(c.field)[c.index];
    if (!it) throw new W.PlanMismatch(`${FIELD_LABEL[c.field]} 的內容和剛才看到的不同`);
    it[c.key] = pick === "both" ? `${c.current}、${c.proposed}` : c.proposed;
  }
  for (const a of plan.adds) list(a.field).push(structuredClone(a.item));

  const mask = APP_MASK.filter((f) => f in lists);
  for (const f of mask) body[f] = lists[f];
  W.guard(mask, body, APP_MASK);
  return [mask, body];
}

/** 給畫面用：這次實際寫了哪些東西（一行一項）。 */
export function describe_changes(plan, choices = {}) {
  const out = [];
  for (const a of plan.adds) out.push(`補上${a.label}：${a.text}`);
  for (const f of plan.fills) out.push(`補上${f.label}：${f.text}`);
  for (const c of plan.conflicts) {
    const pick = choices[c.id] || "keep";
    if (pick === "replace") out.push(`${c.label}改成「${c.proposed}」（原本是「${c.current}」）`);
    else if (pick === "both") out.push(`${c.label}改成「${c.current}、${c.proposed}」`);
    else out.push(`${c.label}保留現有的「${c.current}」，沒有改`);
  }
  return out;
}

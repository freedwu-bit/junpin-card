// 地址整理成台灣寫法（純規則，不連網路、不讀寫聯絡人）。
//
// 這個檔是 ~/通訊錄整理/程式/address.py 的逐行移植，函式名稱與回傳欄位都和 Python 版相同。
// 使用者 2026-11-16～17 的決定：縣市寫在最前面；盡量補上「區」；統一用「台」不用「臺」。
// 行政區清單：data/districts.js（由 tools/gen_data.py 從原本的 行政區.json 產生）。
import { DISTRICT_ROWS } from "./data/districts.js";
import * as py from "./pyre.js";

let _TABLE = null;

// 舊縣市名 → 現在的名稱（升格直轄市）
export const OLD_CITY = { 台北縣: "新北市", 桃園縣: "桃園市", 台中縣: "台中市", 台南縣: "台南市", 高雄縣: "高雄市" };
const COUNTRY_WORDS = ["中華民國", "台灣省", "台灣", "Taiwan", "TAIWAN", "taiwan", "R.O.C.", "ROC", "TW"];
const _FULL = new Map([..."０１２３４５６７８９－"].map((c, i) => [c, "0123456789-"[i]]));
const CJK = "[\\u4e00-\\u9fff]";

export function table() {
  if (_TABLE === null) {
    const by_city = new Map();
    const by_zip = new Map();
    for (const [city, district, zip] of DISTRICT_ROWS) {
      if (!by_city.has(city)) by_city.set(city, []);
      by_city.get(city).push(district);
      by_zip.set(zip, [city, district]);
    }
    for (const list of by_city.values()) list.sort((a, b) => [...b].length - [...a].length);
    _TABLE = { by_city, by_zip };
  }
  return _TABLE;
}

export function has_cjk(s) {
  for (const ch of s || "") if ("一" <= ch && ch <= "鿿") return true;
  return false;
}

/** 升格前的寫法：中壢區 ← 中壢市；板橋區 ← 板橋市；淡水區 ← 淡水鎮；八里區 ← 八里鄉。 */
function _district_variants(d) {
  const out = [d];
  if (d.endsWith("區") && [...d].length >= 3) for (const x of ["市", "鎮", "鄉"]) out.push(d.slice(0, -1) + x);
  return out;
}

function _reversed(street) {
  const roads = ["路", "街", "大道"].map((x) => street.indexOf(x)).filter((i) => i >= 0);
  const i_road = roads.length ? Math.min(...roads) : -1;
  const i_no = street.indexOf("號");
  const i_floor = street.indexOf("樓");
  return Boolean(
    (i_no >= 0 && i_road >= 0 && i_no < i_road) ||
      (i_floor >= 0 && i_no >= 0 && i_floor < i_no) ||
      py.search(String.raw`樓\d+$`, street) ||
      py.match(String.raw`\d`, street),
  );
}

/**
 * 回傳：status（ok／manual／skip）、new（整理後一行）、city、district、street、zip、
 * district_source（原本就有／依郵遞區號／缺）、notes、reason、suggest。ok 才會改；manual、skip 都不動。
 * garbled：呼叫的人判斷這個地址疑似辨識錯誤（亂碼、簡體字）時傳入原因，這種一律不動、列給使用者。
 */
export function normalize_address(formatted, postal_code = "", country = "", garbled = "") {
  const T = table();
  const cityNames = [...T.by_city.keys()];
  const oldNames = Object.keys(OLD_CITY);
  const out = {
    status: "ok", new: "", city: "", district: "", street: "", zip: "",
    district_source: "", notes: [], reason: "", suggest: "",
  };
  const raw = py.strip(formatted || "");
  const stop = (status, reason) => {
    Object.assign(out, { status, reason });
    return out;
  };

  if (!raw) return stop("skip", "空白");
  if (garbled) return stop("manual", `疑似名片辨識錯誤（${garbled}）`);
  if (!has_cjk(raw)) return stop("skip", "不是中文地址");
  const ctry = py.strip(country || "");
  if (ctry && !["TW", "TAIWAN", "ROC", "R.O.C."].includes(ctry.toUpperCase()) && !["台灣", "臺灣", "中華民國"].includes(ctry)) {
    return stop("skip", `國家不是台灣（${ctry}）`);
  }

  let s = [...raw].map((c) => _FULL.get(c) ?? c).join("");
  const had_tai = s.includes("臺");
  s = s.replaceAll("臺", "台");
  s = py.strip(py.sub(String.raw`[\s,，、]+`, " ", s));

  // 國名：只拿掉「單獨一段」的，或接在縣市前面的；路名裡的字（例如「台灣大道」）不可以動
  const cw = COUNTRY_WORDS.map(py.reEscape).join("|");
  s = py.sub(String.raw`(^|\s)(?:${cw})(?=\s|$)`, " ", s);
  const all_cities = [...cityNames, ...oldNames].join("|");
  s = py.strip(py.sub(String.raw`(^|\s)(?:中華民國)?(?:台灣省|台灣)(?=(?:${all_cities}))`, " ", s));
  // 郵遞區號：欄位裡的，或地址最前面／最後面單獨的 3～6 碼
  // 只認「最前面」「最後面」或「單獨一段」的；門牌號碼剛好和郵遞區號一樣時不可以誤刪
  let z = py.sub(String.raw`\D`, "", postal_code || "");
  if (!z) {
    // 自己從地址裡找到的數字，要對得上地址裡寫的縣市才當成郵遞區號（不然可能是門牌）
    const plausible = (tok) => {
      const hit = T.by_zip.get(tok.slice(0, 3));
      const any_city = [...cityNames, ...oldNames].filter((c) => s.includes(c));
      return Boolean(hit) && (!any_city.length || any_city.map((c) => OLD_CITY[c] ?? c).includes(hit[0]));
    };
    let m = py.match(String.raw`^(\d{3}(?:\d{2,3})?)(?!\d)`, s);
    if (m && has_cjk([...py.strip(s.slice(m[0].length))].slice(0, 1).join("")) && plausible(m[1])) {
      z = m[1];
    } else {
      m = py.search(String.raw`\s(\d{3}(?:\d{2,3})?)$`, s);
      if (m && plausible(m[1])) z = m[1];
    }
  }
  if (z) {
    const zz = py.reEscape(z);
    s = py.sub(String.raw`^${zz}(?!\d)`, " ", s);
    s = py.sub(String.raw`\s${zz}$`, " ", s);
    s = py.strip(py.sub(String.raw`(^|\s)${zz}(?=\s|$)`, " ", s));
  }

  // 縣市
  const found = [];
  for (const [old, nw] of Object.entries(OLD_CITY)) if (s.includes(old)) found.push([old, nw]);
  for (const c of cityNames) {
    // 「桃園縣桃園市…」這種舊寫法，後面的「桃園市」是舊的鄉鎮市名（現在的桃園區），不是縣市
    if (s.includes(c) && !found.some(([, nw]) => nw === c)) found.push([c, c]);
  }
  const cities = [...new Set(found.map(([, nw]) => nw))];
  if (cities.length > 1) return stop("manual", `地址裡出現兩個不同的縣市（${cities.join("、")}）`);
  let city = cities.length ? cities[0] : "";
  for (const [old] of found) {
    s = s.replaceAll(old, " ");
    if (Object.prototype.hasOwnProperty.call(OLD_CITY, old)) out.notes.push(`舊縣市名「${old}」改成「${OLD_CITY[old]}」`);
  }

  // 區
  let zc = z.length >= 3 ? T.by_zip.get(z.slice(0, 3)) || null : null;
  let district = "";
  let source = "";
  const cand_cities = city ? [city] : !zc ? cityNames : [zc[0]];
  const hits = [];
  for (const c of cand_cities) {
    for (const d of T.by_city.get(c)) {
      for (const v of _district_variants(d)) {
        // 要出現在開頭（或前面是空白）才算，避免把路名裡的字當成區
        if (py.search(String.raw`(?:^|\s)${py.reEscape(v)}`, s)) {
          hits.push([c, d, v]);
          break;
        }
      }
    }
  }
  if (city && hits.length) {
    // 同一個縣市裡取最長的那個（清單已由長到短）
    const [, d, v] = hits[0];
    district = d;
    s = py.sub(String.raw`(^|\s)${py.reEscape(v)}`, " ", s, 1);
    source = "原本就有";
    if (v !== district) out.notes.push(`「${v}」改成現在的名稱「${district}」`);
  } else if (!city && new Set(hits.map(([c, d]) => c + "\u0000" + d)).size === 1) {
    const [c, d, v] = hits[0];
    district = d;
    city = c;
    s = py.sub(String.raw`(^|\s)${py.reEscape(v)}`, " ", s, 1);
    source = "原本就有";
    out.notes.push(`原本沒寫縣市，依「${district}」補上「${city}」`);
  }
  // 拿掉縣市和區之後，開頭如果還有數字或英文字母：是這個縣市的郵遞區號就拿掉，其他的看不懂、不硬改
  let m = py.match(String.raw`^\s*([\dA-Za-z][\dA-Za-z\s\-]*?)\s*(?=${CJK})`, s);
  if (m && "樓號巷弄段鄰之".includes(s.slice(m[0].length, m[0].length + 1))) {
    m = null; // 「5樓 130號 松山路」這種是順序反了，交給後面的檢查
  }
  if (m) {
    const lead = py.sub(String.raw`\s`, "", m[1]);
    const lz =
      py.fullmatch(String.raw`\d{3}(\d{2,3})?`, lead) && !py.strip(m[1]).includes(" ")
        ? T.by_zip.get(lead.slice(0, 3)) || null
        : null;
    if (lz && city && lz[0] === city) {
      s = s.slice(m[0].length);
      if (!z) {
        z = lead;
        zc = lz;
      }
    } else {
      return stop("manual", `開頭有看不懂的字（${py.strip(m[1])}）`);
    }
  }
  if (zc) {
    if (!city) {
      city = zc[0];
      out.notes.push(`原本沒寫縣市，依郵遞區號 ${z.slice(0, 3)} 補上「${city}」`);
    }
    if (city === zc[0] && !district) {
      district = zc[1];
      source = "依郵遞區號";
      out.notes.push(`依郵遞區號 ${z.slice(0, 3)} 補上「${district}」`);
    } else if (city !== zc[0] || district !== zc[1]) {
      out.notes.push(`郵遞區號 ${z.slice(0, 3)} 對到的是「${zc[0]}${zc[1]}」，和地址寫的不一樣，以地址寫的為準`);
    }
  }
  if (!city) return stop("manual", "找不到縣市");

  for (const d of T.by_city.get(city)) {
    if (d !== district && s.includes(d)) return stop("manual", `地址中間還有「${d}」，前面可能夾了看不懂的字`);
  }
  let street = py.sub(String.raw`\s+`, "", s);
  street = py.strip(street, "-、,，.。;；");
  if (!street) return stop("manual", "只有縣市，沒有路名門牌");
  if (!py.search("[路街道段巷弄號村里鄰]", street)) return stop("manual", "路名門牌的部分看不懂");
  // 順序是反的（樓、號寫在路名前面，或樓寫在號前面）：不硬改，列給使用者
  if (_reversed(street)) {
    // 把各段倒過來排看看；排得通就當成建議（仍然不自動改，要使用者同意）
    const parts = py.splitWs(s);
    const rev = [...parts].reverse().join("");
    if (parts.length >= 2 && !_reversed(rev) && py.match(CJK, rev)) out.suggest = city + district + rev;
    Object.assign(out, { city, district, zip: z });
    return stop("manual", "順序看起來是反的（樓或號寫在路名前面）");
  }
  if (had_tai) out.notes.push("「臺」改成「台」");
  if (!district) source = "缺";
  Object.assign(out, { new: city + district + street, city, district, street, zip: z, district_source: source });
  return out;
}

// 通訊錄規則（姓名、類別、電話、第三段建議、亂碼與簡體字判斷）。全部是純計算，不連 Google。
//
// 這個檔是 ~/通訊錄整理/程式/rules.py 的逐行移植，函式名稱、回傳的欄位名稱都和 Python 版相同，
// 方便對照。和 Python 版唯一刻意不同的地方：NO_FILL_CATEGORIES 多了「建築師」
// （使用者 2026-11-18 決定：建築師缺第三段預設不補；規則文件 3.3）。
// 自動測試在 tests/，另有 tests/parity.test.mjs 拿同一批輸入和 Python 版逐項比對。
import { BIG5_RUNS } from "./data/big5.js";
import * as py from "./pyre.js";

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export const DASHES = "-－–—‐‑﹣";
export const UNDERS = "_＿";
export const SEPS = DASHES + UNDERS;

// 類別合併（使用者已決定）
export const CATEGORY_MERGE = {
  材料: "廠商", 廠商: "廠商",
  事務所: "建築師", 建築師: "建築師",
  銀行: "財務", 會計師: "財務", 會計: "財務", 財務顧問: "財務", 財務: "財務",
  代書: "代書", 律師: "律師",
  // 使用者 2026-11-17 在「4 類別清單」的決定：
  協力: "顧問", 協力廠商: "顧問", 長照: "顧問", 行銷: "顧問",
  估價師: "財務", 媒體: "其他", 工程: "室內", 建經: "建設",
};
// 其他維持原名的類別（資料裡實際出現過的）。「中華」「道」已搬到私人帳號，公司帳號不再使用。
export const KEEP_CATEGORIES = new Set([
  "技師", "業主", "雋品", "營造", "設計", "代銷", "資訊", "政治",
  "建設", "顧問", "室內", "公部門", "其他", "中華", "道",
]);
export const KNOWN_CATEGORIES = new Set([...Object.keys(CATEGORY_MERGE), ...KEEP_CATEGORIES]);

// 公司帳號現在的 18 個類別（規則文件 3.2，依人數排列）。名片 App 的下拉選單用這一份。
export const COMPANY_CATEGORIES = [
  "廠商", "技師", "業主", "建築師", "雋品", "顧問", "營造", "公部門", "財務",
  "室內", "設計", "建設", "代書", "律師", "代銷", "資訊", "政治", "其他",
];

export function is_cjk(ch) {
  return ("一" <= ch && ch <= "鿿") || ("㐀" <= ch && ch <= "䶿");
}

/** 字串裡有沒有至少兩個漢字（用來挑中文公司名）。 */
export function is_cjk_text(s) {
  let n = 0;
  for (const c of s || "") if (is_cjk(c)) n++;
  return n >= 2;
}

export function all_cjk(s) {
  if (!s) return false;
  for (const c of s) if (!is_cjk(c)) return false;
  return true;
}

export function merge_category(cat) {
  return has(CATEGORY_MERGE, cat) ? CATEGORY_MERGE[cat] : cat;
}

function _norm_dash(s) {
  let out = "";
  for (const c of s) out += DASHES.includes(c) ? "-" : UNDERS.includes(c) ? "_" : c;
  return out;
}

/** 第三段照原樣，只去掉開頭的分隔符號與前後空白。 */
function _clean_third(s) {
  return py.strip(py.lstrip(py.strip(s), SEPS + " 　"));
}

/** 目標格式：整串「類別-姓名_第三段」。 */
export function compose(category, name, third) {
  return (category ? category + "-" : "") + name + (third ? "_" + third : "");
}

function sameNames(a, b) {
  return ["honorificPrefix", "familyName", "middleName", "givenName", "honorificSuffix"].every((k) => a[k] === b[k]);
}

/**
 * 整串寫在「名」那一格，姓氏、前稱謂、後稱謂（與中間名）留空。
 * 回傳的欄位與 Python 版相同：status（ok／manual）、category_raw、category、name、third、whole、
 * new（五個姓名欄位整理後的值）、changed、ask_category、notes、reason、suggestion、name_key、guess。
 */
export function parse_name(prefix, family, middle, given, suffix) {
  const [P, F, M, G, S] = [prefix, family, middle, given, suffix].map((x) => x || "");
  const cur = { honorificPrefix: P, familyName: F, middleName: M, givenName: G, honorificSuffix: S };
  const r = {
    status: "ok", category_raw: "", category: "", name: "", third: "", whole: "",
    new: { ...cur }, changed: false, ask_category: false,
    notes: [], reason: "", suggestion: "", name_key: "", guess: null,
  };

  // guess：[類別, 姓名, 第三段] 的猜測，只用來產生建議文字，絕不自動套用
  const manual = (reason, suggestion = "", name_key = "", guess = null) => {
    Object.assign(r, {
      status: "manual", reason, suggestion, new: { ...cur }, changed: false,
      name_key, whole: "", ask_category: false, guess,
    });
    return r;
  };

  const [p, f, m, g, s] = [P, F, M, G, S].map((x) => py.strip(x));
  if (!(p || f || m || g || s)) return manual("沒有姓名");

  let third = "";
  let cat;
  let name;
  if (p) {
    cat = py.strip(py.rstrip(_norm_dash(p), "-_"));
    name = f + m + g;
    third = _clean_third(s);
    r.notes.push("原本分三格，合併成一串");
    const last = [...p].pop();
    if (UNDERS.includes(last)) r.notes.push("類別後面的「_」改成「-」");
    else if (!DASHES.includes(last)) r.notes.push("類別後面補上「-」");
    if (s && !s.startsWith("_")) r.notes.push("第三段前面統一成「_」");
    if (!KNOWN_CATEGORIES.has(cat)) return manual(`前稱謂「${p}」不是出現過的類別`, "", name);
    if ([...name].some((c) => SEPS.includes(c))) return manual("有前稱謂，但姓名欄裡還有「-」或「_」", "", name);
  } else {
    const whole = _norm_dash(f + m + g);
    cat = "";
    name = whole;
    if (whole.includes("-")) {
      let [seg1, rest] = py.split1(whole, "-");
      seg1 = py.strip(seg1);
      rest = py.strip(rest);
      if (KNOWN_CATEGORIES.has(seg1)) {
        cat = seg1;
        const mm = py.search("[-_]", rest);
        if (mm) {
          name = py.strip(rest.slice(0, mm.index));
          third = _clean_third(rest.slice(mm.index));
          if (rest[mm.index] === "-") r.notes.push("姓名和第三段之間的「-」改成「_」");
        } else {
          name = rest;
        }
      } else {
        const is_person = all_cjk(seg1) && [...seg1].length >= 2 && [...seg1].length <= 4;
        let sug = "";
        if (is_person) sug = `若「${seg1}」是人名、沒有類別：寫成「${compose("", seg1, _clean_third(rest))}」`;
        return manual(
          `第一段「${seg1}」不是出現過的類別，無法確定怎麼切`, sug,
          all_cjk(seg1) ? seg1 : "",
          is_person ? ["", seg1, _clean_third(rest)] : null,
        );
      }
    } else if (whole.includes("_")) {
      [name, third] = py.split1(whole, "_");
      name = py.strip(name);
      third = _clean_third(third);
    }
    if (s) {
      if (third) return manual("姓名欄裡已有第三段，後稱謂欄又有內容", "", name);
      third = _clean_third(s);
      r.notes.push("後稱謂接到姓名後面");
    }
    if ((f || m) && g) r.notes.push("姓、名兩格合併寫進「名」那一格");
    else if (f || m) r.notes.push("從姓氏欄搬到「名」那一格");
  }

  const merged = cat ? merge_category(cat) : "";
  if (cat && merged !== cat) r.notes.push(`類別「${cat}」統一為「${merged}」`);
  const whole_new = compose(merged, name, third);
  const nw = { honorificPrefix: "", familyName: "", middleName: "", givenName: whole_new, honorificSuffix: "" };
  Object.assign(r, { category_raw: cat, category: merged, name, third, name_key: name });
  const changed = !sameNames(nw, cur);
  if (!name) return manual("切完之後沒有姓名", "", "");
  if (changed && !all_cjk(name)) {
    const paren = py.match(String.raw`^([一-鿿]{2,4})\s*[(（]\s*(.+?)\s*[)）]$`, name);
    if (paren && !third) {
      const sug = `若括號內容當第三段：寫成「${compose(merged, paren[1], paren[2])}」`;
      return manual("姓名後面有括號", sug, paren[1], [merged, paren[1], paren[2]]);
    }
    let why;
    if (py.search("[A-Za-z]", name)) why = "姓名含英文字母（可能是外文姓名）";
    else if (py.search(String.raw`\s`, name)) why = "姓名中間有空白";
    else why = "姓名含符號或數字";
    const sug = cat || third ? `若照規則：寫成「${whole_new}」` : "";
    return manual(why, sug, name, cat || third ? [merged, name, third] : null);
  }
  if (!changed) r.notes = [];
  else if (whole_new !== G && !r.notes.length) r.notes.push("去掉多餘的空白");
  r.whole = whole_new;
  r.new = nw;
  r.changed = changed;
  r.ask_category = Boolean(third && !cat);
  return r;
}

// ---------- 電話 ----------

export const TYPE_MAP = {
  mobile: "手機", cell: "手機", 行動裝置: "手機", 行動電話: "手機", 手機: "手機",
  workmobile: "手機", iphone: "手機",
  work: "公司", 工作: "公司", 公司: "公司", main: "公司", 專線: "公司",
  workfax: "傳真", "work fax": "傳真", homefax: "傳真", "home fax": "傳真",
  otherfax: "傳真", fax: "傳真", 傳真: "傳真",
};
// 區碼 → 可接受的市內號碼長度（比對時先試長的區碼）
export const AREA_CODES = [
  ["0836", [5]], ["037", [6]], ["049", [7]], ["089", [6]], ["082", [6]],
  ["02", [8]], ["03", [7]], ["04", [7, 8]], ["05", [7]], ["06", [7]], ["07", [7]], ["08", [7]],
];
const _EXT_RE = String.raw`^(?P<main>[\d\s\-\(\)\+\.]+?)\s*(?P<sep>[,，;；]+|#|[xXpP]|[eE][xX][tT]\.?|轉|分機)\s*[:：.#]?\s*(?P<ext>\d{1,6})\s*$`;
const _PLAIN_RE = String.raw`^[\d\s\-\(\)\+\.]+$`;
const NON_DIGIT = String.raw`\D`;

/** 分機前面的符號。使用者 2026-11-16、11-17 決定：一律一個半形逗號。 */
export function ext_separator(_original) {
  return ",";
}

export function map_type(raw) {
  const k = py.strip(raw || "").toLowerCase();
  return has(TYPE_MAP, k) ? TYPE_MAP[k] : "";
}

function _fmt_local(local) {
  if (local.length === 8) return local.slice(0, 4) + "-" + local.slice(4);
  if (local.length === 7) return local.slice(0, 3) + "-" + local.slice(3);
  if (local.length === 6) return local.slice(0, 3) + "-" + local.slice(3);
  return local;
}

/**
 * 回傳：status（ok／manual）、new_value、new_type（手機／公司／傳真，manual 時可能是 ''）、
 * key（比對用：數字，含區碼，不含分機）、ext（分機）、kind（mobile／landline／tollfree／''）、reason、notes。
 * default_landline_type：市話的類型判斷不出來時要用的類型；給 '' 就列入人工判斷。公司帳號用「公司」。
 */
export function normalize_phone(value, raw_type, default_landline_type = "") {
  const v = py.strip(value || "");
  const out = {
    status: "ok", new_value: value || "", new_type: map_type(raw_type), key: "",
    kind: "", ext: "", ext_sep: "", reason: "", notes: [],
  };
  const manual = (reason) => {
    Object.assign(out, { status: "manual", reason, new_value: value || "" });
    return out;
  };

  let body = v.replaceAll("－", "-").replaceAll("（", "(").replaceAll("）", ")").replaceAll("＃", "#");
  body = py.sub(String.raw`[,，;；\s]+$`, "", body);
  let ext = "";
  let sep = "";
  const m = py.match(_EXT_RE, body);
  if (m) {
    body = m.groups.main;
    ext = m.groups.ext;
    sep = ext_separator(m.groups.sep);
    const joined = py.sub(NON_DIGIT, "", body) + ext;
    if (py.match(String.raw`^09\d{8}$`, joined) && py.sub(NON_DIGIT, "", body).startsWith("09")) {
      // 例如「0912345,,678」：手機號碼中間被插了逗號，合起來剛好是 10 碼手機
      body = joined;
      ext = "";
      sep = "";
      out.notes.push("號碼中間多了符號，合起來是 10 碼手機");
    }
  } else if (!py.match(_PLAIN_RE, body || " ")) {
    out.key = py.sub(NON_DIGIT, "", body);
    return manual("含有不是電話號碼的文字或符號");
  }
  let d = py.sub(NON_DIGIT, "", body);
  out.ext = ext;
  out.ext_sep = sep;
  if (!d) return manual("沒有數字");
  if (body.includes("+") || (d.startsWith("886") && (d.length === 11 || d.length === 12))) {
    if (d.startsWith("886")) {
      d = d.slice(3);
      if (!d.startsWith("0")) d = "0" + d;
      out.notes.push("+886 轉回 0 開頭");
    } else {
      out.key = d;
      return manual("國外號碼（不是 +886），保留原樣");
    }
  }
  out.key = d;
  if (py.match(String.raw`^09\d{8}$`, d)) {
    if (ext) return manual("手機號碼後面帶了分機");
    out.kind = "mobile";
    out.new_value = `${d.slice(0, 4)}-${d.slice(4, 7)}-${d.slice(7)}`;
    if (out.new_type !== "手機") out.notes.push("09 開頭一律歸為手機");
    out.new_type = "手機";
    return out;
  }
  if (d.startsWith("09")) return manual("09 開頭但不是 10 碼");
  if (d.startsWith("070") && d.length === 11) return manual("070 開頭的網路電話，保留原樣");
  if (py.match(String.raw`^080[09]\d{6}$`, d)) {
    out.kind = "tollfree";
    out.new_value = `${d.slice(0, 4)}-${d.slice(4, 7)}-${d.slice(7)}` + (ext ? sep + ext : "");
    if (out.new_type !== "公司" && out.new_type !== "傳真") out.new_type = "公司";
    return out;
  }
  if (!d.startsWith("0")) {
    if (d.length === 8) return manual("8 碼、沒有區碼（可能是市話少了區碼，也可能是統編）");
    return manual("不是 0 開頭，看不出是哪裡的號碼");
  }
  let hit = false;
  for (const [code, lens] of AREA_CODES) {
    if (d.startsWith(code) && lens.includes(d.length - code.length)) {
      out.kind = "landline";
      out.new_value = code + "-" + _fmt_local(d.slice(code.length)) + (ext ? sep + ext : "");
      hit = true;
      break;
    }
  }
  if (!hit) return manual("號碼長度和區碼對不起來");
  if (out.new_type === "手機") {
    if (default_landline_type) {
      out.new_type = default_landline_type;
      out.notes.push(`市話號碼原本標成手機，改歸「${default_landline_type}」`);
    } else {
      out.new_type = "";
      out.status = "manual";
      out.reason = "市話號碼卻標成手機，類型請您決定（號碼格式可照建議）";
    }
  } else if (!out.new_type) {
    const shown = py.strip(raw_type || "沒有標");
    if (default_landline_type) {
      out.new_type = default_landline_type;
      out.notes.push(`原本標成「${shown}」，歸「${default_landline_type}」`);
    } else {
      out.status = "manual";
      out.reason = `原本標成「${shown}」，無法判斷是公司還是傳真（號碼格式可照建議）`;
    }
  }
  return out;
}

export const CITY_AREA = [
  ["台北", "02"], ["臺北", "02"], ["新北", "02"], ["基隆", "02"], ["桃園", "03"], ["新竹", "03"], ["宜蘭", "03"],
  ["花蓮", "03"], ["苗栗", "037"], ["台中", "04"], ["臺中", "04"], ["彰化", "04"], ["南投", "049"], ["嘉義", "05"],
  ["雲林", "05"], ["台南", "06"], ["臺南", "06"], ["澎湖", "06"], ["高雄", "07"], ["屏東", "08"], ["台東", "089"],
  ["臺東", "089"], ["金門", "082"],
];

// Python 的 int() 認得全形數字；這裡只處理一般數字與全形數字，其他寫法的數字一律當成不符合。
function digitValue(ch) {
  const c = ch.codePointAt(0);
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0xff10 && c <= 0xff19) return c - 0xff10;
  return NaN;
}

/** 8 碼是否符合統一編號的檢查碼。只是線索：隨便一組 8 碼也有大約兩成會符合，不能單憑它判定。 */
export function looks_like_tax_id(digits) {
  const d = digits || "";
  if (!py.fullmatch(String.raw`\d{8}`, d)) return false;
  const ds = [...d];
  const weights = [1, 2, 1, 2, 1, 2, 4, 1];
  let total = 0;
  for (let i = 0; i < 8; i++) {
    const p = digitValue(ds[i]) * weights[i];
    if (Number.isNaN(p)) return false;
    total += Math.floor(p / 10) + (p % 10);
  }
  return total % 5 === 0 || (ds[6] === "7" && (total + 1) % 5 === 0);
}

/**
 * 沒有區碼的市話：依同一筆聯絡人的其他市話或地址，猜區碼。只是建議，絕不自動套用。
 * 回傳 [建議的完整號碼, 依據]；猜不出來回傳 ['', '']。
 */
export function guess_area_code(digits, other_landline_keys = [], address_texts = []) {
  digits = py.sub(NON_DIGIT, "", digits || "");
  if (!digits || digits.startsWith("0")) return ["", ""];
  const lens = new Map(AREA_CODES);
  const cands = [];
  for (const k of other_landline_keys) {
    for (const [code, ls] of AREA_CODES) {
      if (k.startsWith(code) && ls.includes(k.length - code.length)) {
        cands.push([code, `同一筆的其他市話是 ${code} 開頭`]);
        break;
      }
    }
  }
  for (const t of address_texts) {
    for (const [city, code] of CITY_AREA) {
      if ((t || "").includes(city)) {
        cands.push([code, `地址在${city}`]);
        break;
      }
    }
  }
  for (const [code, why] of cands) {
    if (lens.get(code).includes(digits.length)) return [code + "-" + _fmt_local(digits), why];
  }
  return ["", ""];
}

// ---------- 比對用的正規化 ----------

export function norm_text(s) {
  return py.sub(String.raw`[\s\-－–—_．.・,，、()（）]`, "", s || "").toLowerCase();
}

export function norm_email(s) {
  return py.strip(s || "").toLowerCase();
}

// Python difflib.SequenceMatcher(None, a, b).ratio() 的移植
export function similar(a, b) {
  const A = [...a];
  const B = [...b];
  const b2j = new Map();
  B.forEach((ch, j) => {
    if (!b2j.has(ch)) b2j.set(ch, []);
    b2j.get(ch).push(j);
  });
  if (B.length >= 200) {
    const ntest = Math.floor(B.length / 100) + 1;
    for (const [ch, idxs] of [...b2j]) if (idxs.length > ntest) b2j.delete(ch);
  }
  const longest = (alo, ahi, blo, bhi) => {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const nw = new Map();
      for (const j of b2j.get(A[i]) || []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        nw.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = nw;
    }
    // 和 difflib 一樣：把被當成「太常見」而略過的字，往前後接回去
    while (besti > alo && bestj > blo && A[besti - 1] === B[bestj - 1]) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && A[besti + bestsize] === B[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  };
  let matches = 0;
  const queue = [[0, A.length, 0, B.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (k) {
      matches += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  const total = A.length + B.length;
  return total ? (2.0 * matches) / total : 1.0;
}

function _addr_chars(s) {
  s = norm_text(s).replaceAll("臺", "台").replaceAll("f", "樓").replaceAll("·", "");
  return py.counter([...s]);
}

/**
 * 比較同一筆聯絡人的兩個地址（不管字的順序）。
 * 回傳 'same'、'a_more'／'b_more'（一個只是多了幾個字）、'near'（很像但有不同的字）、''（不像）。
 */
export function address_relation(a, b) {
  const ca = _addr_chars(a);
  const cb = _addr_chars(b);
  const na = py.counterTotal(ca);
  const nb = py.counterTotal(cb);
  if (!na || !nb) return "";
  if (py.counterEqual(ca, cb)) return "same";
  const common = py.counterCommon(ca, cb);
  if (common === nb && na - nb <= 8) return "a_more";
  if (common === na && nb - na <= 8) return "b_more";
  if (common / Math.max(na, nb) >= 0.8) return "near";
  return "";
}

// ---------- 其他清理 ----------

export const PLACEHOLDERS = new Set(["position not filled yet", "company not filled yet"]);

export function is_placeholder(s) {
  return PLACEHOLDERS.has(py.strip(s || "").toLowerCase());
}

let _big5 = null;
function big5Has(ch) {
  if (_big5 === null) {
    _big5 = new Set();
    for (let i = 0; i < BIG5_RUNS.length; i += 2) {
      for (let k = 0; k < BIG5_RUNS[i + 1]; k++) _big5.add(BIG5_RUNS[i] + k);
    }
  }
  return _big5.has(ch.codePointAt(0));
}

/** 回傳字串裡「只存在於簡體」的字（Big5 編不出來的漢字）。 */
export function simplified_chars(s) {
  const out = [];
  for (const ch of s || "") {
    if (is_cjk(ch) && !big5Has(ch) && !out.includes(ch)) out.push(ch);
  }
  return out;
}

const _GARBAGE_RE =
  "[\\ufffd\\u0000-\\u0008\\u000e-\\u001f\\u25a1\\u25a0\\u25c6\\u25c7\\u25cf\\u25cb\\u2605\\u2606\\u203b\\u00a4\\u00a7\\u00b6]" +
  "|[|\\\\^`<>{}=]|[?\\uff1f!\\uff01]{2,}";

/** 很保守的亂碼判斷：只抓得到明顯的（奇怪符號、取代字元）。回傳原因或 ''。 */
export function looks_garbled(s) {
  s = s || "";
  if (!py.strip(s)) return "";
  if (py.search(_GARBAGE_RE, s)) return "含有不尋常的符號";
  let letters = 0;
  let cjk = 0;
  for (const c of s) {
    if (/[A-Za-z]/.test(c)) letters++;
    if (is_cjk(c)) cjk++;
  }
  if (cjk >= 2 && py.search("[一-鿿][A-Za-z]{1,2}[一-鿿]", s) && letters <= 4) return "中文字中間夾了零星英文字母";
  return "";
}

// ---------- 補齊三段：技師、財務的第三段寫「專長」；其他類別寫「公司名稱」 ----------

export const SPECIALTY_CATEGORIES = new Set(["技師", "財務"]);
export const SPECIALTY_KEYWORDS = {
  技師: ["水土保持", "都市計畫", "冷凍空調", "給排水", "綠建築", "無障礙", "結構", "土木", "大地", "地質",
    "水保", "水土", "水利", "機電", "電機", "消防", "空調", "測量", "都計", "都更", "交通", "環工",
    "環評", "景觀", "地政", "弱電", "估算", "鑽探", "監測", "帷幕", "照明", "鑑定"],
  財務: ["財務顧問", "會計師", "土建融", "會計", "估價", "銀行", "貸款", "土融", "融資", "稅務", "記帳",
    "證券", "保險", "信託", "理財"],
};
// 現有標籤 → 類別（只用在「沒有類別」時提出建議；對不上的不猜）
export const LABEL_TO_CATEGORY = {
  協力技師: "技師", 材料商: "廠商", 營造廠: "營造", 私人業主: "業主", 雋品建築: "雋品",
  事務所: "建築師", 協力商: "顧問", 室內工班: "室內", 建設: "建設", 顧問: "顧問", 公部門: "公部門",
};
const _COMPANY_SUFFIX_RE = String.raw`(股份有限公司|有限公司|（股）公司|\(股\)公司|公司)$`;

/** 從文字裡找出這個類別的專長關鍵字（照出現位置排序、不重複；長的詞優先）。 */
export function specialties_in(text, category) {
  text = text || "";
  const found = [];
  const taken = new Array(text.length).fill(false);
  for (const kw of SPECIALTY_KEYWORDS[category] || []) {
    let start = 0;
    for (;;) {
      const i = text.indexOf(kw, start);
      if (i < 0) break;
      if (!taken.slice(i, i + kw.length).some(Boolean)) {
        for (let j = i; j < i + kw.length; j++) taken[j] = true;
        found.push([i, kw]);
      }
      start = i + 1;
    }
  }
  found.sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [, kw] of found) if (!out.includes(kw)) out.push(kw);
  return out;
}

/** 公司全名 → 簡稱建議（只去掉結尾的「股份有限公司／有限公司／公司」與空白）。 */
export function company_short(name) {
  const s = py.sub(String.raw`\s+`, "", name || "");
  return py.sub(_COMPANY_SUFFIX_RE, "", s);
}

/** 兩段文字有沒有連續兩個字相同（用來判斷第三段是不是取自公司名稱）。 */
export function shares_text(a, b) {
  a = norm_text(a);
  b = norm_text(b);
  const A = [...a];
  if (A.length >= 2) {
    for (let i = 0; i < A.length - 1; i++) if (b.includes(A[i] + A[i + 1])) return true;
    return false;
  }
  return a ? b.includes(a) : false;
}

export const NO_THIRD_CATEGORIES = new Set(["雋品", "建築師", "中華"]); // 缺第三段不算問題
// 連公司欄也不拿來補。Python 版只有「雋品、中華」；「建築師」是使用者 2026-11-18 的決定（規則文件 3.3）。
export const NO_FILL_CATEGORIES = new Set(["雋品", "中華", "建築師"]);

/**
 * 檢查是否三段齊全、第三段是否符合「技師／財務寫專長，其他寫公司」，並提出補齊建議。
 * opts：titles（職稱）、companies（公司名）、labels（標籤）、partners（同一個人的其他紀錄，每筆 [類別, 第三段]）。
 * 回傳：needs（缺什麼）、personal、category、third（建議值）、basis（依據）、whole（建議補齊後的整串）。
 */
export function completion(category, name, third, opts = {}) {
  const { labels = [], partners = [] } = opts;
  let needs = [];
  const basis = [];
  let cat = category;
  let new_third = third;
  const companies = (opts.companies || []).filter((c) => c && !is_placeholder(c));
  const titles = (opts.titles || []).filter((t) => t && !is_placeholder(t));
  // 拿來當第三段的公司名必須看起來乾淨（名片辨識常有亂碼），不乾淨的不拿來補
  const clean_companies = companies.filter(
    (c) => is_cjk_text(c) && !looks_garbled(c) && !simplified_chars(c).length && !py.search("[0-9\\u00b7.\\u2022]", c),
  );
  if (!cat) {
    needs.push("缺類別");
    const pc = partners.filter((p) => p[0]).map((p) => p[0]);
    const lc = labels.filter((l) => has(LABEL_TO_CATEGORY, l)).map((l) => LABEL_TO_CATEGORY[l]);
    if (pc.length) {
      cat = pc[0];
      basis.push(`類別：同一個人的另一筆紀錄是「${cat}」`);
    } else if (lc.length) {
      cat = lc[0];
      basis.push("類別：依目前掛的標籤");
    } else {
      const blob = titles.join("") + companies.join("");
      for (const [kw, c] of [["建築師", "建築師"], ["技師", "技師"], ["營造", "營造"], ["會計師", "財務"],
        ["銀行", "財務"], ["律師", "律師"], ["地政士", "代書"], ["代書", "代書"], ["估價", "財務"]]) {
        if (blob.includes(kw)) {
          cat = c;
          basis.push(`類別：職稱或公司欄有「${kw}」`);
          break;
        }
      }
    }
  }
  if (!cat && !third && !companies.length && !titles.length) {
    // 沒有類別、也沒有任何公司或職稱資料的，當成親友（只寫姓名，用標籤管理）
    return { needs: [], personal: true, category: "", third: "", basis: "", whole: "" };
  }
  if (NO_FILL_CATEGORIES.has(cat)) {
    // 雋品、中華、建築師：不補第三段
  } else if (SPECIALTY_CATEGORIES.has(cat)) {
    const third_is_company = Boolean(third) && companies.some((c) => shares_text(third, c));
    // 第三段沒有專長字樣時：對得上公司欄 → 是公司名，要換成專長；對不上 → 當成他自己的專長寫法，照原樣不動。
    if (!specialties_in(third, cat).length && (!third || third_is_company)) {
      needs.push(!third ? "缺第三段（專長）" : "第三段不是專長");
      new_third = "";
      for (const [label, texts] of [
        ["同一個人另一筆紀錄的第三段", partners.filter((p) => p[1]).map((p) => p[1])],
        ["職稱", titles],
        ["公司欄", companies],
      ]) {
        const kws = [];
        for (const t of texts) for (const k of specialties_in(t, cat)) if (!kws.includes(k)) kws.push(k);
        if (kws.length) {
          new_third = kws.join("、");
          basis.push(`專長：取自${label}`);
          break;
        }
      }
    }
  } else if (!third) {
    needs.push(cat ? "缺第三段（公司）" : "缺第三段");
    const pt = partners
      .filter((p) => p[1] && !SPECIALTY_CATEGORIES.has(p[0]) && [...p[1]].length >= 2 && p[1] !== cat && p[1] !== p[0])
      .map((p) => p[1]);
    if (clean_companies.length) {
      new_third = company_short(clean_companies[0]);
      basis.push("公司：取自公司欄（去掉「有限公司」等字）");
    } else if (pt.length) {
      new_third = pt[0];
      basis.push("公司：取自同一個人另一筆紀錄的第三段");
    }
    // 其他類別已有第三段的（不論寫的是公司、產品或用途）一律照原樣，不改成公司名稱。
  }
  if (NO_THIRD_CATEGORIES.has(cat) && !new_third) {
    needs = needs.filter((n) => !n.startsWith("缺第三段"));
  }
  let whole = "";
  if (needs.length) {
    const ok_cat = Boolean(cat);
    const ok_third = Boolean(new_third) || NO_THIRD_CATEGORIES.has(cat);
    if (ok_cat && ok_third && name) whole = compose(cat, name, new_third);
  }
  return { needs, personal: false, category: cat, third: new_third, basis: basis.join("；"), whole };
}

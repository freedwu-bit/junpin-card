// 讓 JavaScript 的字串與正規表示式行為和 Python 一致的小工具。
// 目的：規則程式（rules.js、address.js、twoacct.js）是從 ~/通訊錄整理/程式/ 的 Python 版逐行移植的，
// 正規表示式直接照抄 Python 的寫法，由這裡轉成 JavaScript，避免手動改寫時走樣。

// Python 的 \s 與 str.strip() 認定的空白字元
const WS = String.raw`\t\n\v\f\r \x1c-\x1f\x85\xa0  -     　`;
const WS_RE = new RegExp(`[${WS}]`, "u");

/** 把 Python 寫法的樣式轉成 JavaScript（一律搭配 u 旗標）：\d＝所有數字字元、\s＝Python 的空白、(?P<名稱> → (?<名稱>。 */
export function pyPattern(src) {
  let out = "";
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") {
      const nx = src[i + 1];
      if (nx === "d") out += String.raw`\p{Nd}`;
      else if (nx === "D") out += String.raw`\P{Nd}`;
      else if (nx === "s") out += inClass ? WS : `[${WS}]`;
      else out += ch + nx;
      i++;
      continue;
    }
    if (!inClass && ch === "(" && src.startsWith("(?P<", i)) {
      out += "(?<";
      i += 3;
      continue;
    }
    if (ch === "[" && !inClass) inClass = true;
    else if (ch === "]" && inClass) inClass = false;
    out += ch;
  }
  return out;
}

/** 建立正規表示式。flags 可給 "g"（全部取代／全部找）或 "y"（從開頭比，等於 Python 的 re.match）。 */
export function re(src, flags = "") {
  return new RegExp(pyPattern(src), "u" + flags);
}

/** Python 的 re.match：只從字串開頭比。 */
export function match(src, s) {
  const r = re(src, "y");
  r.lastIndex = 0;
  return r.exec(s);
}

/** Python 的 re.fullmatch：整個字串都要符合。 */
export function fullmatch(src, s) {
  return new RegExp("^(?:" + pyPattern(src) + ")$", "u").exec(s);
}

/** Python 的 re.search。 */
export function search(src, s) {
  return re(src).exec(s);
}

/** Python 的 re.sub（count=1 時只取代第一個）。repl 是純文字，不解讀 $ 符號。 */
export function sub(src, repl, s, count = 0) {
  return s.replace(re(src, count === 1 ? "" : "g"), () => repl);
}

/** Python 的 re.findall（樣式沒有分組時回傳整段；有一個分組時回傳那個分組）。 */
export function findall(src, s) {
  return [...s.matchAll(re(src, "g"))].map((m) => (m.length > 1 ? m[1] : m[0]));
}

/** Python 的 re.escape（只跳脫在 u 模式下有特殊意義的字元）。 */
export function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

export function isSpace(ch) {
  return WS_RE.test(ch);
}

function stripWith(s, test, left, right) {
  const a = [...s];
  let i = 0;
  let j = a.length;
  if (left) while (i < j && test(a[i])) i++;
  if (right) while (j > i && test(a[j - 1])) j--;
  return a.slice(i, j).join("");
}

/** Python 的 str.strip()／strip(chars)。 */
export function strip(s, chars) {
  return stripWith(s, chars === undefined ? isSpace : (c) => chars.includes(c), true, true);
}
export function lstrip(s, chars) {
  return stripWith(s, chars === undefined ? isSpace : (c) => chars.includes(c), true, false);
}
export function rstrip(s, chars) {
  return stripWith(s, chars === undefined ? isSpace : (c) => chars.includes(c), false, true);
}

/** Python 的 str.split(sep, 1)：只在第一個分隔處切成兩段。 */
export function split1(s, sep) {
  const i = s.indexOf(sep);
  return i < 0 ? [s] : [s.slice(0, i), s.slice(i + sep.length)];
}

/** Python 的 str.split()（不給參數）：用空白切開，不留空字串。 */
export function splitWs(s) {
  return s.split(re(String.raw`\s+`)).filter((x) => x !== "");
}

/** Python 的 collections.Counter（只做需要的部分）。 */
export function counter(items) {
  const m = new Map();
  for (const x of items) m.set(x, (m.get(x) || 0) + 1);
  return m;
}
export function counterTotal(c) {
  let n = 0;
  for (const v of c.values()) n += v;
  return n;
}
export function counterEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
/** 兩個 Counter 的交集（各取較小的次數）後的總數。 */
export function counterCommon(a, b) {
  let n = 0;
  for (const [k, v] of a) n += Math.min(v, b.get(k) || 0);
  return n;
}

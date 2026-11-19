// 國字數字 → 阿拉伯數字（純計算）。使用者 2026-11-19 決定（直式名片常這樣寫）：
// - 電話、傳真、統編、郵遞區號：國字一律轉成數字（〇二－二三四五－六七八九 → 02-2345-6789）。
// - 地址：號、樓、巷、弄、「之幾」轉成數字；「幾段」維持國字（南京東路二段一二三號五樓之二 → 南京東路二段123號5樓之2）。
// 看不懂的寫法不猜，保持原樣。轉完的結果會顯示在表單上，使用者可以改。

const DIGIT = { "〇": 0, 零: 0, "○": 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const DIGIT_CHARS = "〇零○一二三四五六七八九";
const NUM_CHARS = DIGIT_CHARS + "十百千廿卅";

/** 全形英數字與符號轉半形（０２－２３４５ → 02-2345），全形空白轉一般空白。 */
export function to_half(s) {
  return (s || "").replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, " ");
}

/** 一個字對一個數字：用在電話、統編、郵遞區號這種「一碼一碼念」的地方。 */
export function cn_digits(s) {
  return (s || "").replace(new RegExp(`[${DIGIT_CHARS}]`, "g"), (c) => String(DIGIT[c]));
}

/**
 * 一串國字數字 → 整數。看不懂或有歧義的回傳 null（不猜）。
 * 兩種寫法都認得：一碼一碼寫（一〇〇 → 100、一二三 → 123）和帶單位的（十一 → 11、二十三 → 23、一百零五 → 105、廿三 → 23）。
 * 「一百二」這種口語寫法（102 還是 120？）有歧義，不轉。
 */
export function cn_to_int(s) {
  if (!s) return null;
  if (new RegExp(`^[${DIGIT_CHARS}]+$`).test(s)) {
    if ([...s].length > 1 && /^[〇零○]/.test(s)) return null; // 門牌不會是 0 開頭，這種多半不是號碼
    return Number(cn_digits(s));
  }
  const t = s.replace(/廿/g, "二十").replace(/卅/g, "三十");
  const m = /^(?:([一二三四五六七八九])千)?(?:(零)?([一二三四五六七八九])百)?(?:(零)?([一二三四五六七八九])?(十))?(?:(零)?([一二三四五六七八九]))?$/.exec(t);
  if (!m) return null;
  const [, th, , hu, , te, ten, zero, on] = m;
  if (!th && !hu && !ten) return null; // 只有個位數的已經在上面處理了
  // 「一百二」「一千三」：個位數前面沒有「零」也沒有「十」，分不出是 102 還是 120
  if (on && !ten && !zero && (hu || th)) return null;
  return (th ? DIGIT[th] * 1000 : 0) + (hu ? DIGIT[hu] * 100 : 0) + (ten ? (te ? DIGIT[te] : 1) * 10 : 0) + (on ? DIGIT[on] : 0);
}

/** 地址裡的國字數字：號、樓、巷、弄前面的，和「之」後面的，轉成阿拉伯數字；「段」不動。 */
export function cn_address_numbers(s) {
  const conv = (n) => {
    const v = cn_to_int(n);
    return v === null ? n : String(v);
  };
  return (s || "")
    .replace(new RegExp(`[${NUM_CHARS}]+(?=號|樓|巷|弄|之)`, "g"), conv)
    .replace(new RegExp(`之([${NUM_CHARS}]+)`, "g"), (_, n) => "之" + conv(n));
}

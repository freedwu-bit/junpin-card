// 標籤清單的規則（純計算）。使用者 2026-11-19 決定：
// - 兩種姓名模式的標籤來源相同：先讀登入者自己通訊錄現有的標籤，也可以當場新增。
// - 類別模式：從清單選「一個」標籤當類別，冠在姓名前面，同時掛上那個標籤（每人剛好一個）。
// - 一般模式：只寫姓名，標籤可以點選零到多個。
import * as R from "./rules.js";

/** 可以讓人選的標籤：底線開頭的是暫時標籤（例如「_待刪除」），不列出來。 */
export function selectable(labels) {
  return labels.filter((l) => l.name && !l.name.startsWith("_"));
}

/**
 * 排順序：原本那 18 個類別照規則文件的順序排前面，其餘的照原本的順序接在後面。
 * 所以吳建築師看到的順序和以前一樣；同事看到的就是他自己的標籤。
 */
export function order_labels(labels) {
  const rank = (name) => {
    const i = R.COMPANY_CATEGORIES.indexOf(name);
    return i < 0 ? R.COMPANY_CATEGORIES.length : i;
  };
  return selectable(labels)
    .map((l, i) => [l, rank(l.name), i])
    .sort((a, b) => a[1] - b[1] || a[2] - b[2])
    .map(([l]) => l);
}

/**
 * 檢查要新增的標籤名稱。回傳 { ok, name, exists, reason }。
 * asCategory：這個標籤要當類別（冠在姓名前面）用，名稱裡就不能有分隔符號或空白，不然整串姓名會切錯。
 */
export function check_new_label(raw, existingNames, asCategory) {
  const name = (raw || "").trim();
  if (!name) return { ok: false, name, exists: false, reason: "請輸入標籤名稱。" };
  if (name.startsWith("_") || name.startsWith("＿")) {
    return { ok: false, name, exists: false, reason: "底線開頭的標籤是暫時用的（例如「_待刪除」），請換一個名稱。" };
  }
  if (asCategory && [...name].some((c) => R.SEPS.includes(c) || /\s/.test(c))) {
    return { ok: false, name, exists: false, reason: "當類別用的標籤，名稱裡不要有「-」「_」或空白（這些是用來隔開類別、姓名和第三段的）。" };
  }
  if ([...name].length > 20) return { ok: false, name, exists: false, reason: "標籤名稱太長了，請在 20 個字以內。" };
  return { ok: true, name, exists: existingNames.includes(name), reason: "" };
}

/**
 * 讓規則程式認得使用者自己的類別：把標籤名稱加進「已知類別」。
 * 不加的話，「客戶-王小明_大順」會被當成第一段是人名，查重比對本名時會比錯。
 */
export function learn_categories(labels) {
  for (const l of selectable(labels)) {
    if (![...l.name].some((c) => R.SEPS.includes(c) || /\s/.test(c))) R.KNOWN_CATEGORIES.add(l.name);
  }
}

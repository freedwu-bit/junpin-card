// 名片照片的尺寸與裁切計算（純計算，不碰畫面，可以自動測試）。
//
// 背景（官方文件 https://platform.claude.com/docs/en/build-with-claude/vision-coordinates）：
// - Claude 回報的位置是「它實際看到的那張圖」的像素座標。圖太大時 Claude 會先縮小再看，位置就對不回原圖。
// - 所以送出前先自己縮到 Claude 不會再縮的大小（resized_size），回報的位置就能直接用。
// - 這裡的上限是「高解析度」等級（Claude 4.7 之後的模型）：長邊 2576 像素、28×28 的格子 4784 格。
//   後台換成更舊的模型時，要把 MAX_EDGE、MAX_TOKENS 改成 1568、1568。
export const MAX_EDGE = 2576;
export const MAX_TOKENS = 4784;

/** 一張圖佔幾格（每格 28×28 像素）。 */
export function image_tokens(width, height) {
  return Math.ceil(width / 28) * Math.ceil(height / 28);
}

/** 四捨六入五成雙（和 Python 的 round() 相同；官方說剛好 .5 時 Claude 是這樣算的）。 */
function round_half_even(v) {
  const f = Math.floor(v);
  if (v - f !== 0.5) return Math.round(v);
  return f % 2 === 0 ? f : f + 1;
}

/**
 * Claude 會把這個大小的圖縮成多大（[寬, 高]）。本來就在上限內的回傳原大小。
 * 官方文件參考程式的移植。
 */
export function resized_size(width, height, maxEdge = MAX_EDGE, maxTokens = MAX_TOKENS) {
  const fits = (w, h) => Math.ceil(w / 28) * 28 <= maxEdge && Math.ceil(h / 28) * 28 <= maxEdge && image_tokens(w, h) <= maxTokens;
  if (fits(width, height)) return [width, height];
  if (height > width) {
    const [h, w] = resized_size(height, width, maxEdge, maxTokens);
    return [w, h];
  }
  const ratio = width / height;
  let lo = 1; // 一定放得下
  let hi = width; // 一定放不下
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid, Math.max(round_half_even(mid / ratio), 1))) lo = mid;
    else hi = mid;
  }
  return [lo, Math.max(round_half_even(lo / ratio), 1)];
}

const MARGIN = 0.04; // 名片四邊各多留「名片長邊的 4%」，確保名片的邊界都在照片裡
const MIN_SIDE = 0.15; // 回報的名片範圍比照片的 15% 還窄：多半是認錯了，不裁
const FULL_AREA = 0.9; // 留邊之後已經佔照片 90% 以上：不用裁

/**
 * 依 Claude 回報的名片範圍和要轉的角度，算出要怎麼裁、怎麼轉。
 * box：{ x1, y1, x2, y2 }，送去辨識的那張圖上的像素座標。rotate：要順時針轉幾度（0、90、180、270，數字或字串）。
 * sent：{ w, h }，送去辨識的那張圖的大小。
 * 回傳 { crop, turns }：
 *   crop  要留下的範圍，用「佔整張圖的比例」表示 { x, y, w, h }（0～1），所以可以套用在任何解析度的同一張照片上；不用裁時是 null。
 *   turns 裁完之後要順時針轉幾次 90°。
 * 範圍不合理（沒有、太小、座標亂掉）時不裁，只轉。
 */
export function crop_plan(box, rotate, sent) {
  const deg = Number(rotate);
  const turns = [0, 90, 180, 270].includes(deg) ? deg / 90 : 0;
  const none = { crop: null, turns };
  const W = Number(sent?.w);
  const H = Number(sent?.h);
  if (!(W > 0 && H > 0) || !box) return none;
  const nums = [box.x1, box.y1, box.x2, box.y2].map(Number);
  if (!nums.every(Number.isFinite)) return none;
  const clamp = (v, max) => Math.min(Math.max(v, 0), max);
  const x1 = clamp(Math.min(nums[0], nums[2]), W);
  const x2 = clamp(Math.max(nums[0], nums[2]), W);
  const y1 = clamp(Math.min(nums[1], nums[3]), H);
  const y2 = clamp(Math.max(nums[1], nums[3]), H);
  const bw = x2 - x1;
  const bh = y2 - y1;
  if (bw < W * MIN_SIDE || bh < H * MIN_SIDE) return none;
  const m = Math.max(bw, bh) * MARGIN;
  const left = clamp(x1 - m, W);
  const top = clamp(y1 - m, H);
  const right = clamp(x2 + m, W);
  const bottom = clamp(y2 + m, H);
  if ((right - left) * (bottom - top) >= W * H * FULL_AREA) return none;
  return { crop: { x: left / W, y: top / H, w: (right - left) / W, h: (bottom - top) / H }, turns };
}

// 示範模式用的「假 Google」：網址加上 ?demo=1 才會用到。
// 不連網路、不登入、不會動到任何真的聯絡人；資料都是虛構的，重新整理就還原。
// 用途：不登入也能把整個流程走一遍（開發時檢查畫面用）。函式和 google.js 一一對應。
export class UserError extends Error {}
export const DEMO = true;
export const PERSON_FIELDS = "";

const C = { source: { type: "CONTACT" } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 100;
let on = false;

const labels = ["廠商", "技師", "業主", "建築師", "雋品", "顧問", "營造", "公部門", "財務", "_待刪除"].map((name, i) => ({ resourceName: `contactGroups/demo${i}`, name }));
const label = (name) => labels.find((l) => l.name === name).resourceName;
const src = () => ({ etag: `%E${seq}`, metadata: { sources: [{ type: "CONTACT", id: `id${seq}`, etag: `#e${seq}` }] } });
const mk = (given, phones, emails, org, groups) => ({
  ...src(),
  resourceName: `people/demo${seq++}`,
  names: [{ metadata: C, givenName: given, displayName: given }],
  phoneNumbers: phones.map(([value, type]) => ({ metadata: C, value, type })),
  emailAddresses: emails.map((value) => ({ metadata: C, value, type: "work" })),
  organizations: org ? [{ metadata: C, name: org[0], title: org[1] }] : [],
  memberships: groups.map((g) => ({ contactGroupMembership: { contactGroupResourceName: label(g) } })),
});
const people = [
  mk("廠商-王小明_大順廚具", [["0912-345-678", "mobile"], ["02-2345-6789,123", "work"]], ["ming@example.com"], ["大順廚具股份有限公司", "業務經理"], ["廠商"]),
  mk("技師-陳大文_結構", [["0922 111 222", "mobile"]], ["chen@example.com"], ["大文結構技師事務所", "結構技師"], ["技師"]),
  mk("業主-林一二", [["+886933444555", "mobile"]], [], null, ["業主"]),
  mk("廠商-舊資料_大順廚具", [["0912-345-678", "mobile"]], [], null, ["_待刪除"]),
];

export function explain(e) {
  if (e?.status === 400 && /etag/i.test(e.message)) return "這一筆剛剛在別的地方被改過，所以這次沒有寫入。請回上一步重新比對。";
  return e instanceof UserError ? e.message : `發生錯誤：${e?.message || e}`;
}
export function account() {
  return on ? "demo@junpin.com.tw（示範）" : "";
}
export function loggedIn() {
  return on;
}
export function logout() {
  on = false;
}
export function lastAccount() {
  return "";
}
export function restore() {
  return "";
}
export async function login() {
  await sleep(300);
  on = true;
  return account();
}
export async function listLabels() {
  await sleep(150);
  return labels.map((l) => ({ ...l }));
}
export async function createLabel(name) {
  const l = { resourceName: `contactGroups/demo${seq++}`, name };
  labels.push(l);
  return { ...l };
}
export async function createContact(body) {
  await sleep(500);
  const given = body.names[0].givenName;
  const p = {
    ...structuredClone(body),
    ...src(),
    resourceName: `people/demo${seq++}`,
    names: [{ metadata: C, givenName: given, displayName: given }],
  };
  for (const f of ["phoneNumbers", "emailAddresses", "addresses", "organizations", "nicknames", "urls", "userDefined", "biographies"]) {
    if (p[f]) p[f] = p[f].map((x) => ({ metadata: C, ...x }));
  }
  people.push(p);
  return structuredClone(p);
}
export async function updateContact(rn, mask, body) {
  await sleep(500);
  const p = people.find((x) => x.resourceName === rn);
  if (!p || body.etag !== p.etag) {
    const e = new Error("etag mismatch (demo)");
    e.status = 400;
    throw e;
  }
  for (const f of mask) p[f] = body[f].map((x) => ({ metadata: C, ...structuredClone(x) }));
  p.etag = `%E${seq++}`;
  p.metadata.sources[0].etag = `#e${seq}`;
  return structuredClone(p);
}
export async function getPerson(rn) {
  await sleep(200);
  return structuredClone(people.find((p) => p.resourceName === rn));
}
export async function warmup() {}

// 模仿 2026-11-18 實測到的搜尋行為：照字面比。查詢用空白切成幾個詞，每個詞都要是「某個欄位整串的開頭」
// 或「欄位裡某一段（用空白、-、_ 分段）的開頭」。
function hit(person, q) {
  const values = [
    ...(person.names || []).map((x) => x.givenName), ...(person.phoneNumbers || []).map((x) => x.value),
    ...(person.emailAddresses || []).map((x) => x.value), ...(person.organizations || []).map((x) => x.name),
  ].filter(Boolean).map((v) => v.toLowerCase());
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  return values.some((v) => {
    const tokens = v.split(/[\s\-_]+/);
    return terms.every((t) => v.startsWith(t) || tokens.some((k) => k.startsWith(t)));
  });
}
export async function searchAll(queries) {
  await sleep(600);
  const out = [];
  for (const q of queries) for (const p of people) if (hit(p, q)) out.push(structuredClone(p));
  return out;
}
export async function uploadPhoto(_blob, name) {
  await sleep(400);
  return { name, shared: false, link: `https://drive.google.com/file/d/demo${seq++}/view` };
}

// ---------- 假的辨識（示範模式）：不管拍什麼，都回同一張虛構的名片 ----------
export async function ping() {
  await sleep(200);
  return { hasKey: true, recognize: true };
}
const box = (w, h) => ({ x1: Math.round(w * 0.1), y1: Math.round(h * 0.22), x2: Math.round(w * 0.9), y2: Math.round(h * 0.78) });
// 開發時檢查「自動轉正」用：網址再加 &rot=90（或 180、270），假裝 Claude 說照片要轉這麼多度
const rot = new URLSearchParams(globalThis.location?.search || "").get("rot");
export async function recognize(p) {
  await sleep(1500);
  const base = { card_found: true, name: "", english_name: "", company: "", department: "", title: "", phones: [], emails: [], address: "", zip: "", tax_id: "", website: "", other: [], unsure: [], card_box: box(p.width, p.height), rotate_clockwise: ["90", "180", "270"].includes(rot) ? rot : "0" };
  const result = p.side === "back"
    ? { ...base, english_name: "Tina Lin", company: "Zhuguang Interior Design Co., Ltd.", title: "Design Director", phones: [{ kind: "手機", value: "+886 933 222 111" }], emails: ["yating@example.com"], address: "8F., No. 100, Sec. 4, Zhongxiao E. Rd., Taipei" }
    : {
      ...base, name: "林雅婷", company: "築光室內裝修設計有限公司", department: "設計部", title: "設計總監",
      phones: [{ kind: "手機", value: "0933 222 111" }, { kind: "公司", value: "(02)2711-2233 #15" }, { kind: "傳真", value: "〇二－二七一一－二二三四" }],
      emails: ["yating@example.com"], address: "臺北市大安區忠孝東路四段一〇〇號八樓", zip: "106", tax_id: "12345675", website: "www.example.com",
      other: ["LINE：yating_design"], unsure: ["title"],
    };
  return { ok: true, result, model: "demo", usage: { input: 0, output: 0 }, ms: 1500 };
}

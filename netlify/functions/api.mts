import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import webpush from "web-push";

/*
  API של לוח העבודות.
  כל הנתונים נשמרים במסמך אחד ("state") באחסון של Netlify.
  סיסמאות נשמרות מוצפנות (scrypt). עותק גלוי נשמר בנפרד ונשלח רק למנהלים.
*/

type Role = "owner" | "manager" | "worker";
type User = { name: string; phone?: string; role: Role; trade?: string; company?: string; pass?: string; salt?: string; created?: number };
type State = {
  project?: any | null;
  projects: Record<string, any>;
  users: Record<string, User>;
  tasks: Record<string, any>;
  messages: Record<string, any>;
  creds: Record<string, string>;
  subs: Record<string, any[]>;
  companies: Record<string, any>;
  owner?: string;
  log: any[];
};

const store = () => getStore({ name: "siteboard", consistency: "strong" });
const empty = (): State => ({ projects: {}, users: {}, tasks: {}, messages: {}, creds: {}, subs: {}, companies: {}, log: [] });

/* התראות שקופצות בטלפון (Web Push) */
const env = (k: string) => (globalThis as any).Netlify?.env?.get(k) || process.env[k] || "";
let pushReady = false;
function initPush() {
  if (pushReady) return true;
  const pub = env("VAPID_PUBLIC"), priv = env("VAPID_PRIVATE");
  if (!pub || !priv) return false;
  webpush.setVapidDetails("mailto:" + (env("VAPID_EMAIL") || "admin@example.com"), pub, priv);
  return (pushReady = true);
}
async function sendPushes(s: State, items: { to: string; text: string }[]) {
  if (!items.length || !initPush()) return false;
  let dirty = false;
  const jobs: Promise<any>[] = [];
  for (const it of items) {
    const ids = it.to.startsWith("mgr:") ? Object.keys(s.users).filter((id) => s.users[id].role === "manager" && s.users[id].company === it.to.slice(4)) : [it.to];
    for (const id of ids) {
      const u = s.users[id];
      if (!u) continue;
      const payload = JSON.stringify({ title: u.role === "worker" ? "עובדים" : "מנהלי עבודה", body: it.text, url: portalOf(u) });
      for (const sub of s.subs[id] || []) {
        jobs.push(
          webpush.sendNotification(sub, payload, { TTL: 60 * 60 * 24 }).catch((e: any) => {
            if (e?.statusCode === 404 || e?.statusCode === 410) {
              s.subs[id] = (s.subs[id] || []).filter((x) => x.endpoint !== sub.endpoint);
              dirty = true;
            } else console.error("push", e?.statusCode, e?.body);
          })
        );
      }
    }
  }
  await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, 8000))]);
  return dirty;
}

async function load(): Promise<State> {
  const raw = await store().get("state", { type: "json" });
  const s: State = { ...empty(), ...(raw || {}) };
  /* מעבר מפרויקט יחיד לכמה פרויקטים */
  if (s.project && !Object.keys(s.projects).length) {
    s.projects = { p1: { ...s.project, created: 1 } };
    const T: Record<string, any> = {};
    for (const [k, t] of Object.entries(s.tasks)) T[k.includes("__") ? k : "p1__" + k] = { ...t, pid: t.pid || "p1" };
    s.tasks = T;
  }
  delete s.project;
  /* מעבר למבנה חברות: המשתמש הראשון הוא בעל האפליקציה, וכל השאר עוברים לחברה הראשונה */
  const ids = Object.keys(s.users);
  if (ids.length && (!s.owner || !s.users[s.owner])) {
    s.owner = ids.find((id) => s.users[id].role === "owner") || ids.find((id) => s.users[id].role === "manager") || ids[0];
  }
  if (s.owner && s.users[s.owner]) { s.users[s.owner].role = "owner"; delete s.users[s.owner].company; }
  const needsCompany = Object.values(s.projects).some((p: any) => !p.company) || Object.entries(s.users).some(([id, x]) => id !== s.owner && !x.company);
  if (needsCompany) {
    if (!Object.keys(s.companies).length) s.companies.c1 = { name: "החברה הראשית", created: Date.now() };
    const first = Object.keys(s.companies)[0];
    for (const p of Object.values(s.projects) as any[]) if (!p.company) p.company = first;
    for (const [id, x] of Object.entries(s.users)) if (id !== s.owner && !x.company) x.company = first;
  }
  for (const m of Object.values(s.messages) as any[]) if (m.to === "managers") m.to = "mgr:" + (Object.keys(s.companies)[0] || "c1");
  if (!Array.isArray(s.log)) s.log = [];
  return s;
}
const portalOf = (u: User) => (u.role === "owner" ? "/admin" : u.role === "manager" ? "/manager" : "/team");
const companyOfProject = (s: State, pid: string) => s.projects[pid]?.company || "";
function unitName(p: any, loc: string) {
  const f = Number((loc.match(/^f(\d+)_/) || [])[1]);
  if (Array.isArray(p?.units)) return (p.units.find((x: any) => x.id === f) || {}).name || "";
  return f === 0 ? "קרקע" : "קומה " + f;
}
function addLog(s: State, by: string, company: string, text: string) {
  s.log.push({ at: Date.now(), by, company, text: text.slice(0, 200) });
  if (s.log.length > 500) s.log.splice(0, s.log.length - 500);
}
async function save(s: State) {
  await store().setJSON("state", s);
}

async function secret(): Promise<string> {
  const st = store();
  let s = await st.get("secret");
  if (!s) {
    s = crypto.randomBytes(32).toString("hex");
    await st.set("secret", s);
  }
  return s as string;
}

function hashPass(pw: string, salt = crypto.randomBytes(16).toString("hex")) {
  const pass = crypto.scryptSync(pw, salt, 32).toString("hex");
  return { pass, salt };
}
function checkPass(pw: string, u: User) {
  if (!u.pass || !u.salt) return false;
  const h = crypto.scryptSync(pw, u.salt, 32);
  const want = Buffer.from(u.pass, "hex");
  return want.length === h.length && crypto.timingSafeEqual(h, want);
}

async function sign(user: string) {
  const body = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + 1000 * 60 * 60 * 24 * 60 })).toString("base64url");
  const sig = crypto.createHmac("sha256", await secret()).update(body).digest("base64url");
  return body + "." + sig;
}
async function verify(token: string | null): Promise<string | null> {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const want = crypto.createHmac("sha256", await secret()).update(body).digest("base64url");
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(body, "base64url").toString());
    return exp > Date.now() ? u : null;
  } catch {
    return null;
  }
}

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (msg: string, status = 400) => json({ error: msg }, status);

const USER_RE = /^[a-z0-9_.-]{2,30}$/;
const ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const DEFAULT_TRADES = ["טיח", "אינסטלציה", "חשמל", "ריצוף", "צבע"];

/* מה כל משתמש רואה:
   בעל האפליקציה — הכל; מנהל עבודה — רק החברה שלו; עובד — החברה שלו, בלי סיסמאות, רק ההודעות שלו */
function view(s: State, me: string | null) {
  const base = { setup: Object.keys(s.users).length === 0, projectName: "", vapidPublic: env("VAPID_PUBLIC") };
  const u = me ? s.users[me] : null;
  if (!u) return { ...base, me: null };
  if (u.role !== "owner" && s.companies[u.company || ""]?.suspended) return { ...base, me: null, suspended: true };
  const owner = u.role === "owner", cid = u.company || "";
  const inCo = (c?: string) => owner || c === cid;
  const users: Record<string, any> = {};
  for (const [id, x] of Object.entries(s.users)) {
    if (x.role === "owner" && id !== me && !owner) continue;
    if (x.role !== "owner" && !inCo(x.company)) continue;
    users[id] = { name: x.name, phone: x.phone || "", role: x.role, trade: x.trade || "", company: x.company || "" };
  }
  const projects: Record<string, any> = {};
  for (const [pid, p] of Object.entries(s.projects)) if (inCo(p.company)) projects[pid] = p;
  const tasks: Record<string, any> = {};
  for (const [k, t] of Object.entries(s.tasks)) if (projects[k.split("__")[0]]) tasks[k] = t;
  const messages: Record<string, any> = {};
  for (const [id, m] of Object.entries(s.messages)) {
    const ok = owner ? (String(m.to).startsWith("mgr:") || m.to === me) : u.role === "manager" ? m.to === "mgr:" + cid || m.to === me : m.to === me;
    if (ok) messages[id] = m;
  }
  const creds: Record<string, string> = {};
  if (u.role !== "worker") for (const id of Object.keys(users)) if (s.creds[id] != null && (owner || users[id].role === "worker" || id === me)) creds[id] = s.creds[id];
  const companies: Record<string, any> = {};
  for (const [c, x] of Object.entries(s.companies)) if (inCo(c)) companies[c] = owner ? x : { name: x.name };
  return { ...base, me, role: u.role, mainOwner: owner ? s.owner : "", company: cid, companies, projects, users, tasks, messages, creds, log: owner ? s.log.slice(-200) : [] };
}

function pruneMessages(s: State) {
  const ids = Object.entries(s.messages).sort((a, b) => a[1].at - b[1].at).map(([id]) => id);
  while (ids.length > 400) delete s.messages[ids.shift()!];
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "");
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || null;

  try {
    if (req.method === "GET" && route === "state") {
      const s = await load();
      const me = await verify(token);
      return json(view(s, me && s.users[me] ? me : null));
    }
    if (req.method !== "POST") return fail("not found", 404);
    const body = await req.json().catch(() => ({}));
    const s = await load();

    /* הקמה ראשונה — רק כשאין עדיין אף משתמש */
    if (route === "setup") {
      if (Object.keys(s.users).length) return fail("האתר כבר הוקם. היכנס עם שם משתמש וסיסמה.");
      const user = String(body.username || "").trim().toLowerCase();
      const pw = String(body.password || "");
      if (!USER_RE.test(user)) return fail("שם משתמש: אותיות באנגלית, מספרים, נקודה או מקף");
      if (pw.length < 4) return fail("סיסמה של 4 תווים לפחות");
      const trades = DEFAULT_TRADES.map((label, i) => ({ key: "t" + (i + 1), label, notify: [] }));
      s.companies = { c1: { name: "החברה הראשית", created: Date.now() } };
      s.projects = { p1: { name: String(body.project || "פרויקט חדש").slice(0, 80), company: "c1", floors: 5, trades, nextTrade: trades.length + 1, assign: {}, created: Date.now() } };
      s.users[user] = { name: String(body.name || user).slice(0, 60), phone: String(body.phone || "").slice(0, 20), role: "owner", trade: "", created: Date.now(), ...hashPass(pw) };
      s.owner = user;
      s.creds[user] = pw;
      await save(s);
      return json({ token: await sign(user), state: view(s, user) });
    }

    if (route === "login") {
      const user = String(body.username || "").trim().toLowerCase();
      const u = s.users[user];
      if (!u || !checkPass(String(body.password || ""), u)) return fail("שם משתמש או סיסמה שגויים", 401);
      const want = body.portal === "team" ? "worker" : body.portal === "manager" ? "manager" : body.portal === "admin" ? "owner" : "";
      if (want && u.role !== want) {
        const where = u.role === "owner" ? "haranam-app.netlify.app/admin" : u.role === "manager" ? "אפליקציית מנהלי העבודה" : "אפליקציית העובדים";
        return fail(`המשתמש הזה לא שייך לאפליקציה הזו. היכנס דרך ${where}.`, 403);
      }
      if (u.role !== "owner" && s.companies[u.company || ""]?.suspended) return fail("החשבון של החברה מושהה. פנה למנהל המערכת.", 403);
      return json({ token: await sign(user), state: view(s, user) });
    }

    /* מכאן והלאה — רק משתמש מחובר */
    const me = await verify(token);
    const u = me ? s.users[me] : null;
    if (!me || !u) return fail("פג תוקף הכניסה. היכנס שוב.", 401);
    if (u.role !== "owner" && s.companies[u.company || ""]?.suspended) return fail("החשבון של החברה מושהה. פנה למנהל המערכת.", 401);
    const owner = u.role === "owner";
    const isMgr = u.role === "manager" || owner;
    const myCo = u.company || "";
    const canCo = (c?: string) => owner || (!!c && c === myCo);
    const pushes: { to: string; text: string }[] = [];

    if (route === "subscribe") {
      const sub = body.sub;
      if (!sub || typeof sub.endpoint !== "string" || !sub.keys) return fail("פעולה לא תקינה");
      const list = (s.subs[me] || []).filter((x) => x.endpoint !== sub.endpoint);
      list.push({ endpoint: sub.endpoint, keys: sub.keys });
      s.subs[me] = list.slice(-5);
      await save(s);
      return json({ ok: true });
    }

    /* התראת בדיקה לעצמי — מחזיר מה קרה עם כל מכשיר רשום */
    if (route === "testpush") {
      if (!initPush()) return json({ ok: false, reason: "no-keys", subs: 0 });
      const subs = s.subs[me] || [];
      const results: any[] = [];
      for (const sub of subs) {
        try {
          const r: any = await webpush.sendNotification(sub, JSON.stringify({ title: "בדיקה", body: "ההתראות עובדות ✓", url: portalOf(u) }), { TTL: 600 });
          results.push({ ok: true, status: r?.statusCode, host: new URL(sub.endpoint).host });
        } catch (e: any) {
          results.push({ ok: false, status: e?.statusCode, host: new URL(sub.endpoint).host, body: String(e?.body || e?.message || "").slice(0, 200) });
          if (e?.statusCode === 404 || e?.statusCode === 410) s.subs[me] = (s.subs[me] || []).filter((x) => x.endpoint !== sub.endpoint);
        }
      }
      await save(s);
      return json({ ok: results.some((r) => r.ok), subs: subs.length, results });
    }

    if (route === "adduser" || route === "resetpw") {
      if (!isMgr) return fail("רק מנהל יכול לעשות את זה", 403);
      const id = String(body.username || "").trim().toLowerCase();
      const pw = String(body.password || "");
      if (pw.length < 4) return fail("סיסמה של 4 תווים לפחות");
      if (route === "adduser") {
        if (!USER_RE.test(id)) return fail("שם משתמש: אותיות באנגלית, מספרים, נקודה או מקף");
        if (s.users[id]) return fail("שם המשתמש הזה כבר תפוס");
        const role: Role = body.role === "owner" ? "owner" : body.role === "manager" ? "manager" : "worker";
        if (role !== "worker" && !owner) return fail("רק בעל האפליקציה יכול להוסיף מנהלים", 403);
        const company = role === "owner" ? "" : owner ? String(body.company || "") : myCo;
        if (role !== "owner" && !s.companies[company]) return fail("בחר חברה");
        s.users[id] = { name: String(body.name || id).slice(0, 60), phone: String(body.phone || "").slice(0, 20), role, company, trade: role === "worker" ? String(body.trade || "") : "", created: Date.now(), ...hashPass(pw) };
        if (role === "owner") delete s.users[id].company;
        addLog(s, u.name, company, `${role === "owner" ? "מנהל מערכת" : role === "manager" ? "מנהל עבודה" : "עובד"} חדש: ${s.users[id].name}`);
      } else {
        const t = s.users[id];
        if (!t) return fail("משתמש לא נמצא", 404);
        if (id === s.owner && me !== s.owner) return fail("אי אפשר לשנות את בעל האפליקציה הראשי", 403);
        if (!owner && (t.company !== myCo || (t.role !== "worker" && id !== me))) return fail("אין לך הרשאה למשתמש הזה", 403);
        Object.assign(t, hashPass(pw));
        addLog(s, u.name, t.company || "", `סיסמה חדשה ל${t.name}`);
      }
      s.creds[id] = pw;
      await save(s);
      return json({ state: view(s, me) });
    }

    /* כתיבה כללית של מסמך: users / tasks / project / messages */
    if (route === "put" || route === "remove") {
      const col = String(body.col || "");
      const id = String(body.id || "");
      const obj = body.obj && typeof body.obj === "object" ? body.obj : null;
      if (!ID_RE.test(id)) return fail("מזהה לא תקין");

      if (col === "companies") {
        if (!owner) return fail("רק בעל האפליקציה מנהל חברות", 403);
        if (route === "remove") {
          const name = s.companies[id]?.name || id;
          for (const [pid, p] of Object.entries(s.projects)) if (p.company === id) {
            delete s.projects[pid];
            for (const k of Object.keys(s.tasks)) if (k.startsWith(pid + "__")) delete s.tasks[k];
          }
          for (const [uid, x] of Object.entries(s.users)) if (x.company === id && uid !== s.owner) { delete s.users[uid]; delete s.creds[uid]; delete s.subs[uid]; }
          delete s.companies[id];
          addLog(s, u.name, "", `החברה ${name} נמחקה`);
        } else {
          if (!obj || !String(obj.name || "").trim()) return fail("צריך שם חברה");
          const isNew = !s.companies[id];
          const prev = s.companies[id] || { created: Date.now() };
          s.companies[id] = { ...prev, name: String(obj.name).slice(0, 60), contact: String(obj.contact || "").slice(0, 60), phone: String(obj.phone || "").slice(0, 20), notes: String(obj.notes || "").slice(0, 500), plan: String(obj.plan || "").slice(0, 40), payDate: String(obj.payDate || "").slice(0, 10), suspended: !!obj.suspended };
          if (isNew) addLog(s, u.name, id, `חברה חדשה: ${s.companies[id].name}`);
          else if (!!prev.suspended !== !!obj.suspended) addLog(s, u.name, id, obj.suspended ? "החברה הושהתה" : "החברה הופעלה מחדש");
        }
      } else if (col === "projects") {
        if (!isMgr) return fail("רק מנהל יכול לשנות הגדרות", 403);
        const cur = s.projects[id];
        if (cur && !canCo(cur.company)) return fail("אין לך הרשאה לפרויקט הזה", 403);
        if (route === "remove") {
          if (!cur) return fail("הפרויקט לא נמצא", 404);
          delete s.projects[id];
          for (const k of Object.keys(s.tasks)) if (k.startsWith(id + "__")) delete s.tasks[k];
          addLog(s, u.name, cur.company, `פרויקט נמחק: ${cur.name}`);
        } else {
          if (!obj) return fail("פעולה לא תקינה");
          const company = cur ? cur.company : owner ? String(obj.company || "") : myCo;
          if (!s.companies[company]) return fail("בחר חברה");
          s.projects[id] = { ...obj, company };
          if (!cur) addLog(s, u.name, company, `פרויקט חדש: ${obj.name}`);
        }
      } else if (col === "users") {
        if (!isMgr) return fail("רק מנהל יכול לשנות עובדים", 403);
        const cur = s.users[id];
        if (!cur) return fail("משתמש לא נמצא", 404);
        if (!owner && (cur.company !== myCo || (cur.role !== "worker" && id !== me))) return fail("אין לך הרשאה למשתמש הזה", 403);
        if (id === s.owner && me !== s.owner) return fail("אי אפשר לשנות את בעל האפליקציה הראשי", 403);
        if (route === "remove") {
          if (id === me) return fail("אי אפשר למחוק את עצמך");
          if (id === s.owner) return fail("אי אפשר למחוק את בעל האפליקציה הראשי", 403);
          delete s.users[id];
          delete s.creds[id];
          delete s.subs[id];
          addLog(s, u.name, cur.company || "", `${cur.role === "owner" ? "מנהל מערכת" : cur.role === "manager" ? "מנהל עבודה" : "עובד"} הוסר: ${cur.name}`);
        } else {
          if (!obj) return fail("משתמש לא נמצא", 404);
          s.users[id] = {
            ...cur,
            name: String(obj.name || cur.name).slice(0, 60),
            phone: String(obj.phone ?? cur.phone ?? "").slice(0, 20),
            trade: cur.role === "worker" ? String(obj.trade ?? cur.trade ?? "") : "",
          };
        }
      } else if (col === "tasks") {
        if (route !== "put" || !obj) return fail("פעולה לא תקינה");
        if (!isMgr) {
          /* בעל מקצוע: רק המקצוע שלו, רק "סיימתי" או ביטול, ורק בקומה שלו */
          const cur = s.tasks[id] || {};
          const [pid, loc] = id.split("__");
          const assigned = s.projects[pid]?.assign?.[loc];
          if (!s.projects[pid]) return fail("הפרויקט לא נמצא", 404);
          if (obj.trade !== u.trade) return fail("אפשר לסמן רק עבודה במקצוע שלך", 403);
          if (assigned && assigned !== me) return fail("הקומה הזו משובצת לבעל מקצוע אחר", 403);
          if (!["done", "pending"].includes(obj.status)) return fail("רק המנהל מאשר עבודה", 403);
          if (cur.status === "approved") return fail("העבודה כבר אושרה", 403);
          if (obj.status === "pending" && cur.status !== "done") return fail("פעולה לא תקינה", 403);
        }
        const [pid0, loc0] = id.split("__");
        const pco = companyOfProject(s, pid0);
        if (!s.projects[pid0]) return fail("הפרויקט לא נמצא", 404);
        if (!canCo(pco)) return fail("אין לך הרשאה לפרויקט הזה", 403);
        const before = s.tasks[id]?.status || "pending";
        s.tasks[id] = obj;
        if (before !== obj.status) {
          const tr = (s.projects[pid0].trades || []).find((x: any) => x.key === obj.trade)?.label || "";
          const word: any = { done: "סימן סיום", approved: "אישר", rejected: "החזיר לתיקון", pending: "איפס" };
          addLog(s, u.name, pco, `${word[obj.status] || obj.status}: ${tr} · ${unitName(s.projects[pid0], loc0)} · ${s.projects[pid0].name}`);
        }
      } else if (col === "messages") {
        const cur = s.messages[id];
        if (route === "remove") {
          if (!isMgr) return fail("פעולה לא תקינה", 403);
          delete s.messages[id];
        } else if (cur) {
          /* עדכון הודעה קיימת = סימון כנקרא, רק לנמען */
          const mine = cur.to === me || (owner && String(cur.to).startsWith("mgr:")) || (u.role === "manager" && cur.to === "mgr:" + myCo);
          if (!mine) return fail("פעולה לא תקינה", 403);
          cur.read = !!obj?.read;
        } else {
          if (!obj) return fail("פעולה לא תקינה");
          let to = String(obj.to || "");
          if (to === "managers") to = "mgr:" + myCo;
          if (!to.startsWith("mgr:")) {
            const tu = s.users[to];
            if (!tu) return fail("הנמען לא נמצא", 404);
            if (!owner && tu.company !== myCo) return fail("אין לך הרשאה לשלוח למשתמש הזה", 403);
            if (u.role === "worker") return fail("פעולה לא תקינה", 403);
          } else if (!owner && to !== "mgr:" + myCo) return fail("פעולה לא תקינה", 403);
          s.messages[id] = { to, text: String(obj.text || "").slice(0, 600), at: Date.now(), from: u.name, read: false };
          pushes.push({ to: s.messages[id].to, text: s.messages[id].text });
          pruneMessages(s);
        }
      } else {
        return fail("פעולה לא תקינה");
      }
      await save(s);
      if (await sendPushes(s, pushes)) await save(s);
      return json({ state: view(s, me) });
    }

    return fail("not found", 404);
  } catch (e: any) {
    console.error(e);
    return fail("שגיאת שרת. נסה שוב.", 500);
  }
};

export const config = { path: "/api/*" };

import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

/*
  API של לוח העבודות.
  כל הנתונים נשמרים במסמך אחד ("state") באחסון של Netlify.
  סיסמאות נשמרות מוצפנות (scrypt). עותק גלוי נשמר בנפרד ונשלח רק למנהלים.
*/

type User = { name: string; phone?: string; role: "manager" | "worker"; trade?: string; pass?: string; salt?: string };
type State = {
  project?: any | null;
  projects: Record<string, any>;
  users: Record<string, User>;
  tasks: Record<string, any>;
  messages: Record<string, any>;
  creds: Record<string, string>;
};

const store = () => getStore({ name: "siteboard", consistency: "strong" });
const empty = (): State => ({ projects: {}, users: {}, tasks: {}, messages: {}, creds: {} });

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
  return s;
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

/* מה כל משתמש רואה: מנהל — הכל; בעל מקצוע — בלי סיסמאות ורק ההודעות שלו */
function view(s: State, me: string | null) {
  const publicUsers: Record<string, any> = {};
  for (const [id, u] of Object.entries(s.users)) {
    publicUsers[id] = { name: u.name, phone: u.phone || "", role: u.role, trade: u.trade || "" };
  }
  const base = { setup: Object.keys(s.users).length === 0, projectName: "" };
  const u = me ? s.users[me] : null;
  if (!u) return { ...base, me: null };
  const isMgr = u.role === "manager";
  const messages: Record<string, any> = {};
  for (const [id, m] of Object.entries(s.messages)) {
    if (isMgr ? m.to === "managers" : m.to === me) messages[id] = m;
  }
  return {
    ...base,
    me,
    projects: s.projects,
    users: publicUsers,
    tasks: s.tasks,
    messages,
    creds: isMgr ? s.creds : {},
  };
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
      s.projects = { p1: { name: String(body.project || "פרויקט חדש").slice(0, 80), floors: 5, trades, nextTrade: trades.length + 1, assign: {}, created: Date.now() } };
      s.users[user] = { name: String(body.name || user).slice(0, 60), phone: String(body.phone || "").slice(0, 20), role: "manager", trade: "", ...hashPass(pw) };
      s.creds[user] = pw;
      await save(s);
      return json({ token: await sign(user), state: view(s, user) });
    }

    if (route === "login") {
      const user = String(body.username || "").trim().toLowerCase();
      const u = s.users[user];
      if (!u || !checkPass(String(body.password || ""), u)) return fail("שם משתמש או סיסמה שגויים", 401);
      if (body.portal === "team" && u.role === "manager") return fail("זו אפליקציית העובדים. מנהלים נכנסים דרך אפליקציית הקבלנים.", 403);
      if (body.portal === "manager" && u.role !== "manager") return fail("זו אפליקציית הקבלנים. עובדים נכנסים דרך אפליקציית העובדים.", 403);
      return json({ token: await sign(user), state: view(s, user) });
    }

    /* מכאן והלאה — רק משתמש מחובר */
    const me = await verify(token);
    const u = me ? s.users[me] : null;
    if (!me || !u) return fail("פג תוקף הכניסה. היכנס שוב.", 401);
    const isMgr = u.role === "manager";

    if (route === "adduser" || route === "resetpw") {
      if (!isMgr) return fail("רק מנהל יכול לעשות את זה", 403);
      const id = String(body.username || "").trim().toLowerCase();
      const pw = String(body.password || "");
      if (pw.length < 4) return fail("סיסמה של 4 תווים לפחות");
      if (route === "adduser") {
        if (!USER_RE.test(id)) return fail("שם משתמש: אותיות באנגלית, מספרים, נקודה או מקף");
        if (s.users[id]) return fail("שם המשתמש הזה כבר תפוס");
        const role = body.role === "manager" ? "manager" : "worker";
        s.users[id] = { name: String(body.name || id).slice(0, 60), phone: String(body.phone || "").slice(0, 20), role, trade: role === "worker" ? String(body.trade || "") : "", ...hashPass(pw) };
      } else {
        if (!s.users[id]) return fail("משתמש לא נמצא", 404);
        Object.assign(s.users[id], hashPass(pw));
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

      if (col === "projects") {
        if (!isMgr) return fail("רק מנהל יכול לשנות הגדרות", 403);
        if (route === "remove") {
          delete s.projects[id];
          for (const k of Object.keys(s.tasks)) if (k.startsWith(id + "__")) delete s.tasks[k];
        } else {
          if (!obj) return fail("פעולה לא תקינה");
          s.projects[id] = obj;
        }
      } else if (col === "users") {
        if (!isMgr) return fail("רק מנהל יכול לשנות עובדים", 403);
        if (route === "remove") {
          if (id === me) return fail("אי אפשר למחוק את עצמך");
          delete s.users[id];
          delete s.creds[id];
        } else {
          const cur = s.users[id];
          if (!cur || !obj) return fail("משתמש לא נמצא", 404);
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
        s.tasks[id] = obj;
      } else if (col === "messages") {
        const cur = s.messages[id];
        if (route === "remove") {
          if (!isMgr) return fail("פעולה לא תקינה", 403);
          delete s.messages[id];
        } else if (cur) {
          /* עדכון הודעה קיימת = סימון כנקרא, רק לנמען */
          const mine = isMgr ? cur.to === "managers" : cur.to === me;
          if (!mine) return fail("פעולה לא תקינה", 403);
          cur.read = !!obj?.read;
        } else {
          if (!obj) return fail("פעולה לא תקינה");
          s.messages[id] = { to: String(obj.to || ""), text: String(obj.text || "").slice(0, 600), at: Date.now(), from: u.name, read: false };
          pruneMessages(s);
        }
      } else {
        return fail("פעולה לא תקינה");
      }
      await save(s);
      return json({ state: view(s, me) });
    }

    return fail("not found", 404);
  } catch (e: any) {
    console.error(e);
    return fail("שגיאת שרת. נסה שוב.", 500);
  }
};

export const config = { path: "/api/*" };

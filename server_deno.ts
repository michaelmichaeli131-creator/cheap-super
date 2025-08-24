// server_deno.ts
// Deno Deploy + Hono (npm) + OpenAI Responses API + Google CSE (Programmable Search)
//
// זרימה:
// 1) לקוח שולח POST /api/search עם address, radius_km, list_text, use_web (true/false)
// 2) אם use_web=true → חיפוש בגוגל CSE, הבאת דפים, חילוץ טקסט → SOURCES
// 3) שולחים ל-OpenAI (למשל gpt-5) עם SOURCES בפרומפט, דורשים JSON קשיח
// 4) נרמול: אין מחיר 0; URL חשוד רק מסומן; מותג חובה; הצגת תוצאות חלקיות; מיון מהזול ליקר

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { serveStatic } from "npm:hono/serve-static";
import OpenAI from "npm:openai";

// ===== ENV =====
const OPENAI_KEY   = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-5";

const GOOGLE_CSE_KEY = Deno.env.get("GOOGLE_CSE_KEY") || "";
const GOOGLE_CSE_CX  = Deno.env.get("GOOGLE_CSE_CX")  || "";

const DEFAULT_PROVIDER = (Deno.env.get("DEFAULT_PROVIDER") || "openai").toLowerCase() as "openai";
const ALLOW_PROVIDER_OVERRIDE = (Deno.env.get("ALLOW_PROVIDER_OVERRIDE") || "true").toLowerCase()==="true";

const WEB_SEARCH_MAX_RESULTS   = Math.max(1, Number(Deno.env.get("WEB_SEARCH_MAX_RESULTS") || 6));
const PER_PAGE_CHAR_LIMIT      = Math.max(1000, Number(Deno.env.get("PER_PAGE_CHAR_LIMIT") || 20000));
const TOTAL_CORPUS_CHAR_LIMIT  = Math.max(5000, Number(Deno.env.get("TOTAL_CORPUS_CHAR_LIMIT") || 60000));
const DEBUG = (Deno.env.get("DEBUG") || "false").toLowerCase()==="true";

// ===== APP / CLIENT =====
const app = new Hono();
app.use("/api/*", cors({
  origin: "*",
  allowMethods: ["GET","POST","OPTIONS"],
  allowHeaders: ["Content-Type","Authorization"],
}));

const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

// ===== Utils =====
type ChatMsg = { role: "system" | "user"; content: string };

function extractJsonBlock(s: string): string {
  const start = s.indexOf("{"); const end = s.lastIndexOf("}");
  return (start>=0 && end>start) ? s.slice(start,end+1) : s.trim();
}
function safeParse<T=unknown>(t: string): {ok:true; data:T}|{ok:false; error:string} {
  try { return { ok:true, data: JSON.parse(t) as T }; } catch(e){ return { ok:false, error: (e as Error).message || "JSON parse error" }; }
}
function pickProvider(def:"openai", req?:string): "openai" {
  if (!ALLOW_PROVIDER_OVERRIDE) return def;
  const r = String(req||"").toLowerCase();
  return "openai"; // כרגע רק OpenAI
}
function truncate(s:string, max:number){ return s.length>max ? s.slice(0, max) : s; }

function isPlaceholderDomain(d:string){
  const x = (d||"").toLowerCase();
  return !x || x==="example.com" || x.endsWith(".example") || x==="localhost" || x==="127.0.0.1";
}
function isLikelyProductUrl(u:string){
  try{ const url = new URL(u); return /^https?:$/.test(url.protocol) && !!url.hostname && url.pathname.length>1; } catch { return false; }
}
function cityHintFromAddress(addr:string){
  const seg = addr.split(",")[0]?.trim() || addr.trim();
  return seg.split(/\s+/)[0] || seg;
}

// מציגים גם חנויות "חלקיות" (עם 0 מחירים אמינים) — הן יופיעו בסוף
const MIN_VALID_ITEMS_PER_STORE = 0;

// ===== OpenAI =====
async function callOpenAI(messages: ChatMsg[]): Promise<string> {
  if (!openai) throw new Error("Missing OPENAI_API_KEY");
  const resp = await openai.responses.create({ model: OPENAI_MODEL, input: messages });
  return resp.output_text ?? "";
}

// ===== Google CSE (Programmable Search) =====
type WebHit = { url: string; snippet: string };

async function googleCseSearch(q: string, count = WEB_SEARCH_MAX_RESULTS): Promise<WebHit[]> {
  if (!GOOGLE_CSE_KEY || !GOOGLE_CSE_CX) throw new Error("Missing GOOGLE_CSE_KEY/GOOGLE_CSE_CX");
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", GOOGLE_CSE_KEY);
  url.searchParams.set("cx",  GOOGLE_CSE_CX);
  url.searchParams.set("q",   q);
  url.searchParams.set("num", String(Math.min(10, Math.max(1, count))));
  url.searchParams.set("hl", "he");
  url.searchParams.set("lr", "lang_iw");

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google CSE failed: ${res.status} ${text}`);
  }
  const json = await res.json();
  const items = json.items ?? [];
  return items.map((it: any) => ({
    url: String(it.link || ""),
    snippet: String(it.snippet || it.title || "")
  })).filter(h => /^https?:\/\//i.test(h.url));
}

async function fetchPageText(url: string): Promise<string> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return "";
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return truncate(text, PER_PAGE_CHAR_LIMIT);
  } catch { return ""; }
}

// בניית שאילתות מתוך רשימת המוצרים + רמז עיר
function buildQueries(listText: string, cityHint: string): string[] {
  const items = listText
    .split(/[,;\n]/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 6);

  const qs: string[] = [];
  for (const it of items) {
    qs.push(`${it} מחיר ${cityHint}`);
    qs.push(`${it} קניה אונליין ${cityHint}`);
  }
  qs.push(`מחירי סופר ${cityHint}`);
  qs.push(`השוואת מחירים ${cityHint}`);
  return Array.from(new Set(qs)).slice(0, 8);
}

type SourceDoc = { url: string; excerpt: string };

async function webGather(address: string, listText: string): Promise<SourceDoc[]> {
  const city = cityHintFromAddress(address);
  const queries = buildQueries(listText, city);
  const results: SourceDoc[] = [];

  for (const q of queries) {
    const hits = await googleCseSearch(q, WEB_SEARCH_MAX_RESULTS);
    for (const h of hits) {
      const txt = await fetchPageText(h.url);
      if (txt.length < 400) continue; // טקסט קצר מדי
      results.push({ url: h.url, excerpt: txt });
      if (results.length >= WEB_SEARCH_MAX_RESULTS) break;
    }
    if (results.length >= WEB_SEARCH_MAX_RESULTS) break;
  }

  // תקרת קורפוס כוללת
  let total = 0;
  const picked: SourceDoc[] = [];
  for (const r of results) {
    const l = r.excerpt.length;
    if (total + l > TOTAL_CORPUS_CHAR_LIMIT) break;
    picked.push(r);
    total += l;
  }
  return picked;
}

// ===== תיקון צורה (coerce) אם ה-LLM לא החזיר בדיוק {status,results}
function looksLikeStoreArray(x:any): boolean {
  return Array.isArray(x) && x.length>0 && typeof x[0] === "object";
}
function coerceToResultsShape(data:any){
  if (!data || typeof data !== "object") {
    if (Array.isArray(data)) return { status:"ok", results:data };
    return null;
  }
  if (Array.isArray(data.results)) {
    if (!data.status) data.status = "ok";
    return data;
  }
  if (looksLikeStoreArray((data as any).stores)) return { status:"ok", results:(data as any).stores };
  if (looksLikeStoreArray((data as any).items))  return { status:"ok", results:(data as any).items  };
  if (looksLikeStoreArray((data as any).data))   return { status:"ok", results:(data as any).data   };
  if (looksLikeStoreArray((data as any).output)) return { status:"ok", results:(data as any).output };

  const k = Object.keys(data).find(key => looksLikeStoreArray((data as any)[key]));
  if (k) return { status:"ok", results:(data as any)[k] };
  return null;
}

// ===== API =====
app.get("/api/health", (c) =>
  c.json({
    ok: true,
    default_provider: DEFAULT_PROVIDER,
    allow_provider_override: ALLOW_PROVIDER_OVERRIDE,
    openai_model: OPENAI_MODEL,
    has_openai_key: !!OPENAI_KEY,
    has_google_cse_key: !!GOOGLE_CSE_KEY,
    has_google_cse_cx: !!GOOGLE_CSE_CX,
    web_search_max_results: WEB_SEARCH_MAX_RESULTS,
    debug: DEBUG
  })
);

app.post("/api/search", async (c) => {
  try {
    const body = await c.req.json().catch(()=> ({}));
    const address   = String(body?.address ?? "").trim();
    const radius_km = Number(body?.radius_km ?? 0);
    const list_text = String(body?.list_text ?? "").trim();
    const providerReq = String(body?.provider ?? "").toLowerCase();
    const use_web  = !!body?.use_web;

    const needed: string[] = [];
    if (!address) needed.push("address");
    if (!radius_km || isNaN(radius_km)) needed.push("radius_km");
    if (!list_text) needed.push("list_text");
    if (needed.length) return c.json({ status:"need_input", needed }, 400);

    const provider = pickProvider(DEFAULT_PROVIDER, providerReq);
    if (!OPENAI_KEY) return c.json({ status:"error", message:"OPENAI_API_KEY is missing" }, 500);

    // === איסוף מקורות מהרשת (אופציונלי) ===
    let sources: SourceDoc[] = [];
    if (use_web) {
      if (!GOOGLE_CSE_KEY || !GOOGLE_CSE_CX) {
        return c.json({ status:"error", message:"GOOGLE_CSE_KEY/GOOGLE_CSE_CX is missing but use_web=true" }, 500);
      }
      sources = await webGather(address, list_text);
    }

    // === פרומפטים ===
    const BASE_SYSTEM = `
You are an Israeli grocery price-comparison agent.
Output MUST be ONLY strict JSON (no markdown).
Top-level shape MUST be:
{ "status": "ok", "results": [ ... ] }

Rules:
- Return 3–4 stores within the given radius, sorted by total_price ascending (cheapest first).
- Each basket item MUST include a non-empty brand (e.g., מי עדן, קלסברג, תנובה). If user input is generic, pick a common Israeli brand and add a short note.
- Never output unit_price = 0. If unsure, set unit_price = null and add a short note (do not guess).
- Currency must be "₪".
`.trim();

    // מקטע מקורות (אם יש)
    const SOURCES = sources.length
      ? `SOURCES (real excerpts with URLs):
${sources.map((s, i) => `[#${i+1}] URL: ${s.url}
EXCERPT: ${truncate(s.excerpt, 1500)}
`).join("\n")}`
      : `SOURCES: (none provided — rely on general knowledge cautiously; prefer setting unit_price=null if unsure)`;

    const user = `
Address: ${address}
Radius_km: ${radius_km}
User list (free text; commas optional): ${list_text}

${SOURCES}

Important:
- Use the SOURCES above to extract concrete product prices, package sizes and brands. Prefer real product pages/price listings from the URLs above.
- If the provided SOURCES are not sufficient for an item, set unit_price = null and add a short note.
- If you would return an array directly, WRAP it as: { "status": "ok", "results": [ ... ] }.
`.trim();

    // === קריאה ל-OpenAI ===
    const messages: ChatMsg[] = [
      { role:"system", content: BASE_SYSTEM },
      { role:"user",   content: user }
    ];
    const raw = await callOpenAI(messages);
    const rawText = extractJsonBlock(raw);

    // === Parse + Coerce ===
    const parsed = safeParse<any>(rawText);
    if (!parsed.ok) {
      return c.json({
        status: "error",
        message: "LLM returned non-JSON text",
        details: parsed.error,
        raw_preview: String(rawText).slice(0, 1200),
        provider,
        use_web
      }, 502);
    }
    let data = parsed.data;

    if (!(data && data.status === "ok" && Array.isArray(data.results))) {
      const coerced = coerceToResultsShape(data);
      if (coerced) data = coerced;
    }
    if (!(data && data.status === "ok" && Array.isArray(data.results))) {
      return c.json({ status: "no_results", provider, use_web, message: "Unexpected shape from LLM", raw: data }, 200);
    }

    // === Normalize & validate ===
    const cleaned:any[] = [];
    for (const r of (data.results || [])) {
      let validCount = 0;

      for (const b of (r.basket || [])) {
        // URL חשוד — רק סימון (לא מפילים מחיר)
        const urlOk = isLikelyProductUrl(b.product_url || "");
        const placeholder = isPlaceholderDomain(b.source_domain || "");
        if (!urlOk || placeholder) {
          b.notes = (b.notes||"") + " • קישור חשוד/placeholder";
        }

        // מחיר: לא 0, בטווח סביר (עד 1999)
        if (!(typeof b.unit_price==="number" && b.unit_price>0 && b.unit_price<1999)) {
          b.unit_price = null;
          b.line_total = 0;
          if (!/סומן כ-null/.test(b.notes||"")) {
            b.notes = (b.notes||"") + " • מחיר לא נמצא/לא הגיוני — סומן כ-null";
          }
        } else {
          b.line_total = +(Number(b.unit_price) * Number(b.quantity || 1)).toFixed(2);
          validCount++;
        }

        // מותג חובה
        if (typeof b.brand !== "string" || !b.brand.trim()) {
          b.brand = "מותג נפוץ";
          b.notes = (b.notes||"") + " • הוסף מותג כללי כי לא צוין";
        }

        // ניקוי ניסוחים מעורפלים
        if (typeof b.notes === "string") {
          b.notes = b.notes.replace(/price may vary|~|≈|about/gi, "").trim();
        }
      }

      if (validCount === 0) {
        r.total_price = null;
        r.notes = (r.notes || "") + " • אין מספיק מחירים תקפים — מוצג מידע חלקי";
      } else {
        r.total_price = +((r.basket || [])
          .reduce((s:number,b:any)=> s + (typeof b.unit_price==="number" ? b.unit_price*(b.quantity||1) : 0), 0)
          .toFixed(2));
      }

      cleaned.push(r);
    }

    if (!cleaned.length) {
      return c.json({
        status:"no_results",
        provider,
        use_web,
        message:"לא נמצאו חנויות. נסו להרחיב רדיוס, לציין מותג/נפח מדויק, או לחפש שוב."
      }, 200);
    }

    // מיון: חנויות עם total_price מספרי קודם; null בסוף
    cleaned.sort((a:any,b:any)=>{
      const A = (typeof a.total_price === "number") ? a.total_price : Infinity;
      const B = (typeof b.total_price === "number") ? b.total_price : Infinity;
      return A - B;
    });
    cleaned.forEach((r:any,i:number)=> r.rank=i+1);

    const payload:any = { status:"ok", provider, use_web, results: cleaned };
    if (DEBUG) {
      payload.debug = {
        sources_count: sources.length,
        sample_urls: sources.slice(0, Math.min(5, sources.length)).map(s=>s.url)
      };
    }
    return c.json(payload, 200);

  } catch (err) {
    console.error(err);
    return c.json({ status:"error", message:String(err) }, 500);
  }
});

// ===== Static frontend (אם יש תיקיית public) =====
app.use("/assets/*", serveStatic({ root: "./public" }));
app.use("/img/*",    serveStatic({ root: "./public" }));
app.use("/public/*", serveStatic({ root: "./public" }));

app.get("/", async (c) => {
  try {
    const html = await Deno.readTextFile("./public/index.html");
    return c.newResponse(html, 200, { "content-type": "text/html; charset=utf-8" });
  } catch {
    return c.newResponse(FALLBACK_HTML, 200, { "content-type": "text/html; charset=utf-8" });
  }
});
app.notFound(async (c) => {
  try {
    const html = await Deno.readTextFile("./public/index.html");
    return c.newResponse(html, 200, { "content-type": "text/html; charset=utf-8" });
  } catch {
    return c.newResponse(FALLBACK_HTML, 200, { "content-type": "text/html; charset=utf-8" });
  }
});

export default app;

// ===== Fallback inline HTML (דף בדיקה מהיר) =====
const FALLBACK_HTML = `<!doctype html>
<html lang="he" dir="rtl">
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CartCompare AI — OpenAI + Google CSE</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f9ff;color:#0d1321;margin:0}
  .wrap{max-width:440px;margin:0 auto;padding:16px}
  .box{background:#fff;border-radius:16px;padding:16px;box-shadow:0 10px 30px rgba(15,50,90,.08)}
  .input{display:flex;flex-direction:column;gap:8px;margin-top:8px}
  input,textarea,select{padding:12px;border:1px solid #e6edf7;border-radius:12px}
  .btn{border:0;border-radius:12px;padding:12px 14px;background:#111;color:#fff;font-weight:800;cursor:pointer;margin-top:10px}
  .row{display:flex;justify-content:space-between;align-items:center;padding:12px;border:1px solid #eaf1fb;border-radius:12px}
  .row+.row{margin-top:8px}
  .muted{color:#6b7280;font-size:12px}
</style>
<div class="wrap">
  <h2>CartCompare AI — OpenAI + Google CSE</h2>
  <div class="box">
    <div class="input"><label>use_web</label>
      <select id="use_web"><option value="true">true</option><option value="false">false</option></select>
    </div>
    <div class="input"><label>כתובת</label><input id="addr" placeholder="חולון, סוקולוב 10"></div>
    <div class="input"><label>רדיוס (ק״מ)</label><input id="rad" type="number" value="5"></div>
    <div class="input"><label>רשימת קניות</label><textarea id="lst" rows="4" placeholder="שישיית מי עדן, חזה עוף 1 ק\"ג, 2 בירות קלסברג"></textarea></div>
    <button class="btn" onclick="go()">חפש</button>
  </div>
  <div id="out" style="margin-top:12px"></div>
</div>
<script>
async function go(){
  const out=document.getElementById('out');
  out.innerHTML='טוען...';
  try{
    const res=await fetch('/api/search',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        address:addr.value.trim(),
        radius_km:Number(rad.value||5),
        list_text:lst.value.trim(),
        provider:"openai",
        use_web: document.getElementById('use_web').value==="true"
      })});
    const data=await res.json();
    if(!res.ok){ out.innerHTML='שגיאת שרת: '+(data.message||res.status); return; }
    if(data.status!=='ok'){ out.innerHTML='אין תוצאות: '+(data.message||''); return; }
    out.innerHTML =
      '<div class="muted">use_web: '+data.use_web+'</div>' +
      (data.debug? '<div class="muted">sources: '+(data.debug.sources_count||0)+' | '+(data.debug.sample_urls||[]).join(', ')+'</div>' : '') +
      data.results.map(r=>{
        const total = (typeof r.total_price==='number') ? Number(r.total_price||0).toFixed(2) : '—';
        const rows=(r.basket||[]).map(b=>{
          const unit=(typeof b.unit_price==='number')? Number(b.unit_price||0).toFixed(2) : '—';
          const line=(typeof b.line_total==='number')? Number(b.line_total||0).toFixed(2) : '—';
          const brand=b.brand? ' <span class="muted">• '+escapeHtml(b.brand)+'</span>':'';
          const sub=b.substitution? ' <span class="muted">(תחליף)</span>':'';
          const src=b.product_url? '<div class="muted"><a href="'+escapeAttr(b.product_url)+'" target="_blank" rel="noopener">מקור</a> '+(b.source_domain? '• '+escapeHtml(b.source_domain):'')+'</div>':'';
          const notes=b.notes? '<div class="muted">'+escapeHtml(b.notes)+'</div>':'';
          return '<div class="row"><div><strong>'+escapeHtml(b.name)+'</strong>'+brand+sub+'<div class="muted">כמות: '+escapeHtml(b.quantity)+'</div>'+src+notes+'</div><div>'+line+' '+escapeHtml(r.currency||"₪")+'</div></div>';
        }).join('');
        const storeNotes = r.notes? '<div class="muted">'+escapeHtml(r.notes)+'</div>' : '';
        return '<div class="row"><div><strong>#'+r.rank+' — '+escapeHtml(r.store_name||"")+'</strong><div class="muted">'+escapeHtml(r.address||"")+' • '+escapeHtml(r.distance_km||"")+" ק״מ"+'</div>'+storeNotes+'</div><div>'+total+' '+escapeHtml(r.currency||"₪")+'</div></div><div style="height:8px"></div>'+rows;
      }).join('');
  }catch(e){ out.innerHTML='שגיאת רשת: '+e.message; }
}
function escapeHtml(s){return String(s??'').replace(/[&<>"'\/]/g,c=>({"&":"&amp;","<":"&lt;"," >":"&gt;","\"":"&quot;","'":"&#39;","/":"&#x2F;"}[c]||c))}
function escapeAttr(s){return String(s??'').replace(/"/g,'&quot;')}
</script>
</html>`;

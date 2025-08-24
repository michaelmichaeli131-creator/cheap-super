// Deno Deploy + Hono + OpenAI Responses API + Bing Web Search
// בחירה בין חיפוש רשת חי לבין LLM בלבד ע"י use_web (ב-body של הבקשה)

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { serveStatic } from "npm:hono/serve-static";
import OpenAI from "npm:openai";

// ===== ENV =====
const OPENAI_KEY   = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-5";

const BING_KEY     = Deno.env.get("BING_SUBSCRIPTION_KEY") || "";
const BING_ENDPOINT = "https://api.bing.microsoft.com/v7.0/search";

const DEFAULT_PROVIDER = (Deno.env.get("DEFAULT_PROVIDER") || "openai").toLowerCase() as "openai";
const ALLOW_PROVIDER_OVERRIDE = (Deno.env.get("ALLOW_PROVIDER_OVERRIDE") || "true").toLowerCase() === "true";

// טיונינג של החיפוש/קורפוס
const WEB_SEARCH_MAX_RESULTS = Math.max(1, Number(Deno.env.get("WEB_SEARCH_MAX_RESULTS") || 5));
const PER_PAGE_CHAR_LIMIT    = Math.max(1000, Number(Deno.env.get("PER_PAGE_CHAR_LIMIT") || 20000));
const TOTAL_CORPUS_CHAR_LIMIT= Math.max(5000, Number(Deno.env.get("TOTAL_CORPUS_CHAR_LIMIT") || 60000));

// ===== APP / CLIENTS =====
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
  return "openai"; // בגרסה הזו יש רק OpenAI
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
  // הוצאת שם העיר בפשטות (לפחות המילה הראשונה/לפני פסיק)
  const seg = addr.split(",")[0]?.trim() || addr.trim();
  return seg.split(/\s+/)[0] || seg;
}
const MIN_VALID_ITEMS_PER_STORE = 1; // כדי לא “להפיל” הכל

// ===== OpenAI =====
async function callOpenAI(messages: ChatMsg[]): Promise<string> {
  if (!openai) throw new Error("Missing OPENAI_API_KEY");
  const resp = await openai.responses.create({ model: OPENAI_MODEL, input: messages });
  return resp.output_text ?? "";
}

// ===== Bing Search =====
async function bingSearch(q: string, count = WEB_SEARCH_MAX_RESULTS) {
  if (!BING_KEY) throw new Error("Missing BING_SUBSCRIPTION_KEY");
  const url = new URL(BING_ENDPOINT);
  url.searchParams.set("q", q);
  url.searchParams.set("count", String(count));
  url.searchParams.set("mkt", "he-IL");
  const res = await fetch(url.toString(), {
    headers: { "Ocp-Apim-Subscription-Key": BING_KEY }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bing search failed: ${res.status} ${text}`);
  }
  const json = await res.json();
  const webPages = json.webPages?.value || [];
  return webPages.map((v: any) => ({
    name: v.name as string,
    url: v.url as string,
    snippet: v.snippet as string,
    displayUrl: v.displayUrl as string
  }));
}

async function fetchPageText(url: string): Promise<string> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return "";
    const html = await res.text();
    // הפשטת HTML → טקסט
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return truncate(text, PER_PAGE_CHAR_LIMIT);
  } catch {
    return "";
  }
}

// בניית ביטויי חיפוש בסיסיים מתוך רשימת המוצרים + העיר
function buildQueries(listText: string, cityHint: string): string[] {
  const items = listText
    .split(/[,;\n]/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 6); // לא להגזים
  const qs: string[] = [];
  // לכל פריט – חיפוש פריט + עיר
  for (const it of items) {
    qs.push(`${it} מחיר ${cityHint}`);
    qs.push(`${it} קניה אונליין ${cityHint}`);
  }
  // חיפוש סל כולל
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
    const hits = await bingSearch(q);
    for (const h of hits) {
      if (!/^https?:\/\//i.test(h.url)) continue;
      const txt = await fetchPageText(h.url);
      if (txt.length < 400) continue; // טקסט קצר מדי לא שימושי
      results.push({ url: h.url, excerpt: txt });
      if (results.length >= WEB_SEARCH_MAX_RESULTS) break;
    }
    if (results.length >= WEB_SEARCH_MAX_RESULTS) break;
  }
  // הגבול הכולל לקורפוס
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

// ===== API =====
app.get("/api/health", (c) =>
  c.json({
    ok: true,
    default_provider: DEFAULT_PROVIDER,
    allow_provider_override: ALLOW_PROVIDER_OVERRIDE,
    openai_model: OPENAI_MODEL,
    has_openai_key: !!OPENAI_KEY,
    has_bing_key: !!BING_KEY,
    web_search_max_results: WEB_SEARCH_MAX_RESULTS
  })
);

app.post("/api/search", async (c) => {
  try {
    const body = await c.req.json().catch(()=> ({}));
    const address   = String(body?.address ?? "").trim();
    const radius_km = Number(body?.radius_km ?? 0);
    const list_text = String(body?.list_text ?? "").trim();
    const providerReq = String(body?.provider ?? "").toLowerCase();
    const use_web  = !!body?.use_web; // <— חדש: להדליק/לכבות חיפוש רשת

    const needed: string[] = [];
    if (!address) needed.push("address");
    if (!radius_km || isNaN(radius_km)) needed.push("radius_km");
    if (!list_text) needed.push("list_text");
    if (needed.length) return c.json({ status:"need_input", needed }, 400);

    const provider = pickProvider(DEFAULT_PROVIDER, providerReq);
    if (!OPENAI_KEY) return c.json({ status:"error", message:"OPENAI_API_KEY is missing" }, 500);

    // === קונטקסט מהרשת (אופציונלי) ===
    let sources: SourceDoc[] = [];
    if (use_web) {
      if (!BING_KEY) return c.json({ status:"error", message:"BING_SUBSCRIPTION_KEY is missing but use_web=true" }, 500);
      sources = await webGather(address, list_text);
    }

    // === פרומפטים ===
    const BASE_SYSTEM = `
You are an Israeli grocery price-comparison agent.
Output MUST be ONLY strict JSON (no markdown).
Top-level shape MUST be:
{ "status": "ok", "results": [ ... ] }

Rules:
- Return 3–4 stores within the given radius, sorted by total_price ascending.
- Each basket item MUST include a non-empty brand (e.g., מי עדן, קלסברג, תנובה). If user input is generic, pick a common Israeli brand and add a short note.
- If a current unit price cannot be verified from the information provided, set unit_price = null and add a short note (do not guess; never use 0).
- Currency must be "₪".
`.trim();

    // נבנה קטע SOURCES שמכיל סניפטים אמיתיים מהרשת (אם use_web=true)
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

    // === קריאה ל-OpenAI (אין fallback) ===
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

    // נרמול אם לא חזר בדיוק {status:"ok",results:[...]}
    function looksLikeStoreArray(x:any){ return Array.isArray(x) && x.length>0 && typeof x[0]==="object"; }
    function coerceToResultsShape(d:any){
      if (!d || typeof d !== "object") { if (Array.isArray(d)) return { status:"ok", results:d }; return null; }
      if (Array.isArray(d.results)) { if (!d.status) d.status="ok"; return d; }
      if (looksLikeStoreArray(d.stores)) return { status:"ok", results:d.stores };
      if (looksLikeStoreArray(d.items))  return { status:"ok", results:d.items  };
      if (looksLikeStoreArray(d.data))   return { status:"ok", results:d.data   };
      if (looksLikeStoreArray(d.output)) return { status:"ok", results:d.output };
      const k = Object.keys(d).find(key=>looksLikeStoreArray(d[key]));
      if (k) return { status:"ok", results:d[k] };
      return null;
    }
    if (!(data && data.status==="ok" && Array.isArray(data.results))) {
      const coerced = coerceToResultsShape(data);
      if (coerced) data = coerced;
    }
    if (!(data && data.status==="ok" && Array.isArray(data.results))) {
      return c.json({ status:"no_results", provider, use_web, message:"Unexpected shape from LLM", raw: data }, 200);
    }

    // === Normalize & validate (מונע 0/placeholder/URL לא אמיתי) ===
    const cleaned:any[] = [];
    for (const r of (data.results || [])) {
      let validCount = 0;

      for (const b of (r.basket || [])) {
        // URL/Domain – לא מפילים מחיר בגלל URL לא “מושלם”; רק מסמנים הערה אם placeholder/לא אמין
        const urlOk = isLikelyProductUrl(b.product_url || "");
        const placeholder = isPlaceholderDomain(b.source_domain || "");
        if (!urlOk || placeholder) {
          b.notes = (b.notes||"") + " • קישור חשוד/placeholder";
        }

        // מחיר אמיתי (לא 0/לא מופרך)
        if (!(typeof b.unit_price==="number" && b.unit_price>0 && b.unit_price<999)) {
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

      if (validCount < MIN_VALID_ITEMS_PER_STORE) continue;

      r.total_price = +((r.basket || [])
        .reduce((s:number,b:any)=> s + (typeof b.unit_price==="number" ? b.unit_price*(b.quantity||1) : 0), 0)
        .toFixed(2));

      cleaned.push(r);
    }

    if (!cleaned.length) {
      return c.json({
        status:"no_results",
        provider,
        use_web,
        message:"לא נמצאו חנויות עם מספיק מחירים תקפים. נסו להרחיב רדיוס, לציין מותג/נפח מדויק, או לחפש שוב."
      }, 200);
    }

    cleaned.sort((a:any,b:any)=> (a.total_price||0)-(b.total_price||0));
    cleaned.forEach((r:any,i:number)=> r.rank=i+1);

    return c.json({ status:"ok", provider, use_web, results: cleaned }, 200);

  } catch (err) {
    console.error(err);
    return c.json({ status:"error", message:String(err) }, 500);
  }
});

// ===== Static frontend =====
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
<title>CartCompare AI — Web+OpenAI</title>
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
  <h2>CartCompare AI — OpenAI + Bing Web</h2>
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
      data.results.map(r=>{
        const total=Number(r.total_price||0).toFixed(2);
        const rows=(r.basket||[]).map(b=>{
          const unit=(typeof b.unit_price==='number')? Number(b.unit_price||0).toFixed(2) : '—';
          const line=(typeof b.line_total==='number')? Number(b.line_total||0).toFixed(2) : '—';
          const brand=b.brand? ' <span class="muted">• '+escapeHtml(b.brand)+'</span>':'';
          const sub=b.substitution? ' <span class="muted">(תחליף)</span>':'';
          const src=b.product_url? '<div class="muted"><a href="'+escapeAttr(b.product_url)+'" target="_blank" rel="noopener">מקור</a></div>':'';
          const notes=b.notes? '<div class="muted">'+escapeHtml(b.notes)+'</div>':'';
          return '<div class="row"><div><strong>'+escapeHtml(b.name)+'</strong>'+brand+sub+'<div class="muted">כמות: '+escapeHtml(b.quantity)+'</div>'+src+notes+'</div><div>'+line+' '+escapeHtml(r.currency||"₪")+'</div></div>';
        }).join('');
        return '<div class="row"><div><strong>#'+r.rank+' — '+escapeHtml(r.store_name||"")+'</strong><div class="muted">'+escapeHtml(r.address||"")+' • '+escapeHtml(r.distance_km||"")+' ק״מ</div></div><div>'+total+' '+escapeHtml(r.currency||"₪")+'</div></div><div style="height:8px"></div>'+rows;
      }).join('');
  }catch(e){ out.innerHTML='שגיאת רשת: '+e.message; }
}
function escapeHtml(s){return String(s??'').replace(/[&<>"'\/]/g,c=>({"&":"&amp;","<":"&lt;"," >":"&gt;","\"":"&quot;","'":"&#39;","/":"&#x2F;"}[c]||c))}
function escapeAttr(s){return String(s??'').replace(/"/g,'&quot;')}
</script>
</html>`;

// server_deno.ts
// Deno Deploy + Hono (npm) + OpenAI (Responses API) + Google Gemini (Structured Output)
// בחירת ספק: OpenAI/Gemini לפי body.provider או ברירת מחדל מה-ENV. אין fallback.

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { serveStatic } from "npm:hono/serve-static";
import OpenAI from "npm:openai";
import { GoogleGenerativeAI, SchemaType } from "npm:@google/generative-ai";

// ===== ENV =====
const OPENAI_KEY   = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-5";

const GEMINI_KEY   = Deno.env.get("GEMINI_API_KEY") || "";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-1.5-pro-002";

const DEFAULT_PROVIDER = (Deno.env.get("DEFAULT_PROVIDER") || "openai").toLowerCase() as "openai" | "gemini";
const ALLOW_PROVIDER_OVERRIDE = (Deno.env.get("ALLOW_PROVIDER_OVERRIDE") || "true").toLowerCase() === "true";

// ===== APP / CLIENTS =====
const app = new Hono();
app.use("/api/*", cors({
  origin: "*",
  allowMethods: ["GET","POST","OPTIONS"],
  allowHeaders: ["Content-Type","Authorization"],
}));

const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;
const genAI  = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;

// ===== Utils =====
type ChatMsg = { role: "system" | "user"; content: string };

function extractJsonBlock(s: string): string {
  const start = s.indexOf("{"); const end = s.lastIndexOf("}");
  return (start>=0 && end>start) ? s.slice(start,end+1) : s.trim();
}
function safeParse<T=unknown>(t: string): {ok:true; data:T}|{ok:false; error:string} {
  try { return { ok:true, data: JSON.parse(t) as T }; } catch(e){ return { ok:false, error: (e as Error).message || "JSON parse error" }; }
}
function pickProvider(def:"openai"|"gemini", req?:string): "openai"|"gemini" {
  if (!ALLOW_PROVIDER_OVERRIDE) return def;
  const r = String(req||"").toLowerCase();
  return (r==="gemini" || r==="openai") ? (r as any) : def;
}

// תיקון צורה לתשובות LLM “שונות מעט”
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

// סינונים/ולידציה
function isPlaceholderDomain(d:string){
  const x = (d||"").toLowerCase();
  return !x || x==="example.com" || x.endsWith(".example") || x==="localhost" || x==="127.0.0.1";
}
function isLikelyProductUrl(u:string){
  try{
    const url = new URL(u);
    return /^https?:$/.test(url.protocol) && !!url.hostname && url.pathname.length>1;
  }catch{ return false; }
}
const MIN_VALID_ITEMS_PER_STORE = 2; // מינימום פריטים עם מחיר תקין כדי לשמור חנות

// ===== OpenAI =====
async function callOpenAI(messages: ChatMsg[]): Promise<string> {
  if (!openai) throw new Error("Missing OPENAI_API_KEY");
  const resp = await openai.responses.create({ model: OPENAI_MODEL, input: messages });
  return resp.output_text ?? "";
}

// ===== Gemini (Structured Output) =====
const SearchResultsSchema = {
  type: SchemaType.OBJECT,
  properties: {
    status: { type: SchemaType.STRING },
    results: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          rank: { type: SchemaType.NUMBER },
          store_name: { type: SchemaType.STRING },
          address: { type: SchemaType.STRING },
          distance_km: { type: SchemaType.NUMBER },
          currency: { type: SchemaType.STRING },
          total_price: { type: SchemaType.NUMBER },
          match_overall: { type: SchemaType.NUMBER },
          basket: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                name: { type: SchemaType.STRING },
                brand: { type: SchemaType.STRING },
                quantity: { type: SchemaType.NUMBER },
                unit_price: { type: SchemaType.NUMBER, nullable: true },
                line_total: { type: SchemaType.NUMBER },
                match_confidence: { type: SchemaType.NUMBER },
                substitution: { type: SchemaType.BOOLEAN },
                notes: { type: SchemaType.STRING },
                price_source: { type: SchemaType.STRING },
                product_url: { type: SchemaType.STRING },
                source_domain: { type: SchemaType.STRING },
                last_checked: { type: SchemaType.STRING }
              },
              required: ["name","brand","quantity","line_total","match_confidence","substitution","notes","price_source","product_url","source_domain","last_checked"]
            }
          },
          sources: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } }
        },
        required: ["rank","store_name","distance_km","currency","total_price","basket"]
      }
    }
  },
  required: ["status","results"]
} as const;

async function callGeminiStructured(systemPrompt: string, userPrompt: string): Promise<string> {
  if (!genAI) throw new Error("Missing GEMINI_API_KEY");
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: SearchResultsSchema as any,
    },
  });
  const content = `${systemPrompt}\n\n${userPrompt}`.trim(); // ללא role/parts
  const res = await model.generateContent(content);
  return res.response?.text?.() ?? "";
}

// ===== API =====
app.get("/api/health", (c) =>
  c.json({
    ok: true,
    default_provider: DEFAULT_PROVIDER,
    allow_provider_override: ALLOW_PROVIDER_OVERRIDE,
    openai_model: OPENAI_MODEL,
    gemini_model: GEMINI_MODEL,
    has_openai_key: !!OPENAI_KEY,
    has_gemini_key: !!GEMINI_KEY,
  })
);

app.post("/api/search", async (c) => {
  try {
    const body = await c.req.json().catch(()=> ({}));
    const address   = String(body?.address ?? "").trim();
    const radius_km = Number(body?.radius_km ?? 0);
    const list_text = String(body?.list_text ?? "").trim();
    const requested = String(body?.provider ?? "").toLowerCase();

    const needed:string[]=[];
    if(!address) needed.push("address");
    if(!radius_km || isNaN(radius_km)) needed.push("radius_km");
    if(!list_text) needed.push("list_text");
    if(needed.length) return c.json({ status:"need_input", needed }, 400);

    const provider = pickProvider(DEFAULT_PROVIDER, requested);

    // ===== פרומפטים מחוזקים לכל ספק =====
    const BASE_SYSTEM = `
You are an Israeli grocery price-comparison agent.
Output MUST be ONLY strict JSON (no markdown).
Top-level shape MUST be:
{ "status": "ok", "results": [ ... ] }

Rules:
- Return 3–4 stores within the given radius, sorted by total_price ascending.
- Each basket item MUST include a non-empty brand (e.g., מי עדן, קלסברג, תנובה). If user input is generic, pick a common Israeli brand and add a short note.
- If a current unit price cannot be verified from a real product page, set unit_price = null and add a short note (do not guess).
- Currency must be "₪".
`.trim();

    const OPENAI_EXTRA = `
STRICT: Never output unit_price = 0. If unsure, set unit_price = null and explain briefly in "notes".
Do not use placeholders or vague wording like "price may vary", "about", "~".
Every product_url must be a real product page (no example.com, no localhost).
`.trim();

    const GEMINI_EXTRA = `
Do not use placeholder domains (e.g., example.com). Provide real product URLs only.
Avoid vague phrases like "price may vary" — either provide a concrete current price or set unit_price = null with a short note.
`.trim();

    const system =
      provider === "openai"
        ? `${BASE_SYSTEM}\n\n${OPENAI_EXTRA}`
        : `${BASE_SYSTEM}\n\n${GEMINI_EXTRA}`;

    const user = `
Address: ${address}
Radius_km: ${radius_km}
User list (free text; commas optional): ${list_text}

Important:
- If you would return an array directly, WRAP it as:
  { "status": "ok", "results": [ ... ] }
`.trim();

    // ===== קריאה לספק הנבחר (ללא fallback) =====
    let rawText = "";
    if (provider === "gemini") {
      if (!GEMINI_KEY) return c.json({ status:"error", message:"GEMINI_API_KEY is missing" }, 500);
      rawText = await callGeminiStructured(system, user);
    } else {
      if (!OPENAI_KEY) return c.json({ status:"error", message:"OPENAI_API_KEY is missing" }, 500);
      const messages: ChatMsg[] = [{ role:"system", content: system }, { role:"user", content: user }];
      const raw = await callOpenAI(messages);
      rawText = extractJsonBlock(raw);
    }

    // ===== Parse + Coerce =====
    const parsed = safeParse<any>(rawText);
    if (!parsed.ok) {
      return c.json({
        status: "error",
        message: "LLM returned non-JSON text",
        details: parsed.error,
        raw_preview: String(rawText).slice(0, 1200),
        provider
      }, 502);
    }
    let data = parsed.data;

    if (!(data && data.status === "ok" && Array.isArray(data.results))) {
      const coerced = coerceToResultsShape(data);
      if (coerced) data = coerced;
    }
    if (!(data && data.status === "ok" && Array.isArray(data.results))) {
      return c.json({ status: "no_results", provider, message: "Unexpected shape from LLM", raw: data }, 200);
    }

    // ===== Normalize & validate (מונע 0/פלייסהולדר/כתובת לא אמיתית) =====
    const cleaned:any[] = [];
    for (const r of (data.results || [])) {
      let validCount = 0;

      for (const b of (r.basket || [])) {
        // 1) URL אמיתי + בלי placeholder domain
        const urlOk = isLikelyProductUrl(b.product_url || "");
        const placeholder = isPlaceholderDomain(b.source_domain || "");
        if (!urlOk || placeholder) {
          b.unit_price = null;
          b.line_total = 0;
          b.notes = (b.notes||"") + " • קישור לא תקין/placeholder — סומן כ-null";
        }

        // 2) מחיר אמיתי (לא 0/לא מופרך)
        if (!(typeof b.unit_price==="number" && b.unit_price>0 && b.unit_price<500)) {
          b.unit_price = null;
          b.line_total = 0;
          if (!/סומן כ-null/.test(b.notes||"")) {
            b.notes = (b.notes||"") + " • מחיר לא נמצא/לא הגיוני — סומן כ-null";
          }
        } else {
          b.line_total = +(Number(b.unit_price) * Number(b.quantity || 1)).toFixed(2);
          validCount++;
        }

        // 3) מותג חובה
        if (typeof b.brand !== "string" || !b.brand.trim()) {
          b.brand = "מותג נפוץ";
          b.notes = (b.notes||"") + " • הוסף מותג כללי כי לא צוין";
        }

        // 4) ניקוי ניסוחים מעורפלים
        if (typeof b.notes === "string") {
          b.notes = b.notes.replace(/price may vary|~|≈|about/gi, "").trim();
        }
      }

      // דילוג על חנויות “ריקות”
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
        message:"לא נמצאו חנויות עם מספיק מחירים תקפים. נסו להרחיב רדיוס, לציין מותג/נפח מדויק, או לשנות ניסוח."
      }, 200);
    }

    cleaned.sort((a:any,b:any)=> (a.total_price||0)-(b.total_price||0));
    cleaned.forEach((r:any,i:number)=> r.rank=i+1);

    return c.json({ status:"ok", provider, results: cleaned }, 200);

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

// ===== Fallback inline HTML (דיבאג מהיר) =====
const FALLBACK_HTML = `<!doctype html>
<html lang="he" dir="rtl">
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CartCompare AI — Fallback</title>
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
  <h2>CartCompare AI — Fallback</h2>
  <div class="box">
    <div class="input"><label>ספק</label>
      <select id="provider">
        <option value="openai">OpenAI (GPT-5)</option>
        <option value="gemini">Gemini (1.5 Pro)</option>
      </select>
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
        provider:document.getElementById('provider').value
      })});
    const data=await res.json();
    if(!res.ok){ out.innerHTML='שגיאת שרת: '+(data.message||res.status); return; }
    if(data.status!=='ok'){ out.innerHTML='אין תוצאות: '+(data.message||''); return; }
    out.innerHTML =
      '<div class="muted">Provider: '+(data.provider||'')+'</div>' +
      data.results.map(r=>{
        const total=Number(r.total_price||0).toFixed(2);
        const rows=(r.basket||[]).map(b=>{
          const unit=(typeof b.unit_price==='number')? Number(b.unit_price||0).toFixed(2) : '—';
          const line=(typeof b.line_total==='number')? Number(b.line_total||0).toFixed(2) : '—';
          const brand=b.brand? ' <span class="muted">• '+escapeHtml(b.brand)+'</span>':'';
          const sub=b.substitution? ' <span class="muted">(תחליף)</span>':'';
          const src=b.product_url? '<div class="muted"><a href="'+escapeAttr(b.product_url)+'" target="_blank" rel="noopener">מקור</a> • '+escapeHtml(b.source_domain||'')+'</div>':'';
          const notes=b.notes? '<div class="muted">'+escapeHtml(b.notes)+'</div>':'';
          return '<div class="row"><div><strong>'+escapeHtml(b.name)+'</strong>'+brand+sub+'<div class="muted">כמות: '+escapeHtml(b.quantity)+'</div>'+src+notes+'</div><div>'+line+' '+escapeHtml(r.currency||"₪")+'</div></div>';
        }).join('');
        return '<div class="row"><div><strong>#'+r.rank+' — '+escapeHtml(r.store_name||"")+'</strong><div class="muted">'+escapeHtml(r.address||"")+' • '+escapeHtml(r.distance_km||"")+' ק״מ</div></div><div>'+total+' '+escapeHtml(r.currency||"₪")+'</div></div><div style="height:8px"></div>'+rows;
      }).join('');
  }catch(e){ out.innerHTML='שגיאת רשת: '+e.message; }
}
function escapeHtml(s){return String(s??'').replace(/[&<>"'\/]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;","/":"&#x2F;"}[c]||c))}
function escapeAttr(s){return String(s??'').replace(/"/g,'&quot;')}
</script>
</html>`;

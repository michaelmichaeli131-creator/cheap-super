// server_deno.ts
// Deno Deploy + Hono (npm) + OpenAI (GPT-5) + Google Gemini (Structured Output)
// שומר את מסלול OpenAI כפי שהוא (להחזרת JSON לפי סכימה), ומוסיף ענף Gemini עם Structured Output.
// בחירה דרך provider או DEFAULT_PROVIDER. כולל Allowlist, sanity למחירים, סטטי ל/public.

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { serveStatic } from "npm:hono/serve-static";
import OpenAI from "npm:openai";
import { GoogleGenerativeAI, SchemaType } from "npm:@google/generative-ai";

// ========= ENV =========
const OPENAI_KEY   = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-5";

const GEMINI_KEY   = Deno.env.get("GEMINI_API_KEY") || "";

const ALLOW_PROVIDER_OVERRIDE = Deno.env.get("ALLOW_PROVIDER_OVERRIDE") === "true";
const DEFAULT_PROVIDER = (Deno.env.get("DEFAULT_PROVIDER") || "openai").toLowerCase() as "openai"|"gemini";

// רשימת דומיינים מותרים למקורות מחירים
const ALLOW_DOMAINS = (Deno.env.get("ALLOW_DOMAINS") || `
shufersal.co.il
ramilevy.co.il
victoryonline.co.il
yohananof.co.il
tivtaam.co.il
zap.co.il
`.trim()).split(/\s+/).map(s=>s.trim().toLowerCase()).filter(Boolean);

// ========= APP / CLIENTS =========
const app = new Hono();
app.use("/api/*", cors({
  origin: "*",
  allowMethods: ["GET","POST","OPTIONS"],
  allowHeaders: ["Content-Type","Authorization"],
}));

const openai = new OpenAI({ apiKey: OPENAI_KEY });
const gemini = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;

// ========= Helpers =========
type ChatMsg = { role: "system" | "user"; content: string };

function extractJsonBlock(s: string): string {
  const start = s.indexOf("{");
  const end   = s.lastIndexOf("}");
  return (start>=0 && end>start) ? s.slice(start, end+1) : s.trim();
}
function safeParse<T=unknown>(t: string): {ok:true; data:T}|{ok:false; error:string} {
  try { return { ok:true, data: JSON.parse(t) as T }; }
  catch(e){ return { ok:false, error: (e as Error).message || "JSON parse error" }; }
}
function anyMissingBrand(data:any): boolean {
  try {
    for (const r of data?.results ?? []) for (const b of r?.basket ?? [])
      if (typeof b.brand !== "string" || b.brand.trim()==="") return true;
  } catch {}
  return false;
}
function domainAllowed(domain:string): boolean {
  const d = (domain||"").toLowerCase();
  return ALLOW_DOMAINS.some(x => d===x || d.endsWith("."+x));
}
function sanePrice(n:number|null|undefined): boolean {
  return typeof n==="number" && isFinite(n) && n>=0.5 && n<=200;
}
function pickProvider(defaultProv: "openai"|"gemini", requested?: string): "openai"|"gemini" {
  const req = (requested||"").toLowerCase();
  const norm = req==="gemini" ? "gemini" : req==="openai" ? "openai" : "";
  if (ALLOW_PROVIDER_OVERRIDE && norm) return norm as "openai"|"gemini";
  return defaultProv;
}

// ========= OpenAI =========
async function callOpenAI(messages: ChatMsg[]): Promise<string> {
  if (!OPENAI_KEY) throw new Error("Missing OPENAI_API_KEY");
  const resp = await openai.responses.create({
    model: OPENAI_MODEL,
    input: messages,
    // לא שולחים temperature/top_p למניעת שגיאות מודל
  });
  return resp.output_text ?? "";
}

// ========= Gemini (Structured Output) =========
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
                price_source: { type: SchemaType.STRING, enum: ["retailer","aggregator","catalog"] },
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
  if (!GEMINI_KEY || !gemini) throw new Error("Missing GEMINI_API_KEY");
  const model = gemini.getGenerativeModel({
    model: "gemini-1.5-pro",
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: SearchResultsSchema as any
    }
  });
  const content = `${systemPrompt}\n\n${userPrompt}`.trim();
  const res = await model.generateContent([{ role: "user", parts: [{ text: content }] }]);
  return res.response?.text?.() ?? "";
}

// ========= API =========
app.get("/api/health", (c) =>
  c.json({
    ok: true,
    openai_model: OPENAI_MODEL,
    default_provider: DEFAULT_PROVIDER,
    allow_override: ALLOW_PROVIDER_OVERRIDE,
    has_openai_key: !!OPENAI_KEY,
    has_gemini_key: !!GEMINI_KEY,
    allow_domains: ALLOW_DOMAINS
  })
);

app.post("/api/search", async (c) => {
  try {
    const body = await c.req.json().catch(()=> ({}));
    const address   = String(body?.address ?? "").trim();
    const radius_km = Number(body?.radius_km ?? 0);
    const list_text = String(body?.list_text ?? "").trim();
    const requested = String(body?.provider ?? "").toLowerCase();

    const needed:string[] = [];
    if (!address) needed.push("address");
    if (!radius_km || isNaN(radius_km)) needed.push("radius_km");
    if (!list_text) needed.push("list_text");
    if (needed.length) return c.json({ status:"need_input", needed }, 400);

    const provider = pickProvider(DEFAULT_PROVIDER, requested);

    // ===== System prompt (קשיח למקורות, JSON בלבד) =====
    const system = `
You are a price-comparison assistant for Israel. Return ONLY strict JSON matching the schema below. No markdown, no prose.

Hard requirements:
- Every price MUST be backed by a valid URL of: retailer site, recognized price-aggregator, or product/catalog page of the retailer.
- Do NOT use news/blogs/forums/social media for pricing.
- If no acceptable source found: set "unit_price": null and explain briefly in "notes".
- Always include: "price_source" ∈ {"retailer","aggregator","catalog"}, "product_url", "source_domain", and "last_checked" (UTC ISO-8601 date of today).
- "currency" must be "₪".
- Every basket item MUST include non-empty "brand". If the item is generic, choose a common Israeli brand and explain briefly in notes.
- Output 3–4 stores sorted by total_price ascending (cheapest → expensive). Distances in km. Prefer mainstream brands.
- Return ONLY JSON that can be JSON.parsed.

JSON schema EXACTLY:
{
  "status": "ok",
  "results": [
    {
      "rank": 1,
      "store_name": "string",
      "address": "string",
      "distance_km": number,
      "currency": "₪",
      "total_price": number,
      "match_overall": number,
      "basket": [
        {
          "name": "string",
          "brand": "string",
          "quantity": number,
          "unit_price": number|null,
          "line_total": number,
          "match_confidence": number,
          "substitution": boolean,
          "notes": "string",
          "price_source": "retailer"|"aggregator"|"catalog",
          "product_url": "https://...",
          "source_domain": "example.co.il",
          "last_checked": "2025-08-23"
        }
      ],
      "sources": ["https://...", "https://..."]
    }
  ]
}
`.trim();

    const user = `
Provider: ${provider}
Address: ${address}
Radius_km: ${radius_km}
User list (free text; commas optional): ${list_text}

Additional instructions:
- Search first on official Israeli retailers' product pages or known price aggregators.
- If no reliable price found, set unit_price=null (do not guess) and explain in notes.
- Return 3–4 relevant stores, sorted by total_price.
`.trim();

    // ===== קריאה לספק הנבחר =====
    let rawText = "";
    if (provider === "gemini") {
      if (!GEMINI_KEY) {
        return c.json({ status:"error", message:"GEMINI_API_KEY missing while provider=gemini" }, 400);
      }
      rawText = await callGeminiStructured(system, user); // JSON מובנה
    } else {
      const messages: ChatMsg[] = [
        { role:"system", content: system },
        { role:"user",   content: user   },
      ];
      const raw = await callOpenAI(messages);
      rawText = extractJsonBlock(raw); // הוצאה פשוטה מהטקסט
    }

    // ===== Parse =====
    const parsed1 = safeParse<any>(rawText);
    if (!parsed1.ok) {
      return c.json({ status:"error", message:"LLM returned non-JSON text", details: parsed1.error, raw_preview: String(rawText).slice(0,1200) }, 502);
    }
    let data = parsed1.data;

    // ===== Validation & cleanup =====
    if (data?.status !== "ok" || !Array.isArray(data?.results)) {
      return c.json({ status:"no_results", provider, message:"Unexpected shape from LLM", raw: data }, 200);
    }

    for (const r of data.results) {
      for (const b of (r.basket || [])) {
        const domain = (b.source_domain || "").toLowerCase();
        if (!domainAllowed(domain)) {
          b.unit_price = null;
          b.notes = (b.notes || "") + " • מקור לא ברשימת האתרים המותרים";
        }
        if (!sanePrice(b.unit_price)) {
          b.unit_price = null;
          b.notes = (b.notes || "") + " • מחיר לא נראה תקין — סומן כ-null";
        }
        b.line_total = (typeof b.unit_price === "number")
          ? +(Number(b.unit_price) * Number(b.quantity || 1)).toFixed(2)
          : 0;
      }
      r.total_price = +((r.basket || []).reduce((s:number, b:any) =>
        s + (typeof b.unit_price==="number" ? b.unit_price*(b.quantity||1) : 0), 0).toFixed(2));
    }
    data.results.sort((a:any,b:any)=> (a.total_price||0)-(b.total_price||0));
    data.results.forEach((r:any,i:number)=> r.rank=i+1);

    // Fix-pass למותגים חסרים (זהה ל-OpenAI; אפשר להשאיר גם כש-provider=gemini, אבל נשמור על OpenAI בלבד כדי "לא לפגוע")
    if (provider === "openai" && anyMissingBrand(data)) {
      const fixSystem = `
You must FIX the following JSON so that EVERY basket item has a non-empty "brand" string.
- Keep the same structure and pricing.
- For generic items, fill a common Israeli brand and add a short note if needed.
Return ONLY JSON.
`.trim();
      const fixMessages: ChatMsg[] = [
        { role:"system", content: fixSystem },
        { role:"user",   content: JSON.stringify(data) }
      ];
      const raw2 = await callOpenAI(fixMessages);
      const t2 = extractJsonBlock(raw2);
      const parsed2 = safeParse<any>(t2);
      if (parsed2.ok) data = parsed2.data;
    }

    return c.json({ status:"ok", provider, results: data.results }, 200);

  } catch (err) {
    console.error(err);
    return c.json({ status:"error", message:String(err) }, 500);
  }
});

// ========= Static frontend =========
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

// ========= Fallback inline HTML (לדיבאג זריז) =========
const FALLBACK_HTML = `<!doctype html>
<html lang="he" dir="rtl">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CartCompare AI (Fallback)</title>
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
        <option value="gemini">Gemini (Structured)</option>
      </select>
    </div>
    <div class="input"><label>כתובת</label><input id="addr" placeholder="תל אביב, בן יהודה 10"></div>
    <div class="input"><label>רדיוס (ק״מ)</label><input id="rad" type="number" value="5"></div>
    <div class="input"><label>רשימת קניות</label><textarea id="lst" rows="4" placeholder="שישיית מים, חלב 3%, ספגטי"></textarea></div>
    <button class="btn" onclick="go()">חפש</button>
  </div>
  <div id="out" style="margin-top:12px"></div>
</div>
<script>
async function go(){
  const out=document.getElementById('out');
  const provider=document.getElementById('provider').value;
  out.innerHTML='טוען...';
  try{
    const res=await fetch('/api/search',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({address:addr.value.trim(),radius_km:Number(rad.value||5),list_text:lst.value.trim(),provider})});
    const data=await res.json();
    if(!res.ok){ out.innerHTML='שגיאת שרת: '+(data.message||res.status); return; }
    if(data.status!=='ok'){ out.innerHTML='אין תוצאות: '+(data.message||''); return; }
    out.innerHTML='<div class="muted">Provider: '+(data.provider||provider)+'</div>' +
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

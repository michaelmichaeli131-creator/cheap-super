// server_deno.ts
// Deno Deploy + Hono (npm) + Google Gemini (Structured Output only, NO source restrictions)

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { serveStatic } from "npm:hono/serve-static";
import { GoogleGenerativeAI, SchemaType } from "npm:@google/generative-ai";

// ===== ENV =====
const GEMINI_KEY   = Deno.env.get("GEMINI_API_KEY") || "";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-1.5-pro-002";

// ===== APP / CLIENT =====
const app = new Hono();
app.use("/api/*", cors({
  origin: "*",
  allowMethods: ["GET","POST","OPTIONS"],
  allowHeaders: ["Content-Type","Authorization"],
}));

if (!GEMINI_KEY) {
  console.warn("[WARN] Missing GEMINI_API_KEY — server will return 500 on /api/search");
}
const genAI = new GoogleGenerativeAI(GEMINI_KEY);

// ===== Utils =====
function extractJsonBlock(s: string): string {
  const start = s.indexOf("{"); const end = s.lastIndexOf("}");
  return (start>=0 && end>start) ? s.slice(start,end+1) : s.trim();
}
function safeParse<T=unknown>(t: string): {ok:true; data:T}|{ok:false; error:string} {
  try { return { ok:true, data: JSON.parse(t) as T }; } catch(e){ return { ok:false, error: (e as Error).message || "JSON parse error" }; }
}
// מחירי sanity בלבד כדי שלא נציג 0 כמחיר אמיתי
function sanePrice(n:number|null|undefined){ return typeof n==="number" && isFinite(n) && n>0 && n<500; }

// ===== Schema (Structured Output) =====
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
                price_source: { type: SchemaType.STRING },     // לא מגבילים מקור
                product_url: { type: SchemaType.STRING },      // יכול להיות מכל אתר
                source_domain: { type: SchemaType.STRING },    // לא בודקים מול allowlist
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

// ===== Gemini call (Structured JSON only) =====
async function callGeminiStructured(systemPrompt: string, userPrompt: string): Promise<string> {
  if (!GEMINI_KEY) throw new Error("Missing GEMINI_API_KEY");
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: SearchResultsSchema as any,
    },
  });
  const content = `${systemPrompt}\n\n${userPrompt}`.trim();
  const res = await model.generateContent(content); // אין role/parts — מחרוזת אחת
  return res.response?.text?.() ?? "";
}

// ===== API =====
app.get("/api/health", (c) =>
  c.json({
    ok: true,
    gemini_model: GEMINI_MODEL,
    has_gemini_key: !!GEMINI_KEY
  })
);

app.post("/api/search", async (c) => {
  try {
    const body = await c.req.json().catch(()=> ({}));
    const address   = String(body?.address ?? "").trim();
    const radius_km = Number(body?.radius_km ?? 0);
    const list_text = String(body?.list_text ?? "").trim();

    const needed:string[]=[]; if(!address)needed.push("address"); if(!radius_km||isNaN(radius_km))needed.push("radius_km"); if(!list_text)needed.push("list_text");
    if(needed.length) return c.json({ status:"need_input", needed }, 400);
    if(!GEMINI_KEY)   return c.json({ status:"error", message:"GEMINI_API_KEY is missing" }, 500);

    // === PROMPT ללא מגבלות מקור ===
    const system = `
You are an Israeli grocery price comparison agent.
Goal: find the CHEAPEST basket for the user's items within the given radius from the given address.

Guidelines (no hard source restrictions):
- Use any sources you deem reliable (e.g., supermarket sites, online stores, comparison services, and other up-to-date pages).
- Each basket item MUST include a non-empty brand (e.g., מי עדן, קלסברג, תנובה). If user request is generic, choose a common brand and add a short note.
- If you cannot find a current unit price, set unit_price = null and add a short note (do not guess).
- Return 3–4 stores sorted by total_price (cheapest first).
- Currency must be "₪".
- Return ONLY strict JSON that exactly matches the schema.
`.trim();

    const user = `
Address: ${address}
Radius_km: ${radius_km}
User list (free text; commas optional): ${list_text}

Notes:
- Prefer recent prices when possible.
- If some items are unavailable, offer sensible substitutions and mark "substitution": true with a short note.
- Keep the output terse; do not include any prose outside the JSON fields.
`.trim();

    // ---- Gemini only ----
    const rawText = await callGeminiStructured(system, user);

    const parsed = safeParse<any>(extractJsonBlock(rawText));
    if (!parsed.ok) {
      return c.json({ status:"error", message:"LLM returned non-JSON text", details: parsed.error, raw_preview: String(rawText).slice(0,1200) }, 502);
    }
    let data = parsed.data;

    if (data?.status !== "ok" || !Array.isArray(data?.results)) {
      return c.json({ status:"no_results", provider:"gemini", message:"Unexpected shape from LLM", raw: data }, 200);
    }

    // === Normalize (sanity בלבד) ===
    for (const r of data.results) {
      for (const b of (r.basket || [])) {
        // רק sanity למחיר — לא מסננים לפי מקור/דומיין
        if (!sanePrice(b.unit_price)) {
          b.unit_price = null;
          b.line_total = 0;
          b.notes = (b.notes || "") + " • מחיר לא נמצא/לא הגיוני — סומן כ-null";
        } else {
          b.line_total = +(Number(b.unit_price) * Number(b.quantity || 1)).toFixed(2);
        }
        // הבטחת מותג לא ריק (כפי שביקשתם)
        if (typeof b.brand !== "string" || !b.brand.trim()) {
          b.brand = "מותג נפוץ";
          b.notes = (b.notes || "") + " • הוסף מותג כללי כי לא צוין";
        }
      }
      r.total_price = +((r.basket || []).reduce((s:number,b:any)=> s + (typeof b.unit_price==="number" ? b.unit_price*(b.quantity||1) : 0), 0).toFixed(2));
    }
    data.results.sort((a:any,b:any)=> (a.total_price||0)-(b.total_price||0));
    data.results.forEach((r:any,i:number)=> r.rank=i+1);

    return c.json({ status:"ok", provider:"gemini", results: data.results }, 200);

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
  <h2>CartCompare AI — Fallback (Gemini only)</h2>
  <div class="box">
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
  out.innerHTML='טוען...';
  try{
    const res=await fetch('/api/search',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({address:addr.value.trim(),radius_km:Number(rad.value||5),list_text:lst.value.trim()})});
    const data=await res.json();
    if(!res.ok){ out.innerHTML='שגיאת שרת: '+(data.message||res.status); return; }
    if(data.status!=='ok'){ out.innerHTML='אין תוצאות: '+(data.message||''); return; }
    out.innerHTML =
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

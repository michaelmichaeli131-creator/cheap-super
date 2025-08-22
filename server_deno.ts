// server_deno.ts
// Deno Deploy + Hono (npm) + OpenAI (GPT-5) + Static public/ + Fallback inline

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { serveStatic } from "npm:hono/serve-static";
import OpenAI from "npm:openai";

// ========= ENV =========
const API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-5";

// ========= APP =========
const app = new Hono();

// CORS ל-API בלבד
app.use(
  "/api/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

// ========= OpenAI =========
const client = new OpenAI({ apiKey: API_KEY });

// ========= Helpers =========
function extractJsonBlock(s: string): string {
  const start = s.indexOf("{"); const end = s.lastIndexOf("}");
  return (start >= 0 && end > start) ? s.slice(start, end + 1) : s.trim();
}
function safeParse<T = unknown>(t: string): { ok: true; data: T } | { ok: false; error: string } {
  try { return { ok: true, data: JSON.parse(t) as T }; }
  catch (e) { return { ok: false, error: (e as Error).message || "JSON parse error" }; }
}

// ========= API =========
app.get("/api/health", (c) => c.json({ ok: true, model: MODEL, hasKey: !!API_KEY }));

app.post("/api/search", async (c) => {
  try {
    if (!API_KEY) {
      return c.json({ status: "error", message: "Missing OPENAI_API_KEY" }, 500);
    }

    const body = await c.req.json().catch(() => ({}));
    const address   = String(body?.address ?? "").trim();
    const radius_km = Number(body?.radius_km ?? 0);
    const list_text = String(body?.list_text ?? "").trim();

    const needed: string[] = [];
    if (!address) needed.push("address");
    if (!radius_km || isNaN(radius_km)) needed.push("radius_km");
    if (!list_text) needed.push("list_text");
    if (needed.length) return c.json({ status: "need_input", needed }, 400);

    const system = `
You are a shopping-comparison assistant. Return ONLY strict JSON that can be JSON.parsed.
Identify ~3 nearby stores (placeholders allowed), fuzzy-match the user's free-text list (commas may be missing),
include brand when obvious, allow substitutions, sort stores cheapest→expensive. Use ILS (₪).

JSON shape EXACTLY:
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
          "brand": "string (optional)",
          "quantity": number,
          "unit_price": number,
          "line_total": number,
          "match_confidence": number,
          "substitution": boolean (optional),
          "notes": "string (optional)"
        }
      ]
    }
  ]
}
Return ONLY JSON. No Markdown, no prose.
`.trim();

    const user = `
Address: ${address}
Radius_km: ${radius_km}
User list (free text, commas optional): ${list_text}
`.trim();

    // ❗️ללא temperature/top_p — לא נתמך ב-GPT-5
    const ai = await client.responses.create({
      model: MODEL,
      input: [
        { role: "system", content: system },
        { role: "user",   content: user   },
      ],
    });

    const raw = ai.output_text ?? "";
    const jsonText = extractJsonBlock(raw);
    const parsed = safeParse<any>(jsonText);
    if (!parsed.ok) {
      return c.json({ status: "error", message: "LLM returned invalid JSON", details: parsed.error, raw }, 502);
    }

    const data = parsed.data;
    if (data?.status !== "ok" || !Array.isArray(data?.results)) {
      return c.json({ status: "no_results", message: "Unexpected shape from LLM", raw: data }, 200);
    }

    return c.json({ status: "ok", results: data.results }, 200);
  } catch (err) {
    console.error(err);
    return c.json({ status: "error", message: String(err) }, 500);
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

// ========= Fallback inline HTML =========
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
  input,textarea{padding:12px;border:1px solid #e6edf7;border-radius:12px}
  .btn{border:0;border-radius:12px;padding:12px 14px;background:#111;color:#fff;font-weight:800;cursor:pointer;margin-top:10px}
  .row{display:flex;justify-content:space-between;align-items:center;padding:12px;border:1px solid #eaf1fb;border-radius:12px}
  .row+.row{margin-top:8px}
  .muted{color:#6b7280;font-size:12px}
</style>
<div class="wrap">
  <h2>CartCompare AI — Fallback</h2>
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
    out.innerHTML=data.results.map(r=>{
      const total=Number(r.total_price||0).toFixed(2);
      const rows=(r.basket||[]).map(b=>{
        const unit=Number(b.unit_price||0).toFixed(2);
        const line=Number(b.line_total||0).toFixed(2);
        const brand=b.brand? ' <span class="muted">• '+escapeHtml(b.brand)+'</span>':'';
        return '<div class="row"><div><strong>'+escapeHtml(b.name)+'</strong>'+brand+'<div class="muted">כמות: '+escapeHtml(b.quantity)+' • מחיר יחידה: '+unit+'</div></div><div>'+line+'</div></div>';
      }).join('');
      return '<div class="row"><div><strong>#'+r.rank+' — '+escapeHtml(r.store_name)+'</strong><div class="muted">'+escapeHtml(r.address)+' • '+escapeHtml(r.distance_km)+' ק״מ</div></div><div>'+total+' '+escapeHtml(r.currency||"₪")+'</div></div><div style="height:8px"></div>'+rows;
    }).join('');
  }catch(e){ out.innerHTML='שגיאת רשת: '+e.message; }
}
function escapeHtml(s){
  // הוסר ה-backtick מהרגקס כדי לא לשבור את ה-Template Literal החיצוני
  return String(s??'').replace(/[&<>"'\/]/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;","/":"&#x2F;"}[c];
  });
}
</script>
</html>`;

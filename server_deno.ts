// server_deno.ts
// Deno Deploy + Hono (npm) + OpenAI (GPT-5) + Static public + Brand-Enforced + Auto Fix Pass

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
function anyMissingBrand(data: any): boolean {
  try {
    for (const r of data?.results ?? []) {
      for (const b of r?.basket ?? []) {
        if (typeof b.brand !== "string" || b.brand.trim() === "") return true;
      }
    }
  } catch { /* ignore */ }
  return false;
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

    // ===== System prompt: מותגים חובה + תחליפים והערות =====
    const system = `
You are a shopping-comparison assistant for Israel. Return ONLY strict JSON that can be JSON.parsed.

Goals:
- Parse user's free-text grocery list (Hebrew, commas may be missing).
- For EVERY item you return, you MUST include a real, common Israeli brand name (non-empty string).
- If the user's text is generic (e.g., "מים", "חלב", "לחם"), choose a well-known brand in Israel.
- If no exact brand match is clear, pick a likely/common brand and add a short explanation in 'notes'.
- If a true equivalent is unavailable, provide a close substitute, set substitution: true, and explain in notes.
- Output 3–4 nearby stores (placeholders allowed), sorted by total_price ascending (cheapest → expensive).
- Use ILS ("₪") and distances in kilometers. Be realistic with prices, prefer mainstream brands.

Branding guidance (examples, not exhaustive):
- "מים מינרליים" → "מי עדן" | "נביעות"
- "חלב 3%" → "תנובה" | "טרה" | "שטראוס"
- "לחם פרוס" → "אנג'ל" | "דגנית עין בר"
- "קולה" → "Coca-Cola" | "Pepsi"
- "טונה" → "סטארקיסט" | "ויליפוד"
- "גבינה לבנה/קוטג'" → "תנובה" | "שטראוס"
- "חיתולים" → "Huggies" | "Pampers"

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
          "name": "string",            // המוצר כפי שהובן מהמשתמש (בעברית)
          "brand": "string",           // חובה: מותג אמיתי ונפוץ בישראל
          "quantity": number,
          "unit_price": number,
          "line_total": number,
          "match_confidence": number,  // 0..1
          "substitution": boolean,     // true אם זה תחליף (רשות אם false)
          "notes": "string"            // הסבר קצר (למשל: "בחרתי 'נביעות' כמותג נפוץ למים מינרליים")
        }
      ]
    }
  ]
}

Constraints:
- Always include "brand" as a non-empty string for every basket item.
- When in doubt, choose a mainstream brand and explain briefly in notes.
- Return ONLY JSON. No Markdown, no prose.
`.trim();

    const user = `
Address: ${address}
Radius_km: ${radius_km}
User list (free text, commas optional): ${list_text}
`.trim();

    // ===== קריאת OpenAI (ללא temperature/top_p) =====
    const primary = await client.responses.create({
      model: MODEL,
      input: [
        { role: "system", content: system },
        { role: "user",   content: user   },
      ],
    });

    const raw1 = primary.output_text ?? "";
    const text1 = extractJsonBlock(raw1);
    const parsed1 = safeParse<any>(text1);

    if (!parsed1.ok) {
      return c.json({ status: "error", message: "LLM returned invalid JSON", details: parsed1.error, raw: raw1 }, 502);
    }

    let data = parsed1.data;

    // ===== Fix Pass: אם יש פריט בלי brand — מבקשים תיקון אוטומטי =====
    if (anyMissingBrand(data)) {
      const fixSystem = `
You must FIX the following JSON so that EVERY basket item has a non-empty "brand" string.
- Keep the same structure and pricing.
- For generic items, fill a common Israeli brand.
- If truly a substitute, set substitution: true and add a short note.
Return ONLY JSON.
`.trim();

      const fix = await client.responses.create({
        model: MODEL,
        input: [
          { role: "system", content: fixSystem },
          { role: "user",   content: JSON.stringify(data) },
        ],
      });

      const raw2 = fix.output_text ?? "";
      const text2 = extractJsonBlock(raw2);
      const parsed2 = safeParse<any>(text2);
      if (parsed2.ok) data = parsed2.data;
    }

    // ולידציה סופית
    if (data?.status !== "ok" || !Array.isArray(data?.results)) {
      return c.json({ status: "no_results", message: "Unexpected shape from LLM", raw: data }, 200);
    }
    if (anyMissingBrand(data)) {
      // עדיין חסר מותג? נחזיר אזהרה אבל נספק את התוצאה
      return c.json({ status: "ok", results: data.results, warning: "Some items missing 'brand' after fix." }, 200);
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
        const sub=b.substitution? ' <span class="muted">(תחליף)</span>':'';
        const notes=b.notes? '<div class="muted">'+escapeHtml(b.notes)+'</div>':'';
        return '<div class="row"><div><strong>'+escapeHtml(b.name)+'</strong>'+brand+sub+'<div class="muted">כמות: '+escapeHtml(b.quantity)+' • מחיר יחידה: '+unit+'</div>'+notes+'</div><div>'+line+'</div></div>';
      }).join('');
      return '<div class="row"><div><strong>#'+r.rank+' — '+escapeHtml(r.store_name)+'</strong><div class="muted">'+escapeHtml(r.address)+' • '+escapeHtml(r.distance_km)+' ק״מ</div></div><div>'+total+' '+escapeHtml(r.currency||"₪")+'</div></div><div style="height:8px"></div>'+rows;
    }).join('');
  }catch(e){ out.innerHTML='שגיאת רשת: '+e.message; }
}
function escapeHtml(s){
  // ללא backtick ברגקס כדי לא לשבור את ה-Template Literal
  return String(s??'').replace(/[&<>"'\/]/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;","/":"&#x2F;"}[c];
  });
}
</script>
</html>`;

// server_deno.ts
// Deno Deploy + Hono (npm) + OpenAI GPT-5 + Perplexity (web browsing) + Static /public + JSON repair (Perplexity only)

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { serveStatic } from "npm:hono/serve-static";
import OpenAI from "npm:openai";

// ========= ENV =========
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-5";

const PPLX_KEY = Deno.env.get("PERPLEXITY_API_KEY") || "";
const USE_WEB = (Deno.env.get("USE_WEB") || "none").toLowerCase(); // "none" | "perplexity"

const ALLOW_PROVIDER_OVERRIDE = Deno.env.get("ALLOW_PROVIDER_OVERRIDE") === "true";
type Provider = "openai" | "perplexity";

// ========= APP =========
const app = new Hono();

// CORS רק לנתיבי ה-API
app.use(
  "/api/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

// ========= OpenAI client =========
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// ========= Helpers =========
type ChatMsg = { role: "system" | "user"; content: string };

function extractJsonBlock(s: string): string {
  // כלי פשוט – נשאר למסלול OpenAI בלבד
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  return (start >= 0 && end > start) ? s.slice(start, end + 1) : s.trim();
}

function safeParse<T = unknown>(t: string): { ok: true; data: T } | { ok: false; error: string } {
  try {
    return { ok: true, data: JSON.parse(t) as T };
  } catch (e) {
    return { ok: false, error: (e as Error).message || "JSON parse error" };
  }
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

function pickProvider(globalDefault: "none" | "perplexity", requestPref?: Provider): Provider {
  if (ALLOW_PROVIDER_OVERRIDE && (requestPref === "openai" || requestPref === "perplexity")) {
    return requestPref;
  }
  return globalDefault === "perplexity" ? "perplexity" : "openai";
}

// ===== JSON coercion/repair (Perplexity only) =====
function normalizeQuotes(s: string): string {
  // מירכאות חכמות → רגילות; רווח לא שבור
  return s
    .replace(/[\u201C\u201D\u05F4]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u00A0/g, " ");
}
function stripDanglingCommas(s: string): string {
  // מסיר פסיקים תלויים לפני } או ]
  return s
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/:\s*,/g, ": ");
}
function extractJsonCandidate(s: string): string {
  if (!s) return s;

  // ```json ... ```
  const fenceJson = s.match(/```json\s*([\s\S]*?)```/i);
  if (fenceJson?.[1]) return fenceJson[1].trim();

  // ``` ... ```
  const fence = s.match(/```\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].trim();

  // הבלוק הגדול ביותר של {...}
  let best = "";
  let depth = 0, start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) depth--;
      if (depth === 0 && start >= 0) {
        const cand = s.slice(start, i + 1).trim();
        if (cand.length > best.length) best = cand;
        start = -1;
      }
    }
  }
  return (best || s).trim();
}
function coerceToJsonStrict(raw: string): { ok: true; text: string } | { ok: false; error: string } {
  if (!raw || typeof raw !== "string") return { ok: false, error: "empty" };
  let cand = extractJsonCandidate(raw);
  cand = normalizeQuotes(cand);

  try { JSON.parse(cand); return { ok: true, text: cand }; } catch {}
  cand = stripDanglingCommas(cand);
  try { JSON.parse(cand); return { ok: true, text: cand }; } catch (e) {
    return { ok: false, error: (e as Error).message || "parse failed" };
  }
}

// ========= Providers =========
async function callPerplexity(messages: ChatMsg[]): Promise<string> {
  if (!PPLX_KEY) throw new Error("Missing PERPLEXITY_API_KEY");
  const r = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${PPLX_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar-pro", // גלישה מובנית
      messages,
      max_tokens: 1400,
      // אל תשלח temperature/top_p
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Perplexity ${r.status}: ${txt}`);
  }
  const j = await r.json();
  return j?.choices?.[0]?.message?.content ?? "";
}

async function callOpenAI(messages: ChatMsg[]): Promise<string> {
  if (!OPENAI_KEY) throw new Error("Missing OPENAI_API_KEY");
  const resp = await openai.responses.create({
    model: MODEL,
    input: messages,
    // אל תשלח temperature/top_p (חלק מהמודלים לא תומכים)
  });
  return resp.output_text ?? "";
}

// ניסיון תיקון נוסף דרך Perplexity להחזיר JSON תקני בלבד
async function repairJsonWithPerplexity(badText: string, schemaHint?: string): Promise<string> {
  if (!PPLX_KEY) return badText; // אין טעם לנסות
  const repairSystem = `
You must output STRICT JSON ONLY. No markdown fences, no commentary.
If the input contains JSON with mistakes (quotes/commas), fix it to be valid JSON.
${schemaHint ? `The JSON must match this structure:\n${schemaHint}` : ""}
`.trim();

  const msgs: ChatMsg[] = [
    { role: "system", content: repairSystem },
    { role: "user", content: badText },
  ];

  const r = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${PPLX_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "sonar-pro", messages: msgs, max_tokens: 800 }),
  });
  if (!r.ok) throw new Error(`Perplexity repair ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j?.choices?.[0]?.message?.content ?? "";
}

// ========= API =========
app.get("/api/health", (c) =>
  c.json({
    ok: true,
    model: MODEL,
    use_web: USE_WEB,
    allow_override: ALLOW_PROVIDER_OVERRIDE,
    has_openai_key: !!OPENAI_KEY,
    has_perplexity_key: !!PPLX_KEY,
  })
);

app.post("/api/search", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const address   = String(body?.address ?? "").trim();
    const radius_km = Number(body?.radius_km ?? 0);
    const list_text = String(body?.list_text ?? "").trim();
    const requestedProvider = String(body?.provider ?? "").toLowerCase() as Provider | "";

    const needed: string[] = [];
    if (!address) needed.push("address");
    if (!radius_km || isNaN(radius_km)) needed.push("radius_km");
    if (!list_text) needed.push("list_text");
    if (needed.length) return c.json({ status: "need_input", needed }, 400);

    // בחירת ספק
    const provider = pickProvider(USE_WEB as "none" | "perplexity", requestedProvider || undefined);

    // אם ביקשו אינטרנט ואין KEY — נודיע ולא ניפול בשקט
    if (provider === "perplexity" && !PPLX_KEY) {
      return c.json({
        status: "error",
        message: "PERPLEXITY_API_KEY missing while provider=perplexity",
        hint: "Set PERPLEXITY_API_KEY in Deno Deploy and redeploy."
      }, 400);
    }

    // ===== System prompt =====
    const system = `
You are a shopping-comparison assistant for Israel. Return ONLY strict JSON that can be JSON.parsed.

Goals:
- Parse user's free-text grocery list (Hebrew; commas may be missing).
- For EVERY item you return, you MUST include a real, common Israeli brand (non-empty string).
- If the user's text is generic (e.g., "מים", "חלב", "לחם"), choose a well-known brand in Israel.
- If no exact brand match is clear, pick a likely/common brand and add a short explanation in 'notes'.
- If a true equivalent is unavailable, provide a close substitute, set substitution: true, and explain in notes.
- Output 3–4 nearby stores (placeholders allowed), sorted by total_price ascending (cheapest → expensive).
- Use ILS ("₪") and distances in kilometers. Be realistic with prices, prefer mainstream brands.
- If your provider supports web browsing (Perplexity), leverage live search to ground brands/prices.

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
          "brand": "string",
          "quantity": number,
          "unit_price": number,
          "line_total": number,
          "match_confidence": number,
          "substitution": boolean,
          "notes": "string"
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
Provider: ${provider}
Address: ${address}
Radius_km: ${radius_km}
User list (free text, commas optional): ${list_text}
`.trim();

    const messages: ChatMsg[] = [
      { role: "system", content: system },
      { role: "user",   content: user   },
    ];

    // ===== קריאה ל-LLM =====
    let rawText = "";
    let text1 = "";

    if (provider === "perplexity") {
      rawText = await callPerplexity(messages);

      // נסיון להוציא JSON תקני
      let coerced = coerceToJsonStrict(rawText);
      if (!coerced.ok) {
        // Repair אחד מכריח JSON בלבד
        const schemaHint = `
{
  "status":"ok",
  "results":[
    {
      "rank":1,
      "store_name":"string",
      "address":"string",
      "distance_km":number,
      "currency":"₪",
      "total_price":number,
      "match_overall":number,
      "basket":[
        {
          "name":"string",
          "brand":"string",
          "quantity":number,
          "unit_price":number,
          "line_total":number,
          "match_confidence":number,
          "substitution":boolean,
          "notes":"string"
        }
      ]
    }
  ]
}`.trim();

        const repaired = await repairJsonWithPerplexity(rawText, schemaHint);
        coerced = coerceToJsonStrict(repaired);
        if (!coerced.ok) {
          return c.json({
            status: "error",
            message: "LLM returned invalid JSON (perplexity)",
            details: coerced.error,
            raw_preview: String(rawText).slice(0, 1200)
          }, 502);
        }
      }
      text1 = coerced.text;

    } else {
      // OpenAI – ללא שינוי
      rawText = await callOpenAI(messages);
      text1 = extractJsonBlock(rawText);
    }

    // ===== Parse =====
    const parsed1 = safeParse<any>(text1);
    if (!parsed1.ok) {
      return c.json({ status: "error", message: "LLM returned invalid JSON", details: parsed1.error, raw: text1.slice(0,1200) }, 502);
    }
    let data = parsed1.data;

    // ===== Fix-Pass: ודא שלכל פריט יש brand =====
    if (anyMissingBrand(data)) {
      const fixSystem = `
You must FIX the following JSON so that EVERY basket item has a non-empty "brand" string.
- Keep the same structure and pricing.
- For generic items, fill a common Israeli brand.
- If truly a substitute, set substitution: true and add a short note.
Return ONLY JSON.
`.trim();

      const fixMessages: ChatMsg[] = [
        { role: "system", content: fixSystem },
        { role: "user",   content: JSON.stringify(data) },
      ];

      let raw2 = "";
      if (provider === "perplexity") raw2 = await callPerplexity(fixMessages);
      else raw2 = await callOpenAI(fixMessages);

      // החלת coercion במסלול Perplexity בפאס התיקון גם כן
      let text2 = raw2;
      if (provider === "perplexity") {
        const c2 = coerceToJsonStrict(raw2);
        text2 = c2.ok ? c2.text : extractJsonBlock(raw2);
      } else {
        text2 = extractJsonBlock(raw2);
      }

      const parsed2 = safeParse<any>(text2);
      if (parsed2.ok) data = parsed2.data;
    }

    // ===== ולידציה בסיסית =====
    if (data?.status !== "ok" || !Array.isArray(data?.results)) {
      return c.json({ status: "no_results", provider, message: "Unexpected shape from LLM", raw: data }, 200);
    }
    if (anyMissingBrand(data)) {
      return c.json({ status: "ok", provider, results: data.results, warning: "Some items missing 'brand' after fix." }, 200);
    }

    // ===== OK =====
    return c.json({
      status: "ok",
      provider,
      results: data.results,
      // דיבאג אופציונלי – נחמד לזמן פיתוח:
      // debug_routing: {
      //   requested: requestedProvider || null,
      //   selected: provider,
      //   allow_override: ALLOW_PROVIDER_OVERRIDE,
      //   use_web_default: USE_WEB,
      //   has_pplx_key: !!PPLX_KEY,
      //   has_openai_key: !!OPENAI_KEY
      // }
    }, 200);

  } catch (err) {
    console.error(err);
    return c.json({ status: "error", message: String(err) }, 500);
  }
});

// ========= Static frontend =========
app.use("/assets/*", serveStatic({ root: "./public" }));
app.use("/img/*",    serveStatic({ root: "./public" }));
app.use("/public/*", serveStatic({ root: "./public" }));

// ROOT: הגשה של index.html אם קיים; אחרת fallback מובנה
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
  input,textarea,select{padding:12px;border:1px solid #e6edf7;border-radius:12px}
  .btn{border:0;border-radius:12px;padding:12px 14px;background:#111;color:#fff;font-weight:800;cursor:pointer;margin-top:10px}
  .row{display:flex;justify-content:space-between;align-items:center;padding:12px;border:1px solid #eaf1fb;border-radius:12px}
  .row+.row{margin-top:8px}
  .muted{color:#6b7280;font-size:12px}
</style>
<div class="wrap">
  <h2>CartCompare AI — Fallback</h2>
  <div class="box">
    <div class="input"><label>מודל (ספק)</label>
      <select id="provider">
        <option value="openai">OpenAI (GPT-5)</option>
        <option value="perplexity">Perplexity (Web)</option>
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
  return String(s??'').replace(/[&<>"'\/]/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;","/":"&#x2F;"}[c] || c;
  });
}
</script>
</html>`;

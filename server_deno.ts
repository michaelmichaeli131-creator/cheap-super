// server_deno.ts
// Deno Deploy + Hono (npm) + OpenAI (GPT-5) + Static public/

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { serveStatic } from "npm:hono/serve-static";
import OpenAI from "npm:openai";

// === Env ===
const API_KEY = Deno.env.get("OPENAI_API_KEY");
if (!API_KEY) console.error("Missing OPENAI_API_KEY");
const MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-5";

// === App ===
const app = new Hono();

// CORS ל-API בלבד (לא חובה לסטטי)
app.use("/api/*", cors({ origin: "*", allowMethods: ["GET","POST","OPTIONS"], allowHeaders: ["Content-Type","Authorization"] }));

// OpenAI client
const client = new OpenAI({ apiKey: API_KEY });

// עוזרים קטנים
function extractJsonBlock(s: string): string {
  const start = s.indexOf("{"); const end = s.lastIndexOf("}");
  return (start >= 0 && end > start) ? s.slice(start, end + 1) : s.trim();
}
function safeParse<T = unknown>(t: string): { ok: true; data: T } | { ok: false; error: string } {
  try { return { ok: true, data: JSON.parse(t) as T }; }
  catch (e) { return { ok: false, error: (e as Error).message || "JSON parse error" }; }
}

// ===== API =====
app.post("/api/search", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const address = String(body?.address ?? "").trim();
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
          "substitution": boolean (optional)",
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

    const ai = await client.responses.create({
      model: MODEL, // בלי temperature/top_p
      input: [
        { role: "system", content: system },
        { role: "user",   content: user   },
      ],
    });

    const raw = ai.output_text ?? "";
    const jsonText = extractJsonBlock(raw);
    const parsed = safeParse<any>(jsonText);
    if (!parsed.ok) return c.json({ status: "error", message: "LLM returned invalid JSON", details: parsed.error, raw }, 502);

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

// ===== Static frontend from /public =====
// משרת קבצים סטטיים (CSS/JS/תמונות וכד')
app.use("/assets/*", serveStatic({ root: "./public" }));
app.use("/img/*",    serveStatic({ root: "./public" }));
app.use("/public/*", serveStatic({ root: "./public" }));

// דף הבית – מגיש index.html
app.get("/", serveStatic({ path: "./public/index.html" }));

// SPA fallback – כל נתיב שלא נמצא יגיש index.html
app.notFound(serveStatic({ path: "./public/index.html" }));

export default app;

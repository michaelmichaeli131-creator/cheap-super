// server_deno.ts
// Deno Deploy / Hono + OpenAI Responses API (GPT-5)

import { Hono } from "https://deno.land/x/hono@v4.4.7/mod.ts";
import { cors } from "https://deno.land/x/hono@v4.4.7/middleware/cors/index.ts";
import OpenAI from "npm:openai";

// === Env ===
const API_KEY = Deno.env.get("OPENAI_API_KEY");
if (!API_KEY) {
  console.error("Missing OPENAI_API_KEY in environment variables");
}
const MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-5"; // נועל ל-GPT-5 כברירת מחדל

// === App ===
const app = new Hono();

// CORS (אפשר לכוונן לפי הצורך)
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

// === OpenAI Client ===
const client = new OpenAI({ apiKey: API_KEY });

// עוזר קטן: נסה לפרסר JSON בצורה בטוחה
function safeJsonParse<T = unknown>(text: string): { ok: true; data: T } | { ok: false; error: string } {
  try {
    const data = JSON.parse(text);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: (e as Error).message || "JSON parse error" };
  }
}

// עוזר: חילוץ JSON מתוך טקסט (אם המודל עטף בטקסט)
function extractJsonBlock(s: string): string {
  // נסה למצוא את הבלוק הראשון שמתחיל ב { ונגמר ב }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return s.slice(start, end + 1);
  }
  return s.trim();
}

// === Route: POST /api/search ===
// קלט: { address: string, radius_km: number, list_text: string }
app.post("/api/search", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const address = String(body?.address || "").trim();
    const radius_km = Number(body?.radius_km || 0);
    const list_text = String(body?.list_text || "").trim();

    const needed: string[] = [];
    if (!address) needed.push("address");
    if (!radius_km || isNaN(radius_km)) needed.push("radius_km");
    if (!list_text) needed.push("list_text");

    if (needed.length > 0) {
      return c.json({ status: "need_input", needed }, 400);
    }

    // Prompt: מבקש JSON בלבד. אין שימוש ב-temperature/top_p (הם לא נתמכים ב-GPT-5 בהקשר הזה).
    // שים לב: לא משתמשים כאן ב-text.format כדי להימנע משגיאות סכימה — נשמור את זה פשוט ויציב.
    const system = `
You are a shopping-comparison assistant. You receive a free-text grocery list in Hebrew (may have no commas),
a user address/city, and a search radius (km). Return ONLY strict JSON that a browser can JSON.parse.

Rules:
- Identify 3-4 nearby stores (realistic placeholders allowed if data isn't available).
- For each store, estimate a detailed basket: items matched to the user's list (allow fuzzy matching; commas optional),
  include brand if obvious, quantity, unit_price, line_total, optional notes and substitution flag.
- Sort stores by total_price ascending (cheapest first). Rank starting at 1.
- Provide match_overall (0..1) as an estimated overall match quality.
- Use ILS by default ("₪") and distances in kilometers.
- Output strictly the following JSON shape:

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
          "brand": "string | optional",
          "quantity": number,
          "unit_price": number,
          "line_total": number,
          "match_confidence": number,   // 0..1
          "substitution": boolean,      // optional
          "notes": "string | optional"
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

    // === OpenAI call ===
    // ❗️שימו לב: בלי temperature / top_p כדי להימנע מהשגיאה 400 Unsupported parameter.
    const resp = await client.responses.create({
      model: MODEL,
      // אפשר גם להעביר כ־{ role, content } אבל כאן מספיק input פשוט
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    const rawText = resp.output_text ?? ""; // SDK מחזיר text מאוחד בנוחות
    const jsonCandidate = extractJsonBlock(rawText);
    const parsed = safeJsonParse<any>(jsonCandidate);

    if (!parsed.ok) {
      // אם לא הצלחנו לפרסר, נחזיר הודעת שגיאה ידידותית + את הטקסט הגולמי כדי שתוכל לדבג
      return c.json(
        {
          status: "error",
          message: "LLM returned non-JSON or invalid JSON",
          details: parsed.error,
          raw: rawText,
        },
        502,
      );
    }

    // וליתר ביטחון: נוודא שהמבנה מתאים למה שהלקוח מצפה לו
    const data = parsed.data;
    if (data?.status !== "ok" || !Array.isArray(data?.results)) {
      return c.json(
        {
          status: "no_results",
          message: "Unexpected shape from LLM",
          raw: data,
        },
        200,
      );
    }

    // או.קיי — זה הפורמט שהלקוח מצפה אליו
    return c.json({ status: "ok", results: data.results }, 200);
  } catch (err) {
    console.error(err);
    return c.json({ status: "error", message: String(err) }, 500);
  }
});

// Root (אופציונלי)
app.get("/", (c) => c.text("CartCompare AI server (GPT-5) is up."));

// Deno Deploy export
export default app;

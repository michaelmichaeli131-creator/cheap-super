// server_deno.ts — Deno Deploy: static via serveDir, API via Hono
// LLM-does-everything mode: server passes free text; model returns 3–4 stores sorted cheapest→expensive.
import { serveDir } from "jsr:@std/http/file-server";
import { Hono } from "jsr:@hono/hono";
import { OpenAI } from "jsr:@openai/openai";

type SearchRequest = {
  address?: string;
  radius_km?: number;
  list_text?: string; // טקסט חופשי מהקליינט
};

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
if (!OPENAI_API_KEY) {
  console.warn("[WARN] OPENAI_API_KEY is not set. Set it in Deno Deploy → Project → Settings → Environment Variables.");
}
const MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini";

const client = new OpenAI({ apiKey: OPENAI_API_KEY ?? "" });
const app = new Hono();

// ---------- API ----------
app.get("/healthz", (c) => c.json({ ok: true }));

app.post("/api/search", async (c) => {
  let body: SearchRequest;
  try {
    body = await c.req.json<SearchRequest>();
  } catch {
    return c.json({ status: "error", message: "Invalid JSON body", needed: [], results: [] }, 400);
  }

  const needed: string[] = [];
  if (!body.address?.trim()) needed.push("address");
  if (!Number.isFinite(Number(body.radius_km))) needed.push("radius_km");
  if (!body.list_text?.trim()) needed.push("list_text");
  if (needed.length) return c.json({ status: "need_input", needed, results: [] }, 400);

  try {
    const results = await llmEverything(body);

    // קשיחות מינימלית ליתר ביטחון מול סטיות מודל
    if (!Array.isArray(results.needed)) results.needed = [];
    if (!Array.isArray(results.results)) results.results = [];
    for (const r of results.results) {
      if (!Array.isArray(r.basket)) r.basket = [];
      for (const b of r.basket) {
        if (typeof b.match_confidence !== "number") b.match_confidence = 0;
        if (typeof b.substitution !== "boolean") b.substitution = false;
        if (typeof b.notes !== "string") b.notes = "";
      }
      // עקביות סכום
      if (Array.isArray(r.basket)) {
        r.total_price = r.basket.reduce((acc: number, l: any) => acc + Number(l.line_total || 0), 0);
      }
    }

    return c.json(results);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/api/search] error:", message);
    return c.json({ status: "error", message, needed: [], results: [] }, 500);
  }
});

// ---------- Single LLM call that does EVERYTHING ----------
async function llmEverything(req: SearchRequest) {
  const instructions = `
אתה מבצע השוואת סל קניות מקצה לקצה על בסיס טקסט חופשי בעברית.
קלט: כתובת/עיר, רדיוס בק"מ, וטקסט חופשי עם רשימת קניות (ללא תלות בפסיקים).
משימות:
1) הבן את רשימת הפריטים והכמויות מהטקסט החופשי (נרמול שמות, איחוד יחידות, התמודדות עם שגיאות כתיב).
2) בנה 3–4 אפשרויות של חנויות קרובות (בתוך הרדיוס), כולל תחליפים סבירים (אם צריך) והערכות מחיר סבירות.
3) החזר את התוצאות **ממוינות מהזול ליקר** והוסף לכל תוצאה שדה rank עוקב שמתחיל ב-1.
4) עקביות חישובית: line_total = unit_price * quantity; וסכום ה-line_total = total_price.
5) החזר match_confidence לכל שורת פריט (0..1), ואם זו התאמה לא מדויקת הוסף substitution=true; הוסף notes:string (יכול להיות ריק).
6) הוסף match_overall (0..1) לכל חנות.
7) אל תוסיף טקסט חופשי מעבר ל-JSON ולא שדות שלא בסכמה.
`.trim();

  const payload = {
    address: req.address,
    radius_km: Number(req.radius_km),
    list_text: req.list_text,
  };

  const response = await client.responses.create({
    model: MODEL,
    instructions,
    input: JSON.stringify(payload),
    // Structured output (strict) — כל המפתחות מוגדרים ב-required
    text: {
      format: {
        type: "json_schema",
        name: "SearchResults",
        strict: true,
        schema: {
          type: "object",
          properties: {
            status: { enum: ["ok", "no_results", "need_input", "error"] },
            needed: { type: "array", items: { type: "string" } },
            results: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  rank: { type: "number" },
                  store_name: { type: "string" },
                  address: { type: "string" },
                  distance_km: { type: "number" },
                  currency: { type: "string" },
                  total_price: { type: "number" },
                  match_overall: { type: "number" },
                  basket: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        quantity: { type: "number" },
                        unit_price: { type: "number" },
                        line_total: { type: "number" },
                        match_confidence: { type: "number" },
                        substitution: { type: "boolean" },
                        notes: { type: "string" }
                      },
                      required: [
                        "name",
                        "quantity",
                        "unit_price",
                        "line_total",
                        "match_confidence",
                        "substitution",
                        "notes"
                      ],
                      additionalProperties: false
                    }
                  }
                },
                required: [
                  "rank",
                  "store_name",
                  "address",
                  "distance_km",
                  "currency",
                  "total_price",
                  "match_overall",
                  "basket"
                ],
                additionalProperties: false
              }
            }
          },
          required: ["status", "needed", "results"],
          additionalProperties: false
        }
      }
    },
    temperature: 0.15,
    max_output_tokens: 1600
  });

  const text =
    (response as any).output_text ??
    ((response as any).output?.[0]?.content?.[0]?.type === "output_text"
      ? (response as any).output[0].content[0].text
      : undefined);
  if (!text) throw new Error("LLM returned no text");

  const data = JSON.parse(text);
  return data;
}

// ---------- HTTP entry (static + API) ----------
Deno.serve((req) => {
  const url = new URL(req.url);

  // API goes to Hono app
  if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") {
    return app.fetch(req);
  }

  // Everything else: serve ./public with index.html as default
  return serveDir(req, { fsRoot: "public", urlRoot: "", index: "index.html" });
});

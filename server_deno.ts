/// <reference no-default-lib="true"/>
import { Hono } from "@hono/hono";
// סטטי דרך אדפטור Deno (מונע getContent error)
import { serveStatic } from "@hono/hono/deno";
import OpenAI from "@openai/openai";

/** ===== Bindings (Env) ===== */
type Bindings = {
  OPENAI_API_KEY: string;
  OPENAI_MODEL?: string;
};

/** ===== App ===== */
const app = new Hono<{ Bindings: Bindings }>();

/** ===== Static (UI) ===== */
app.use("/", serveStatic({ root: "./public" }));

/** ===== Helpers (ENV, client) ===== */
function getOpenAIClient(apiKey: string) {
  return new OpenAI({ apiKey });
}

function readEnv(c: any) {
  const key =
    (c?.env?.OPENAI_API_KEY as string | undefined) ?? Deno.env.get("OPENAI_API_KEY");
  const model =
    (c?.env?.OPENAI_MODEL as string | undefined) ?? Deno.env.get("OPENAI_MODEL") ?? "gpt-4o";
  return { key, model };
}

/** ===== System Prompt (עקרונות) =====
  * ה-LLM לא ממציא מחירים—אם אין לו נתונים אמיתיים, יחזיר no_results.
  * תמיד מחזיר JSON תקין לפי הסכימה בלבד (ללא טקסט חופשי).
*/
const SYSTEM_PROMPT = `
You are a strict JSON API that ranks the three cheapest supermarket branches for a shopping basket in Israel.

Behavior rules:
- Do NOT fabricate prices, distances or store data. If you cannot access real data, return "no_results".
- If input is missing, return "need_input" with the missing fields.
- Currency is ILS. Distances are kilometers (one decimal if needed).
- Output MUST be valid JSON only (no prose), matching the provided JSON schema.
`.trim();

/** ===== JSON Schema ל-response_format ===== */
const TOP3_SCHEMA = {
  name: "Top3Groceries",
  schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["ok", "no_results", "need_input", "error"] },
      needed: {
        type: "array",
        items: { type: "string", enum: ["address", "items", "radius_km"] }
      },
      results: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            rank: { type: "integer" },
            store_name: { type: "string" },
            address: { type: "string" },
            distance_km: { type: "number" },
            total_price: { type: "number" },
            currency: { const: "ILS" },
            basket: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  quantity: { type: "number" },
                  unit_price: { type: "number" },
                  line_total: { type: "number" },
                },
                required: ["name", "quantity", "unit_price", "line_total"]
              }
            }
          },
          required: ["rank", "store_name", "address", "distance_km", "total_price", "currency", "basket"]
        }
      }
    },
    required: ["status"]
  }
} as const;

/** ===== בניית פרומפט־משתמש מהקלט =====
  * השרת לא מחשב—רק מרכיב טקסט ברור ושולח ל-LLM.
*/
function buildUserPrompt(
  address: string,
  radius_km: number | string,
  shopping_list: Array<{ name: string; quantity?: number }>
) {
  const normalized = (shopping_list || [])
    .map((it) => {
      const n = String(it?.name ?? "").trim();
      const q = Number(it?.quantity ?? 1);
      return n ? `- ${n}; qty=${isFinite(q) && q > 0 ? q : 1}` : "";
    })
    .filter(Boolean)
    .join("\n");

  return `
מצא לי את סל הקניות הזול ביותר ל-TOP-3 סניפים בתוך רדיוס נתון, והחזר אך ורק JSON לפי הסכימה (אין טקסט חופשי).

קלט:
- כתובת/עיר: ${address}
- רדיוס (ק״מ): ${radius_km}
- רשימת קניות (שם + כמות):
${normalized}

דרישות:
- אם חסר address או radius_km או רשימת קניות ריקה → החזר {"status":"need_input","needed":[...]}.
- אם אינך יכול לאחזר נתוני אמת (שקיפות מחירים/מרחקים), החזר {"status":"no_results"}.
- אם יש נתוני אמת, החזר {"status":"ok","results":[ {rank,store_name,address,distance_km,total_price,currency,basket:[...]}, ... ]} עד 3 תוצאות, ממויין מהזול ליקר (שוויון → הקרוב יותר).

זכור: אין לפברק נתונים. החזר JSON בלבד העומד בדיוק לסכימה.
`.trim();
}

/** ===== קריאה ל-LLM ===== */
async function callLLM(userPrompt: string, client: OpenAI, model: string) {
  try {
    const resp = await client.responses.create({
      model,
      instructions: SYSTEM_PROMPT,       // במקום system
      input: userPrompt,                 // הטקסט הקבוע שנבנה בשרת
      response_format: {                 // מחייב החזרת JSON לפי סקימה
        type: "json_schema",
        json_schema: TOP3_SCHEMA,
      },
      // שומרים את זה ללא tools כדי להימנע משגיאות הרשאות/קונטיינר
      // tools: [{ type: "web_search" }, { type: "code_interpreter" }],
    });

    // עדיפות לפענוח מובנה אם קיים
    const anyResp = resp as any;
    if (anyResp.output_parsed) {
      return anyResp.output_parsed;
    }

    // אחרת—ננסה מפלט טקסטואלי
    const text =
      anyResp.output_text ??
      (Array.isArray(anyResp.output)
        ? anyResp.output
            .map((o: any) =>
              Array.isArray(o.content) ? o.content.map((c: any) => c.text || "").join("\n") : ""
            )
            .join("\n")
        : JSON.stringify(resp));

    try {
      return JSON.parse(String(text).trim());
    } catch {
      const m = String(text).match(/\{[\s\S]*\}/);
      if (m) {
        try { return JSON.parse(m[0]); } catch {}
      }
      return { status: "error", message: "Model did not return valid JSON", raw: text };
    }
  } catch (e: any) {
    console.error("LLM error:", e?.message || e);
    return { status: "error", message: `LLM request failed: ${String(e?.message || e)}` };
  }
}

/** ===== Routes ===== */

// Health
app.get("/health", (c) => c.text("ok"));

// API: TOP-3 cheapest (כולו דרך LLM, השרת לא מחשב)
app.post("/api/search", async (c) => {
  try {
    const { key, model } = readEnv(c);
    if (!key) return c.json({ status: "error", message: "OPENAI_API_KEY missing" }, 500);
    const client = getOpenAIClient(key);

    // קלט מהמשתמש
    const body = await c.req.json().catch(() => ({}));
    const address = String(body?.address ?? "").trim();
    const radius_km = body?.radius_km ?? "";
    const shopping_list = Array.isArray(body?.shopping_list) ? body.shopping_list : [];

    // בניית פרומפט ושליחה ל-LLM
    const userPrompt = buildUserPrompt(address, radius_km, shopping_list);
    const out = await callLLM(userPrompt, client, model);

    return c.json(out);
  } catch (e: any) {
    console.error("search route error:", e);
    return c.json({ status: "error", message: "internal_error" }, 500);
  }
});

/** ===== Export (Deno Deploy) ===== */
export default { fetch: app.fetch };

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
    (c?.env?.OPENAI_MODEL as string | undefined) ?? Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini";
  return { key, model };
}

/** ===== System Prompt =====
 * ה-LLM לא ממציא מחירים/מרחקים; אם אין נתונים אמיתיים — מחזיר no_results.
 * תמיד JSON תקין בלבד.
 */
const SYSTEM_PROMPT = `
You are a strict JSON API that ranks the three cheapest supermarket branches for a given shopping basket in Israel.

Rules:
- Do NOT fabricate prices, distances or store data. If you cannot access real, verifiable data, return {"status":"no_results"}.
- If required inputs are missing, return {"status":"need_input","needed":[...]} with any of: "address","items","radius_km".
- Currency is ILS; distances are kilometers (one decimal if needed).
- Output MUST be valid JSON only (no prose).
- Sort results from cheapest to most expensive; break ties by distance (closer first).
`.trim();

/** ===== בונה פרומפט-משתמש ===== */
function buildUserPrompt(
  address: string,
  radius_km: number | string,
  shopping_list: Array<{ name: string; quantity?: number }>
) {
  const listBlock = (shopping_list ?? [])
    .map((it) => {
      const n = String(it?.name ?? "").trim();
      const q = Number(it?.quantity ?? 1);
      return n ? `- ${n}; qty=${isFinite(q) && q > 0 ? q : 1}` : "";
    })
    .filter(Boolean)
    .join("\n");

  // מגדירים מפורשות את מבנה ה-JSON בפלט
  const schemaHint = `
Return ONLY strict JSON in this shape:

{
  "status": "ok" | "no_results" | "need_input" | "error",
  "needed": string[] | undefined,
  "results": [
    {
      "rank": number,
      "store_name": string,
      "address": string,
      "distance_km": number,
      "total_price": number,
      "currency": "ILS",
      "basket": [
        { "name": string, "quantity": number, "unit_price": number, "line_total": number }
      ]
    }
  ]
}
`.trim();

  return `
Find the three cheapest supermarket branches (TOP-3) for this basket within the given radius and output ONLY JSON per the shape below.

Input:
- Address/City: ${address || "<missing>"}
- Radius (km): ${String(radius_km || "<missing>")}
- Shopping list (one per line; each may include "; qty="):
${listBlock || "<empty>"}

If any required input is missing, return:
{"status":"need_input","needed":[...]}  // any of: "address","items","radius_km"

If you cannot access real, verifiable pricing/branch data, return:
{"status":"no_results"}

Otherwise return:
${schemaHint}
`.trim();
}

/** ===== קריאה ל-LLM (Responses API עם text.format=json) ===== */
async function callLLM(userPrompt: string, client: OpenAI, model: string) {
  try {
    const resp = await client.responses.create({
      model,
      instructions: SYSTEM_PROMPT,
      input: userPrompt,
      // שימו לב: זה הפורמט החדש! (במקום response_format)
      text: { format: "json" },
      // לא מפעילים tools כדי להימנע משגיאות הרשאות/קונטיינר ב-Deno Deploy
    });

    // נסה לקבל פלט מובנה
    const anyResp = resp as any;
    const textOut: string =
      anyResp.output_text ??
      (Array.isArray(anyResp.output)
        ? anyResp.output
            .map((o: any) =>
              Array.isArray(o.content) ? o.content.map((c: any) => c.text || "").join("\n") : ""
            )
            .join("\n")
        : "");

    if (!textOut) {
      // fallback אחרון: החזר את כל המענה גולמי כדי להבין מה קרה
      return { status: "error", message: "Empty model output", raw: anyResp };
    }

    try {
      return JSON.parse(textOut);
    } catch {
      // נסה לחלץ בלוק JSON
      const m = String(textOut).match(/\{[\s\S]*\}/);
      if (m) {
        try { return JSON.parse(m[0]); } catch {}
      }
      return { status: "error", message: "Model did not return valid JSON", raw: textOut };
    }
  } catch (e: any) {
    console.error("LLM error:", e?.message || e);
    return { status: "error", message: `LLM request failed: ${String(e?.message || e)}` };
  }
}

/** ===== Routes ===== */

// Health
app.get("/health", (c) => c.text("ok"));

// API: TOP-3 cheapest (כולו דרך LLM; השרת אינו מחשב)
app.post("/api/search", async (c) => {
  try {
    const { key, model } = readEnv(c);
    if (!key) return c.json({ status: "error", message: "OPENAI_API_KEY missing" }, 500);
    const client = getOpenAIClient(key);

    // קלט מהלקוח
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

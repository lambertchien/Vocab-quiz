import { createClient } from "jsr:@supabase/supabase-js@2";

// ─── config ────────────────────────────────────────────────────────────────
// Set these via: supabase secrets set ALLOWED_EMAILS="a@x.com,b@x.com"
const ALLOWED_EMAILS = (Deno.env.get("ALLOWED_EMAILS") ?? "")
  .split(",").map(e => e.trim()).filter(Boolean);

const GEMINI_KEY    = Deno.env.get("GEMINI_KEY") ?? "";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_KEY") ?? "";
const DAILY_LIMIT   = 150; // max AI calls per user per day
const GEMINI_BASE   = "https://generativelanguage.googleapis.com/v1beta/models/";
// Fallback chain: try each model in order when previous is overloaded
const GEMINI_MODELS = [
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-1.5-flash",
];

// ─── CORS headers (Supabase Edge Functions need these for browser calls) ───
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

// ─── main ──────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // Read body immediately — must happen before any other awaits
  const bodyText = await req.text();
  let body: { provider?: string; prompt?: string } = {};
  try { body = JSON.parse(bodyText); } catch { return err("Invalid JSON body", 400); }

  // 1. Verify caller is logged in
  const jwt = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!jwt) return err("Not authenticated", 401);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, // server-side key, never in browser
  );

  const { data: { user }, error: authErr } = await supabase.auth.getUser(jwt);
  if (authErr || !user) return err("Invalid token", 401);

  // 2. Allowlist check — only approved emails can use your AI budget
  if (ALLOWED_EMAILS.length > 0 && !ALLOWED_EMAILS.includes(user.email!)) {
    return err("Not authorised", 403);
  }

  // 3. Daily rate limit
  const today = new Date().toISOString().slice(0, 10);
  const { data: usage } = await supabase
    .from("ai_usage")
    .select("count")
    .eq("user_id", user.id)
    .eq("date", today)
    .maybeSingle();

  const currentCount = usage?.count ?? 0;
  if (currentCount >= DAILY_LIMIT) {
    return err(`Daily AI limit of ${DAILY_LIMIT} calls reached`, 429);
  }

  await supabase.from("ai_usage").upsert(
    { user_id: user.id, date: today, count: currentCount + 1 },
    { onConflict: "user_id,date" },
  );

  const { provider, prompt } = body;

  // 5. Forward to chosen AI provider
  if (provider === "gemini") {
    const reqBody = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
    });
    let lastError = "All Gemini models busy";
    for (const model of GEMINI_MODELS) {
      const url = GEMINI_BASE + model + ":generateContent?key=" + GEMINI_KEY;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: reqBody,
      });
      const raw = await res.text();
      console.log("gemini model:", model, "| status:", res.status, "| body:", raw.slice(0, 200));
      let data: Record<string, unknown>;
      try { data = JSON.parse(raw); } catch { lastError = "Gemini non-JSON: " + raw.slice(0, 100); continue; }
      const e = data.error as { code?: number; status?: string; message?: string } | undefined;
      if (e) {
        // Retry with next model if overloaded or rate-limited
        if (e.status === "UNAVAILABLE" || e.status === "RESOURCE_EXHAUSTED" || e.code === 503 || e.code === 429) {
          lastError = e.message ?? lastError; continue;
        }
        return err(e.message ?? "Gemini error", 502);
      }
      const text = (data.candidates as Array<{content:{parts:Array<{text?:string}>}}>)?.[0]?.content?.parts?.[0]?.text ?? "";
      return ok({ text });
    }
    return err(lastError, 503);
  }

  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const raw = await res.text();
    console.log("anthropic status:", res.status, "| body:", raw.slice(0, 300));
    let data: Record<string, unknown>;
    try { data = JSON.parse(raw); } catch { return err("Anthropic non-JSON: " + raw.slice(0, 200), 502); }
    if (data.error) return err((data.error as { message: string }).message, 502);
    const text = (data.content as Array<{text?:string}>)?.map((c) => c.text ?? "").join("") ?? "";
    return ok({ text });
  }

  return err("Unknown provider", 400);
});

function ok(data: unknown) {
  return new Response(JSON.stringify(data), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
function err(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

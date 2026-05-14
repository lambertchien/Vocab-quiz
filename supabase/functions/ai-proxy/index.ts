import { createClient } from "jsr:@supabase/supabase-js@2";

// ─── config ────────────────────────────────────────────────────────────────
// Set these via: supabase secrets set ALLOWED_EMAILS="a@x.com,b@x.com"
const ALLOWED_EMAILS = (Deno.env.get("ALLOWED_EMAILS") ?? "")
  .split(",").map(e => e.trim()).filter(Boolean);

const GEMINI_KEY    = Deno.env.get("GEMINI_KEY") ?? "";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_KEY") ?? "";
const DAILY_LIMIT   = 150; // max AI calls per user per day

// ─── CORS headers (Supabase Edge Functions need these for browser calls) ───
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

// ─── main ──────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

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

  // 4. Parse request body
  const { provider, prompt } = await req.json();

  // 5. Forward to chosen AI provider
  if (provider === "gemini") {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
        }),
      },
    );
    const data = await res.json();
    if (data.error) return err(data.error.message, 502);
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    return ok({ text });
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
    const data = await res.json();
    if (data.error) return err(data.error.message, 502);
    const text = data.content?.map((c: { text?: string }) => c.text ?? "").join("") ?? "";
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

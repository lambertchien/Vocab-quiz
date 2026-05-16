import { createClient } from "jsr:@supabase/supabase-js@2";

// ─── config ────────────────────────────────────────────────────────────────
const GEMINI_KEY    = Deno.env.get("GEMINI_KEY") ?? "";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_KEY") ?? "";
const DAILY_LIMIT   = 150; // max AI calls per user per day

// ─── CORS headers ───────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

// ─── main ──────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    // 1. Verify caller is logged in
    const jwt = req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!jwt) return err("Not authenticated", 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: { user }, error: authErr } = await supabase.auth.getUser(jwt);
    if (authErr || !user) return err("Invalid token", 401);

    // 2. Parse request body
    const bodyText = await req.text();
    console.log("body length:", bodyText.length, "| first 100:", bodyText.slice(0, 100));
    if (!bodyText) return err("Empty request body", 400);
    const { provider, prompt } = JSON.parse(bodyText);

    // 3. Daily rate limit (best-effort — if ai_usage table missing, still allow the call)
    try {
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
    } catch (_) { /* rate limit table not ready — allow the call */ }

    // 4. Forward to chosen AI provider
    console.log("provider:", provider, "| prompt length:", prompt?.length);

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
      const geminiText = await res.text();
      console.log("gemini status:", res.status, "| response:", geminiText.slice(0, 200));
      const data = JSON.parse(geminiText);
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

  } catch (e) {
    return err(e instanceof Error ? e.message : "Internal error", 500);
  }
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

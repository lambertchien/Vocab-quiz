# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

A single-file vocabulary learning web app (`index.html` — ~1800 lines of HTML + CSS + vanilla JS). No build step, no dependencies, no server. Open the file directly in a browser to run it.

## Architecture

Everything lives in `index.html`:

- **CSS** (lines 7–213): CSS custom properties for light/dark theming (`--bg`, `--text`, etc.) with a `prefers-color-scheme` dark override.
- **HTML structure** (lines 215–504): Four tabs — *Add word*, *My words*, *Flashcards*, *Quiz me* — each as a `<div id="tab-*" class="screen">`. A settings panel overlay handles API keys and Supabase config.
- **JavaScript** (lines 506–end): One flat script block, no modules. Sections are delimited by banner comments (`/* ══ SECTION ══ */`).

## Key data model

`vocab` is a plain array stored in `localStorage` (`vocab_quiz_words`). Each entry:
```js
{ word, definition, translation, synonyms[], antonyms[], lesson, correct, wrong, lastModified }
```
`definition` and `translation` are multiline strings (one meaning per line). `deletedWords` (`vocab_quiz_deleted`) is a string array of lowercased words used as tombstones for cross-device sync.

## AI integration

Two providers are supported and toggled via `AI_PROVIDER`:
- **Gemini** — default, free tier via Google AI Studio
- **Anthropic** — pay-as-you-go, `claude-sonnet-4-20250514`

All AI calls go through the Supabase Edge Function `ai-proxy` (`supabase/functions/ai-proxy/index.ts`). The browser sends the user's session JWT; the function verifies it, checks the ALLOWED_EMAILS allowlist, enforces a daily rate limit via the `ai_usage` table, then forwards to the chosen provider. AI keys are never exposed to the browser.

`callAI(prompt)` in `index.html` is the single entry point. It posts `{ provider, prompt }` to the Edge Function and returns the text response.

AI is used for: word lookup/definition generation, synonym/antonym fetch, bulk re-explain, and quiz answer grading.

## Supabase sync

Optional cross-device sync via the Supabase REST API (no SDK). The `vocabs` table uses `word` as the natural key. Sync is last-write-wins per field using `lastModified` timestamps, with soft deletes (`deleted: true`) propagated as tombstones. Upserts are chunked at 20 rows to avoid payload limits.

## Quiz modes

- `chinese` — show Chinese translation, type the English word
- `explain` — show the word, type a free-form explanation (AI-graded)
- `meaning` — show English meaning, type the word
- `synant` — show the word, type a synonym or antonym

The `explain` mode sends user input to the AI for grading and returns `correct`/`partial`/`wrong`.

## Supabase secrets (Edge Function)

These must exist in Supabase → Edge Functions → Secrets or the AI proxy will fail silently:

| Secret | Description |
|---|---|
| `GEMINI_KEY` | Google AI Studio API key (starts with `AIza...`) |
| `ANTHROPIC_KEY` | Anthropic API key (starts with `sk-ant-...`) |
| `ALLOWED_EMAILS` | Comma-separated list of emails allowed to use AI (e.g. `lambert@jz,ivy@jz`) |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by Supabase — do not set these manually.

## Required database tables

The `ai_usage` table must exist for the Edge Function to work (it is queried on every AI call):

```sql
CREATE TABLE IF NOT EXISTS public.ai_usage (
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  date    date    NOT NULL,
  count   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);
ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users can read own usage" ON public.ai_usage
  FOR SELECT USING (auth.uid() = user_id);
```

If this table is missing the Edge Function crashes before reading the request body, producing a CORS error in the browser with no helpful message.

## Safe workflow for Edge Function experiments

**Never modify `ai-proxy` directly to test a new idea.** Instead:

1. In Supabase → Edge Functions, create a new function called `ai-proxy-test` (or any temp name)
2. Paste the experimental code there and deploy
3. Temporarily point `callAI()` in `index.html` to `/functions/v1/ai-proxy-test` for testing
4. Once confirmed working, copy the code into `ai-proxy` and redeploy
5. Delete `ai-proxy-test`

This keeps the production function untouched and avoids any rollback situation.

## Safe workflow for database changes

- **Never run `DROP TABLE` on production directly.** Write schema changes as `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` SQL and commit them to git alongside the code that needs them.
- If a table must be dropped and recreated, keep the `CREATE TABLE` SQL in a file in this repo so it can be restored in seconds.

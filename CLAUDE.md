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
- **Gemini** (`callGemini`) — default, free tier via `aistudio.google.com`
- **Anthropic** (`callAnthropic`) — pay-as-you-go, `claude-sonnet-4-20250514`

Both are called directly from the browser (keys stored in `localStorage`). AI is used for: word lookup/definition generation, synonym/antonym fetch, bulk re-explain, and quiz answer grading.

## Supabase sync

Optional cross-device sync via the Supabase REST API (no SDK). The `vocabs` table uses `word` as the natural key. Sync is last-write-wins per field using `lastModified` timestamps, with soft deletes (`deleted: true`) propagated as tombstones. Upserts are chunked at 20 rows to avoid payload limits.

## Quiz modes

- `chinese` — show Chinese translation, type the English word
- `explain` — show the word, type a free-form explanation (AI-graded)
- `meaning` — show English meaning, type the word
- `synant` — show the word, type a synonym or antonym

The `explain` mode sends user input to the AI for grading and returns `correct`/`partial`/`wrong`.

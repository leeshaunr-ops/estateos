# Plan: AI-drafted inspection summaries (`ai-summaries`)

Staff finish a visit, tap **Draft summary with AI**, read the draft next to the checklist, edit it, and use it. Nothing AI-written reaches a family until a person has reviewed it. Off by default (server switch **and** per-company switch).

## What I found in the repo
| Topic | Reality in `stability-baseline` (47487ac, after weather, flights and photo spots) |
|---|---|
| Summary | `inspections.summary` (text). Required before publish (`publishInspection`: "Add an inspection summary."). Edited in the inspection screen (`<div data-sync-key="summary">`) and saved through the offline draft queue (`syncInspectionDraft` → `/api/inspections/save` or the offline sync route), so the server never sets the summary text itself here. |
| Publish | `/api/inspections/publish` (admin, idempotency key) and `/api/inspections/submit` with `autoPublish`; both go through `publishInspection(user,row,…)`, which freezes `report_snapshot`. |
| Weather | `inspections.weather_snapshot` (JSON with a plain `line`), shipped in #63; the draft can mention the conditions at the visit. |
| Platform owner | `platformOwner(user)` (`ESTATEOS_PLATFORM_OWNER_ID`). |
| Idempotency | `idempotency` table for publish; offline ops use `Idempotency-Key` headers. |
| Email / demo | Not used by this feature. |

## Decisions
- **Provider:** OpenAI **Responses API** over `fetch` (no SDK): `POST {OPENAI_BASE_URL}/responses` with `text.format` = strict JSON schema, `store:false`, `max_output_tokens` 800, `reasoning.effort` `low` for reasoning models, timeout `OPENAI_TIMEOUT_MS` (20 s), **one** retry on 429/5xx with jitter. Model `OPENAI_MODEL`, default **`gpt-5.4-mini`** (tested: ~2 s, ~220 tokens per summary, follows the schema; `gpt-4.1-mini` works as a fallback).
- **Switches:** `AI_FEATURES_ENABLED=true` on the server **and** `ai_settings.enabled` per company (admin). `AI_PROVIDER=openai|fake` (`fake` = deterministic local drafts for demos, tests and screenshots; never calls out).
- **Data minimisation (allow-list input builder):** only visit type, date, residence time zone label, checklist items (section, label, status, note), photo count per item, overall result, notes to the client, and the weather line. Never: names (client, family, staff, residence), addresses, access codes, internal notes, emails, phone numbers, URLs, GPS, report numbers.
- **Redaction** of free text before sending: emails, phones, URLs, long digit runs, access/alarm/gate/door/lockbox codes, street addresses, and every known name (company, client, family members, staff, residence) → neutral words ("the residence", "a team member").
- **Leak scan** on the answer: if the draft contains any known name, address, email, phone or code, it is **discarded** (status `blocked`), the user sees "The draft included private details, so it was not shown. Try again or write the summary yourself." Nothing is stored except the event.
- **Coverage check:** every item marked Fail / Needs attention / Monitor must be mentioned (model returns `mentioned_items`, cross-checked against the draft text). Missing items are listed in the review panel ("Not mentioned: …").
- **Versioned prompt** in `prompts/inspection-summary-v1.md`, version recorded on every draft and event.
- **Human review is required:** "Use this draft" fills the summary field and marks the summary `ai_draft`. Publishing (and auto-publish) is refused with `ai_review_required` until someone ticks **I have read and checked this AI-assisted summary**; the review stores who/when and a hash of the reviewed text, so any later edit needs a new review.
- **Cost controls:** atomic monthly cap per company (`ai_usage_monthly`, `UPDATE … SET count=count+1 WHERE count<cap`), default `AI_MONTHLY_CAP_DEFAULT` = 300 drafts; per-user rate limit (10 per 10 minutes) and per-visit limit (5 per hour); failures before a response are refunded; `Idempotency-Key` on generate returns the same draft for a retried tap. Platform owner can set a per-company cap override.
- **Reports:** the PDF shows the summary as written. Optional company setting **"Note AI assistance on reports"** (default off) adds "Summary drafted with AI assistance and reviewed by <company>." under the summary.
- **Privacy wording:** "When a team member asks for a draft summary, we send the visit's checklist results, notes to the client and weather at the visit, with names, addresses and access codes removed, to OpenAI, our AI subprocessor, to write the draft. OpenAI does not keep the data for training (API data, store off). A team member reviews every draft before it reaches a family."

## Schema `migrations/043_ai_summaries.sql` (additive, both engines)
- `ai_settings(organization_id PK, enabled, label_reports, monthly_cap, platform_cap_override, updated_by, updated_at)`
- `ai_summary_drafts(id PK, organization_id, inspection_id, user_id, idempotency_key, status (ready|used|discarded|blocked|failed), text, mentioned_items, missing_items, model, prompt_version, input_hash, tokens_in, tokens_out, latency_ms, error, created_at, used_at, discarded_at)` + unique `(user_id, idempotency_key)`
- `ai_usage_events(id PK, organization_id, user_id, inspection_id, draft_id, kind, status, model, tokens_in, tokens_out, latency_ms, created_at)`
- `ai_usage_monthly(organization_id, month, drafts, tokens_in, tokens_out, PK(organization_id, month))`
- `inspections.summary_source` (`manual` | `ai_draft`), `summary_ai_draft_id`, `summary_reviewed_by`, `summary_reviewed_at`, `summary_reviewed_hash`

## API
| Route | Who | |
|---|---|---|
| `POST /api/inspections/:id/ai-summary` (`Idempotency-Key`) | admin, staff who can work on the visit; draft only | → `{draft:{id,text,mentionedItems,missingItems,model,promptVersion}, usage}`; 409 not a draft; 403 off; 429 cap / rate; 422 nothing to summarise; 502/504 provider |
| `POST /api/inspections/:id/ai-summary/:draftId/discard` | same | |
| `POST /api/inspections/:id/ai-summary/:draftId/use` | same | marks the visit's summary as AI-assisted (`ai_draft`), resets review |
| `POST /api/inspections/:id/ai-summary/review` | same | stores reviewer, time and summary hash |
| `GET /api/ai/usage` | admin | month count, cap, by person, recent events |
| `GET/POST /api/settings/ai` | admin | enabled, label on reports, company cap (≤ platform cap) |
| `POST /api/ai/platform-cap` | platform owner | per-company cap override |
| publish / submit+autoPublish | | 422 `{code:'ai_review_required'}` when an AI-assisted summary is not reviewed |

`/api/data` adds `data.ai = {available, enabled, reason, used, cap, labelReports}` for staff; inspections carry `summary_source` and `summary_reviewed_at` for staff only.

## UI
- Inspection draft: **Draft summary with AI** under the summary field, with the reason when unavailable (off for the company, server switch off, monthly limit reached, finish at least one checklist item). Review panel: draft text, "Not mentioned" warnings, **Use this draft** / **Try again** / **Discard**, "AI drafts can be wrong; check every sentence." **AI-assisted** tag next to the summary label once used.
- Publish: confirmation with the checkbox when the summary is AI-assisted and not reviewed for its current text.
- Company settings → **AI summaries** panel (admin): on/off, note on reports, usage this month and cap, privacy wording naming OpenAI.

## Tests
Unit (input builder allow-list, redaction, leak scan, coverage, schema parsing, refusal/incomplete), provider against a local OpenAI stand-in (headers, `store:false`, schema, timeout, one retry on 429/5xx, malformed JSON, refusal), API on SQLite and PGlite (permissions, company isolation, cap atomic under concurrency, rate limits, idempotency, review gate on publish and auto-publish, hash invalidation), a **grep for the key** across every response body and the database, PDF label on/off, signed-in smoke with an axe check of the review panel.

## Rollout
Merge → staging: set `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-5.4-mini`, `AI_FEATURES_ENABLED=true` (staging only), turn it on for a demo company, generate on demo data. Production stays off (no env) until Shaun decides budget, DPA and customer communication.

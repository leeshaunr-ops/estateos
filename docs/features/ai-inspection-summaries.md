# AI inspection summaries

Staff finish a visit, tap **Draft summary with AI**, read the suggestion, and either **Use this draft** (it fills the
summary box like typed text and saves through the normal device draft queue), **Try again**, or **Discard**. Nothing
AI-written reaches a family until a person has confirmed the exact text being published.

## Turning it on
Two switches, both off by default:

| Switch | Where | Effect |
|---|---|---|
| `AI_FEATURES_ENABLED=true` | server env | the feature exists on this server |
| **AI inspection summaries** | Company settings (admin) | the company's team can ask for drafts |

| Env var | Default | |
|---|---|---|
| `OPENAI_API_KEY` | (none) | server secret; never sent to browsers, logged or stored |
| `OPENAI_MODEL` | `gpt-5.4-mini` | `gpt-4.1-mini` works as a fallback |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | tests point this at a local stand-in |
| `OPENAI_TIMEOUT_MS` | `20000` | one retry on 429 / 5xx |
| `AI_PROVIDER` | `openai` | `fake` = deterministic offline drafts (demos, tests, screenshots) |
| `AI_MONTHLY_CAP_DEFAULT` | `300` | drafts per company per month (platform owner can override per company) |

## What is sent (and what is not)
Allow-list only (`ai-core.mjs` → `buildInput`): visit type, date, residence time-zone label, checked items (section,
label, result, note), overall result, notes to the client, and the "weather at visit" line. **Never:** internal notes,
names of the company, family, staff or residence, street addresses, emails, phone numbers, links, access / alarm /
gate / door / lockbox codes, GPS, report numbers. Free text is redacted before sending (known names → "the
residence" / "a member of the household" / "our team"; codes → `[code]`; and so on). Requests use `store:false`.

The answer must match a strict JSON schema (`summary`, `mentioned_items`). It is then **leak-scanned**: if it contains
a known name, address, email, phone number or code, it is discarded (status `blocked`) and the person is asked to try
again. A **coverage check** lists every Fail / Needs attention / Monitor item the draft did not mention.

Privacy wording (shown in Company settings):
> When a team member asks for a draft summary, we send the visit's checklist results, notes to the client and weather
> at the visit, with names, addresses and access codes removed, to OpenAI, our AI subprocessor, to write the draft.
> OpenAI does not keep the data for training (API data, store off). A team member reviews every draft before it
> reaches a family.

## Review gate
"Use this draft" marks the visit's summary as AI-assisted (`inspections.summary_source='ai_draft'`). Publishing then
asks for a confirmation (checkbox: *I have read this summary and it is accurate*), which stores who, when and a hash of
the saved summary. Any later edit changes the hash, so publish (`/api/inspections/publish`) answers
`422 {code:'ai_review_required'}` until someone confirms again. **Mark complete → Publish automatically** leaves such a
visit *submitted* (`autoPublishSkipped:'ai_review_required'`) for the admin to confirm and publish.

Optional company setting **Label on PDF reports** (default off) adds "Summary drafted with AI assistance and reviewed by
<company>." under the summary in the PDF.

## Cost controls
- Monthly cap per company, reserved atomically before calling the provider; refunded when the provider never answered (timeout, network, 429, 5xx, bad key).
- 5 drafts per visit per hour, 10 per person per 10 minutes.
- `Idempotency-Key` (header or `idempotencyKey` in the body): a retried tap returns the same draft.
- Usage (`GET /api/ai/usage`, admin): drafts and tokens this month, by person, recent events (no content).

## API
| Route | Who |
|---|---|
| `POST /api/inspections/:id/ai-summary` | admin, staff who can work on the visit; draft visits only |
| `POST /api/inspections/:id/ai-summary/:draftId/use` · `/discard` | same |
| `POST /api/inspections/:id/ai-summary/review` | same |
| `GET/POST /api/settings/ai` | admin |
| `GET /api/ai/usage` | admin |
| `POST /api/ai/platform-cap` `{organizationId, cap|null}` | platform owner |

Errors are plain sentences: 403 (off), 409 (not a draft), 422 (nothing checked yet, provider declined, draft blocked),
429 (`ai_rate_limited`, `ai_cap_reached`), 502 / 503 / 504 (provider trouble). The provider's own error text and the key
never appear in responses or logs; logs record status, model, token counts and latency only.

## Files
`ai-core.mjs` (rules), `ai-provider.mjs` (OpenAI + fake), `ai-summaries.mjs` (API, hooks), `prompts/inspection-summary-v1.md`,
`migrations/043_ai_summaries.sql`, `public/ai-summaries.js|css`, `tests/ai-summaries.test.mjs`, `tests/openai-mock.mjs`.

## Screenshots
`docs/features/ai-inspection-summaries/` (fake provider, seeded demo data).

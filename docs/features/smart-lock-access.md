# Smart-lock access windows

Every visit or work order with an assignee and a date gets its own temporary door code for each lock at the residence. The code is valid only for that visit's or job's time window, plus a buffer the company sets. The assignee sees it in the staff app or vendor portal only during the window. Every reveal is recorded in the audit log, as with the residence's access codes.

## What it does
- **Locks per residence** (Residence › Home records › Smart locks): a name, plus either *Manual* or a lock from the company's connected lock account.
- **Windows**: jobs linked to a staff schedule use the scheduled hours. Visits and jobs that only have a date use the company's default hours (8 AM–6 PM unless changed) in the residence's time zone. The buffer (30 minutes by default, up to 4 hours) is added on both sides. Daylight-saving days are handled, overnight windows run into the next morning, and codes are created up to 14 days ahead.
- **Who sees the code**: only the assignee (the staff member who owns the visit, the staff member assigned to the job, or the users of the assigned vendor), and only inside the window. Administrators can view a code at any time; that view is audited too. Families never see door codes. Codes are never sent by email: the email or bell alert only says that a code is ready.
- **Revocation**: when a visit is completed or deleted, or a job is completed, reassigned or unassigned, its code is revoked. With a connected lock, the code is also deleted on the lock. An administrator's manual revoke sticks until they choose *Create door code*.
- **Manual mode** (works today, no account needed): the office gets a "Door code needed" alert, then enters a code or generates one and programs it on the lock. After the window, or after an early revoke, a work order "Remove temporary door code from …" opens with the last two digits as a reference.
- **Seam mode**: codes are created on the lock through Seam with `starts_at`/`ends_at`, window changes are pushed with `access_codes/update`, and revoked codes are deleted with `access_codes/delete`. If a push fails, it is retried on the next pass (every minute) and the error shows to administrators.
- **Lock entries**: signed Seam webhooks (`lock.unlocked`, `lock.access_denied`) attach to the visit or job by the code used, or else by the code window that covered that moment, with visits first. They show as **Lock entry** rows in the Visit verification box, next to GPS check-in, and in the report PDF.
- **Lock health**: `device.low_battery` (or a battery status of low or critical) opens one "Replace lock batteries" work order and alerts the office. A lock that stays offline for more than 30 minutes opens a "Lock offline" work order.

## Turning on the live connection (Seam)
1. Sign up at https://console.seam.co. Seam pricing at the time of writing: a free sandbox and trial; *Unit Access* costs about $5 per connected device per month.
2. In the Seam console, create an API key. Add the webhook endpoint `https://<your-domain>/api/webhooks/seam` with the events `lock.*`, `device.*`, `access_code.*` and `connected_account.connected`, and copy its signing secret (`whsec_…`).
3. Set the environment variables `SEAM_API_KEY` and `SEAM_WEBHOOK_SECRET` on the service.
4. Each company then goes to Company settings › Smart locks › *Connect lock account*. This opens Seam Connect, where the company signs in to August, Yale, Schlage, Kwikset or another supported brand. After that they choose *Check connection* and add each lock under its residence.

Without `SEAM_API_KEY`, everything runs in manual mode. `ESTATEOS_FAKE_LOCKS=1` turns on a built-in test lock service for local demos and tests. It is ignored on Render.

## Security notes
- Codes are sealed with the vault (`ESTATEOS_VAULT_KEY`) using a per-code context. `/api/data` never contains the digits, and field staff never get the code's hint.
- Webhooks are verified with Svix signatures (HMAC-SHA256 over `id.timestamp.body`, 5-minute tolerance) before anything is parsed. Repeated `event_id`s are ignored.
- Lock devices are listed only from the company's own connected accounts, and a device can be linked to only one residence.

## Code
`smart-locks.mjs` (rules, API, webhook), `lock-providers.mjs` (Seam client, manual, test service), `integration-core.mjs` (time-zone math, signatures; shared), `migrations/037_smart_lock_access.sql`, `public/smart-locks.js` / `.css`, tests in `tests/smart-locks.test.mjs` plus the signed-in smoke test.

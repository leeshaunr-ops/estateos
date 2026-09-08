# EstateOS — Working application foundation

## Hosted Supabase configuration

When running on Render with Supabase, set these environment variables in the Render service. Keep the database URL and service role key in Render only; never commit them to GitHub.

```text
DATABASE_URL=the Supabase Session pooler connection string
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_STORAGE_BUCKET=estateos-files
SUPABASE_SERVICE_ROLE_KEY=the Supabase service role key
ESTATEOS_HOST=0.0.0.0
ESTATEOS_SECURE_COOKIES=1
ESTATEOS_SETUP_KEY=a-long-random-first-setup-key
```

The `estateos-files` bucket must be private. On first startup, the server creates the `estateos` schema and applies the checked-in schema and migrations. The existing application login, role checks, audit records, and private file access continue to run through the server.

This is a real locally running application, not a role-switching demo. It starts with **Create company**, creates a password-protected administrator account, and persists business records in a SQLite database. No sample accounts or residences are silently imported.

## Start

Requires Node.js 24 or later. No dependency installation is required for this first local implementation.

```text
node server.mjs
```

Open `http://127.0.0.1:4317`. Keep the server running while using the app. `Start EstateOS.cmd` is supplied for this Windows computer and searches for Node on PATH or the existing Codex runtime. On another computer, install Node.js 24+ first.

Create your company and administrator password, then add client families, residences and vendors. Team & access creates single-use invitation links. Invited users choose their own passwords. An employee must be assigned a residence; a client must be linked to a family; a vendor must be linked to its vendor company. Local links work only on this computer until a hosted backend is configured.

## Working now

- Real password login, expiring server sessions, single-use invitations and account suspension.
- Families/residences and employee property assignments; client and vendor access checks on server requests.
- Asset records and asset-linked work/service history.
- Client requests, work orders, vendor photo submission and staff completion review.
- Original 28-item monthly inspection checklist, saved drafts, notes, uploaded photos and immutable publication.
- Correct-family published inspection lists and server-generated PDF with JPEG photo evidence; internal notes excluded.
- Residence shopping preferences, CSV/TXT import preview and arrival item snapshots; purchase/stock status and readiness checks.
- Maintenance plans and idempotent creation of due work. Automatic recurrence scheduling is not yet implemented.
- Private documents with explicit client visibility, internal notes and staff house manual.
- Admin-only invoices and partial payment records with overpayment rejection; simple USD ledger only.
- Calendar agenda, Google Maps route handoff, in-app notifications and append-only application audit.
- Persistent local database and protected file storage; no business data in browser localStorage.

## Important implementation boundary

This is the first working foundation, not the entire 21-section build specification or a production launch. The planned Next.js/Supabase dependency setup was blocked by the session's permissions. Existing Node.js capabilities allowed an independently runnable local implementation without installing or bypassing blocked dependencies. This decision preserves progress but does not replace the specified hosted architecture silently.

The app binds only to this computer by default. It has not been deployed publicly and is **not ready to expose to the internet**. Before real client rollout: complete security review, MFA/recovery, server rate-limit hardening, scalable sessions, file malware scanning, validated rich PDF typography, encrypted property secrets, automated offsite backups/restore, HTTPS/domain, transactional email, monitored worker jobs and final user-acceptance testing. Do not enter access credentials in manual text. Unicode outside the PDF writer's basic Latin range is currently represented with `?`; that limitation must be resolved before branded production reports.

Still pending from the full target: template editor/revisions/retractions, scheduled recurring maintenance and recurring fees, reimbursements/credits/refunds, Stripe/QuickBooks, advanced maps/clusters, arrival change approvals, property edit/archive/contact workflows, full record import/reconciliation, notification preferences/email, projects/time/QR, production deployment and browser UI QA. Do not mark these complete based on this application.

Netlify cannot run this stateful Node/SQLite server as a static folder upload. Hosting requires either migrating to the specified managed database/storage and compatible server functions, or a deliberate Node host with persistent storage. The current database/file directory must not be placed on ephemeral function storage.

## Data and backups

`data/estateos.sqlite` contains accounts/business records; `data/files/` contains uploaded bytes. Both are private and excluded from source archives. Back up both together with the server stopped, or use a properly coordinated online database backup. `/api/backup` is an admin-only JSON **record export**, not a complete file/account disaster-recovery backup.

Environment variables: `PORT` (default 4317), `ESTATEOS_DATA_DIR` (default local data folder), `ESTATEOS_HOST` (default 127.0.0.1), `ESTATEOS_SECURE_COOKIES` (1 behind HTTPS), and `ESTATEOS_SETUP_KEY` for nonlocal initialization. Changing bind address does not make this release production-ready.

## Verification

```text
node --check server.mjs
node --check public/live.js
node --test tests/core.test.mjs
```

The integration suite creates disposable real accounts/database/files, checks role and property isolation, unauthorized evidence access, immutable inspection publication, client PDF/photo download, vendor review, arrival readiness, payment balances, duplicate maintenance generation, CSRF protection, suspension and persistence after a server restart. Test data is deleted afterward and never enters the live workspace. Browser interaction and visual QA have not been performed. The optional WebMCP navigation hook is feature-detected but not verified in a supported browser context.

The original user ZIP remains unchanged. Its green/gold visual direction and recovered checklist inform this application; original sample property names are recorded in `SOURCE-NOTES.md`.

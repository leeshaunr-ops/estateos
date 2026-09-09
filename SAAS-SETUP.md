# EstateOS: multi-company pilot setup

This update enables separate company workspaces on the same Render site. Existing records stay with the existing company. No new website or database is needed per company.

## Upload the update

1. Extract `EstateOS-SaaS-update.zip` on your computer.
2. Open the main folder of your GitHub repository.
3. Choose **Add file → Upload files**.
4. Drag the extracted `server.mjs`, `saas.mjs`, `public` folder, and `migrations` folder together into the upload area. Preserve the folders: `live.js` belongs under `public`, and SQL files under `migrations`.
5. Commit to `main` and wait for the existing Node service to finish deploying.
6. Reload EstateOS and log in to your existing administrator account. Do not recreate your company or reset the database.

The package includes the existing migrations so any previously missed migration is applied. Applied migrations are tracked; they do not run again.

## Enable your platform-owner dashboard

1. Open **My profile** and copy the **Account ID** shown in Sign-in & security.
2. In Render, open the existing EstateOS Node service and select **Environment**.
3. Add `ESTATEOS_PLATFORM_OWNER_ID` with that exact account ID as its value.
4. Save and redeploy. Keep this setting only in Render; it does not belong in GitHub.
5. Reload EstateOS. The **Companies** navigation item will appear for your account.

This is a separate privilege from a company's administrator role. Other company administrators cannot grant themselves platform access by editing their email, name, profile, or API payload. The platform dashboard lists company names, statuses, and aggregate account/residence counts; it does not grant cross-company record access or impersonation.

## Add a company

1. Go to **Companies → Invite company**.
2. Enter the company name and first administrator's email.
3. Share the generated link directly with that administrator. No email is sent automatically.
4. The link expires in 48 hours and works once. The administrator sets their own name and password.
5. Their empty company workspace opens at the same site. They can add their own clients, residences, employees, and vendors.

Each login currently belongs to one company. Use a different administrator email for each company; multi-company account switching is not included.

## Create a sales demo company

After `ESTATEOS_PLATFORM_OWNER_ID` is enabled, open **Companies → Create demo company** once. EstateOS creates a separate **EstateOS Demo Company** with sample residences, rooms, an arrival, shopping, an open work order, a boat asset, and an inspection draft. The page displays a demo administrator email and password for sharing with prospects. The demo is isolated from your real company. The button can only be used once; use **Invite company** for additional real companies.

## Company settings and access

- Company administrators can edit their own company name and support email in **Company settings**. The support email is stored, not an email delivery connection.
- Only the platform owner can suspend/reactivate other companies. Suspension revokes sessions and blocks login and pending user invitations. Reactivation preserves all records.
- The platform owner cannot suspend their own workspace.
- Company data exports are now company-scoped. They are records exports, not complete disaster-recovery backups of uploaded files, authentication data, or encryption keys.

## Validation performed

- Existing workflow integration suite passes.
- Separate SQLite and PostgreSQL tests create two companies, verify invitation replay protection, check platform permissions, test company-scoped records and exports, and exercise suspension/reactivation.
- PostgreSQL validation uses the local PostgreSQL-compatible test runtime; live Render/Supabase deployment has not been exercised by these tests.

## Before accepting paying customers

This is a functioning invite-only multi-company pilot release, not a claim of completed commercial launch readiness.

- Connect an email delivery provider, then implement and test verified email changes and forgotten-password recovery.
- Choose subscription prices and connect a payment account. Subscription checkout, billing portal, signed payment webhooks, subscription enforcement, and automatic collection are not implemented. Existing residence invoices are separate from SaaS subscriptions.
- Configure persistent private file storage, scheduled database and file backups, and perform a restore drill. Retain encryption keys securely.
- Review current database TLS settings: supply the trusted database CA and enable verified TLS for production.
- Run a broader tenant-isolation/security review covering all endpoints, role combinations, and concurrent operations, plus load testing and operational monitoring.
- Use a staging deployment with a separate database to test future releases before deploying to paying companies.
- Define customer terms, privacy policy, retention, and support processes for the service.

No paid account, subscription, production deployment, or external invitation email is created by this update.

# Prospects (sales leads, quotes and conversion)

Each home watch company tracks its own prospective clients from the first enquiry to a signed quote, then turns a won prospect into a client family and residence.

## Who sees it
- Company admins always do. Employees only when an admin grants **Prospects access** (Prospects → Settings → Staff access).
- Clients, vendors and field inspectors never see it. Every query is scoped to the company (`org_id`).
- Only admins can convert or delete a prospect, change the quote-form settings or manage staff access.

## Pipeline
- Stages: New, Contacted, Walkthrough booked, Quote sent, Won, Lost (Lost asks for an optional reason, which is added to the notes timeline).
- Desktop shows a board: four open-stage columns, then Won and Lost. Phones (390px) get a row of stage chips and stacked cards.
- Search covers name, email, phone, address and notes. Sort by follow-up date, newest, value or name.
- Each prospect has a name, email, phone, property address, source (website form, referral, phone, other), estimated monthly value, notes timeline, next follow-up date and assigned staff member.

## Follow-ups
- Overdue follow-ups are highlighted in wine. Today's are marked "Due today".
- The sidebar Prospects entry shows the number of overdue follow-ups, and Overview gets a "Prospect follow-ups" attention group.
- An hourly job sends one bell notification per prospect per follow-up date. It goes to the assignee if they still have access, otherwise to the admins.

## Public quote request form
- URL: `/quote/<company-slug>`. The slug comes from the company name (for example `harborline-home-watch`). The admin Settings dialog shows the exact link.
- The page carries the company's logo and name, with only a small "Powered by EstateAegis" footer.
- Embed: `<iframe src="…/quote/<slug>?embed=1">` plus a small script that resizes the frame. Only `?embed=1` responses allow framing (`frame-ancestors *`).
- Spam protection: a hidden honeypot field (a filled one gets a fake success and nothing is stored), plus rate limits of 5 submissions per IP per 10 minutes and 30 per company per hour. The API requires a same-origin JSON POST, and the app's security headers apply.
- New leads land in **New** with source "Website form". Admins get a bell notification and an email through the existing outbox.
- Admins can turn the form off. It is on by default.

## Quotes
- Built from a prospect: plan name, visit frequency, line items (each priced or "Included"), monthly price, notes and a validity period (30 days by default).
- Sending emails the prospect a link to `/quotes/<token>`, a branded public page. Tokens are 256-bit and stored only as hashes. Resending issues a new link and the old one stops working. A withdrawn quote shows as withdrawn.
- Accepting records the typed name, the time, the IP address and the browser. The prospect moves to **Won**, and admins plus the assignee are notified. No payment is collected in v1.

## Convert
- On a Won prospect: one tap creates the client family and the residence with the existing create logic. Plan residence limits apply; a blocked conversion rolls everything back.
- Contact info, address and notes carry over. An internal residence note keeps the notes, the website request and the accepted quote.
- The prospect links to the new family and residence, and its stage stays Won.

## Data
Migration `047_prospects.sql` (additive, SQLite and Postgres): `prospects`, `prospect_notes`, `prospect_quotes`, `prospect_settings`, `prospect_staff`, `prospect_followup_alerts`.

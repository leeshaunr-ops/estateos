# Import from another system (Oct 2026)

Company admins switching to EstateAegis can bring their existing records in from a CSV or Excel file:
**Company → Import data** (also linked from Company settings → More settings and from the new-company setup
checklist on Overview: "Or import them from another system").

## Steps

1. **Upload**: choose what you're importing and pick a `.csv` or `.xlsx` file (max 5 MB, 1,500 rows, 80 columns; the
   first Excel sheet is read; old `.xls` files are refused with a "Save As .xlsx or CSV" message). Each type has a
   downloadable template.
2. **Match columns**: every EstateAegis field gets a dropdown, pre-filled by header auto-matching. Sample values are
   shown under each match, except code columns, which are hidden.
3. **Preview**: row cards showing New / Update / Duplicate / Not imported, with the reason and warnings. A "Needs a
   look" filter and a "When a record already exists: Skip it / Update it" choice. Nothing is saved yet.
4. **Done**: added / updated / skipped counts, Download skipped rows (CSV), Undo this import, and Send invite for
   imported staff.

## Data types (import in this order)

| Type | One row = | Matched as a duplicate by |
| --- | --- | --- |
| Clients and residences | a residence (and its family); a family-only row leaves the address blank | family: email, then name; residence: street (abbreviations normalized) + 5-digit ZIP |
| Contacts | a person on an existing family (by family name or family email) | email or name within the family |
| Vendors | a vendor | email or name |
| Staff and field inspectors | a team member, created **inactive with no password and no email sent** | email in your company; an email with a login elsewhere is refused |
| Past visit history | an earlier visit (date, residence, inspector, type, outcome, notes) | same residence + date + notes |

Rows that repeat earlier rows of the same file are also caught. **Update it** only fills in non-blank values, so it
never erases anything.

- **Time zone**: an IANA name or Eastern/Central/Mountain/Pacific/Alaska/Hawaii in the file; otherwise the US state's
  main zone (CO → Denver, WI → Chicago, …); otherwise the company time zone.
- **ZIP codes** that spreadsheets turned into numbers (`2108`) are padded back (`02108`) with a warning.
- **Access codes** (gate, door/keypad, alarm, lockbox/key location, access notes) are sealed into `property_vault` with
  the same AES-GCM vault and context as Access & codes. They're masked in previews, never stored in the import
  records, and never logged. If the vault key isn't configured, rows with codes are refused with an explanation.
- **Past visits** are stored as read-only history (`imported_visits`) and shown on the residence's Inspections tab to
  admins and staff as "Earlier visits from your previous system". They never become inspections, reports, overdue
  visits or compliance counts, and clients don't see them.
- **Staff**: `Admin` rows are refused (invite admins from Team & access). Staff appear on Team & access as "Imported,
  not invited yet" with **Send invite**. Accepting the invitation activates that same user.

## Header synonyms and known exports

Auto-matching normalizes headers (case, punctuation, `_`) and checks each field's synonyms: first exact matches, then
prefix matches, with each column used once. Besides common spreadsheet headings (Owner, Client Name, Customer,
Property Address, Street, Zip/Postal Code, Gate Code, Alarm Code, Lockbox, Access Notes, Phone, Email, …), it covers
published export formats:

- **Jobber** client import/export sheet: First name, Last name, Company name, Main/Mobile Phone, Email, Street 1/2, City,
  Province or State, Postal Code or Zip Code, Country, Note.
- **Housecall Pro** customers export: First Name, Last Name, Display Name, Mobile Number, Work Number, Email, Company,
  Notes, `Address_1 Street Line 1` / `Line 2` / `City` / `State` / `Postal Code` / `Notes`.

Home-watch-specific tools (for example HomeWatcher or HWIT) don't publish a fixed client export format, so their files
are matched by the generic synonyms. No export format was invented.

## Safety

- `/api/import/*` is admin only (`roles(user,'admin')`); field inspectors are also refused by the inspector allow-list.
  Every query is scoped to `user.organization_id`. Same-origin JSON POSTs (the app's CSRF check).
- The uploaded file is **not stored**: the browser sends it again for preview and import. Limits are enforced on the
  server, including a zip-bomb check on the declared uncompressed size before an `.xlsx` is unzipped
  (`read-excel-file`, MIT).
- Plan limits (`billing.capacity`): new residences never exceed the plan, and an import never adds more staff or field
  inspectors than there are free seats/logins (pending imported people count against the import). The seat is checked
  again when the admin sends each invitation.
- The import runs in one transaction. `import_batches` records the batch, its counts and the skipped line numbers and
  reasons (no values). `import_records` lists every record it **created**.

## Undo (7 days, all or nothing)

Undo removes everything a batch created: residences (with their vault, access and checklist links), families,
contacts, vendors, pending staff and past visits. It's refused, with a list of what's in the way, when:

- a residence has later activity (visits, work orders, requests, files, schedules and so on);
- a family has other residences, invoices or portal logins;
- a vendor has work orders or a login;
- an imported staff member has accepted their invitation; or
- a later import added visits or contacts to these records (undo that import first).

Records that were *updated* keep their new values. The skipped-rows CSV in the Done step contains the original row
values (so they can be fixed and re-imported). It's built in memory for the admin's browser only and never stored.

## Not in v1

Recurring visit schedules (they need assigned staff and intervals), checklist templates, photos/PDF reports, billing
or mailing addresses separate from the residence, multiple sheets per workbook, and reverting updates on Undo.

## Files

`import-core.mjs` (parsing, synonyms, validation, templates), `data-import.mjs` (routes, analysis, import, undo),
`migrations/046_data_import.sql`, `public/data-import.js` / `.css`, and `tests/data-import.test.mjs` (SQLite + PGlite).

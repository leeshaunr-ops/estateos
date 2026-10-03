# Refresh keeps you on the current screen

Refreshing the page, using the browser's Back/Forward buttons, or reopening the installed app now returns you to the screen you were on,
instead of sending you back to the Overview.

## What you'll notice
- The address bar shows where you are, for example `…/#/residence/<id>/inspections` or `…/#/inspection/<id>`. You can bookmark it or
  refresh it.
- **Refresh** keeps you on the same residence and tab, inspection, checklist template editor, family, arrival, message thread, asset
  inspection record, or list page.
- **Back / Forward** in the browser, and the **Back** button on phones, step through the screens you opened.
- **Installed app (iPhone/Android):** reopening it from the home-screen icon goes back to the last screen you had open on that phone in
  the last 12 hours, for the same account only.
- **Offline:** refreshing with no signal keeps an inspection that's saved on the phone open. Any other screen shows the saved inspections,
  as before.
- **Signed out** (for example the session timed out) and refreshed: you're asked to sign in, then taken back to the same screen.

## What isn't restored
- **Dialogs and half-filled forms** (edit dialogs, new asset inspection, etc.). A refresh lands on the page that contains them. Inspection
  answers are saved continuously, as before.
- **Records that no longer exist, or that you can't access** (deleted, archived, another account's link). You land on the Overview
  (offline: the saved inspections) with a short notice.
- **Search text and list filters** other than the Upcoming / Submitted inspection lists and Ready arrivals.

## Existing links still work
- The `/login?inspection=<id>` links in fail-alert emails still open that inspection after sign-in, and take priority.
- The installed app still starts at `/login?source=pwa`.
- Invitation, password reset and client portal (`/client/<name>`) links are unchanged.

## Privacy
Signing out removes the screen from the address bar and forgets the remembered screen on that device. Another account never
inherits it.

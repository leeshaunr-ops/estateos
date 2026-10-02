# Offline inspections (installable app)

Staff (admins and employees) can do a whole inspection with no signal: walk the checklist, write notes, take photos, and mark it
complete. Everything is saved on the phone first and sent to EstateAegis automatically, exactly once, when the phone has signal again.

## For field techs
1. **Install the app (once).** Open EstateAegis on your phone and sign in.
   - Android/Chrome: tap **Install app** on the banner, or in **My profile → Install app**.
   - iPhone/iPad: in Safari tap **Share → Add to Home Screen**.
   It opens full-screen like a normal app.
2. **Before you leave signal**, open today's visits once. Visits due today or tomorrow, and any visit you open, are saved to the phone
   automatically. You'll see **✓ Available offline · updated 7:02 PM** on the visit. To save more residences, use **Make available offline**
   on the inspections list, a residence's Inspections tab, or the route planner.
3. **At the property, signal or not:**
   - Answer items and type notes. They save on the phone as you go, and the bar at the top says **Offline · N changes waiting**.
   - **Add photos**: take or choose photos. They're shrunk to 2048 px and stored on the phone, marked **Waiting to upload**.
   - You can start a new visit offline (**Start inspection**) at any residence saved on the phone.
   - You can close the app or restart the phone. Your work is still there when you open it again, even in airplane mode.
4. **Mark complete.** The app checks that every item has a result, every "Not applicable" has a note, and there's a summary. Offline, the
   visit shows **Will submit when online**. It can't be edited after this.
5. **Back in signal**, just open the app. It syncs on its own (within a few seconds of reconnecting) and the bar turns green:
   **Online · all saved**. On Android it can also finish syncing in the background after you close the app.
   - Tap the status bar to open **Sync** and see each waiting change. **Retry all now** forces a try.
   - **Needs attention** means something needs you: usually someone in the office edited the same item. Tap **Resolve**, pick
     **Your version** or **Server version** for each item, then **Save choices**. Changes to different items are merged on their own.
6. **Signing out** deletes everything saved on the phone. If anything hasn't synced yet, you're warned first. Sign out only when you have
   signal and everything is synced.

## For admins
- Completed field visits arrive as **Submitted** (Overview tile "Submitted for review"). Open one and choose **Publish report**, or
  **Return to draft**. Families and vendors never see submitted visits.
- When you mark a visit complete yourself you can tick **Publish automatically when synced**.
- Published PDFs look the same as before, except each photo now shows when it was taken, e.g. "Taken Oct 2, 2026, 10:05 AM EDT", in the
  residence's time zone.
- Conflict resolutions show in the audit history as `inspection.conflict_resolved`.

## What stays on the phone
Only what's needed for the visits: residence name/address/rooms, the checklist, the last published visit (for "Last visit:" hints),
your drafts (including internal notes) and photos waiting to upload. Access codes, documents, billing, other users and other companies'
data are never stored on the phone or in the app cache. Each user has their own on-device database. **My profile → Offline data** shows
how much is stored and has **Clear offline data**.

## Limits to know
- iPhone has no background sync. It syncs when you open the app or come back to it.
- Browsers can evict stored data when the phone runs very low on space. The app asks for persistent storage to prevent this.
- Photo time comes from the photo file's timestamp on the phone, not the camera's EXIF data.
- Publishing needs signal (admins only). Other pages besides inspections need signal.
- If your session expires while offline, your work stays on the phone. Sign in again (same account) to finish syncing.

## Technical reference
See `docs/plans/offline-mobile-inspections.md` (design, deviations from the spec, tests). Files: `public/sw.js`,
`public/manifest.webmanifest`, `public/offline-core.js` (outbox, merge, sync engine), `public/offline-store.js` (IndexedDB),
`public/inspection-drafts.js` (UI integration), `offline-inspections.mjs` (idempotency + snapshot API), `migrations/032_offline_inspections.sql`.

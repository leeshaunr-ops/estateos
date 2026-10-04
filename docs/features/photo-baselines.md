# Repeat-angle photo baselines (photo spots)

Home watch reports are most useful when this week's photo of the sink cabinet can be held up against last month's. Photo spots let a company name the fixed angles it photographs at a residence. Each spot has a baseline photo, and on every visit the camera shows that baseline as a see-through overlay so the new photo lines up with it. Reports, the family portal, the inspection PDF and the storm report then show the two side by side.

## What it does
- **Photo spots** (Residence › Home records › Photo spots): name (for example *Guest bath sink cabinet*), location, an optional link to a checklist item, shooting notes for staff (*Doors open, kneel at the tile seam*), and a baseline photo. A residence can have up to 60 active spots, listed by name.
- **Taking the photo on a visit**: a draft visit shows a *Photo spots* panel listing each spot with *Take photo* or *Retake* and a count of how many are done. The camera dialog:
  - opens the live rear camera (`getUserMedia`) with the baseline over it at 50% opacity, with a slider to change the opacity;
  - falls back to the phone's camera app (`<input type=file capture=environment>`) when the live camera is not available or permission is off, and shows the overlay on the preview so the photo can be retaken;
  - shows a preview with *Retake* and *Save photo*.
- **Offline**: visit photos go through the existing offline outbox. The bytes are stored on the device first and the queued upload carries the spot ID, so a photo taken without signal is still linked to its spot when it syncs. Spot data and baseline images are cached on the device, so the overlay works offline too. A replayed upload (same `clientOpId`) does not create a second photo.
- **Baselines**: the first photo of a spot that has no baseline becomes the baseline. *Take a new baseline* (from the spot's More menu, needs a connection) and *Set as baseline* (from a timeline photo or a report comparison) replace it. Each photo records the baseline that was in effect when it was taken, so older comparisons do not change after a new baseline is set.
- **Timeline**: *Timeline* on a spot card opens a dated grid of every photo of that spot, newest first, with the baseline marked. Staff get *Open visit* and *Set as baseline* on each photo.
- **Comparisons**:
  - the visit report on screen (staff and family) shows *Photo comparisons*: baseline on the left and this visit on the right, with dates in the residence's time zone;
  - the inspection PDF (download and email) gets a *Photo comparisons* section before *Notes to the client*;
  - the storm report pairs the pre-storm and post-storm photos of the same spot first (*Same photo spot: Roofline from the drive*), then pairs the remaining photos the usual way.
- **Documents stay clean**: a baseline taken outside a visit is not listed in Documents. It is served through `/api/photo-spots/image/:fileId`.
- **Audit**: spot created, edited, archived and baseline changed.

## Permissions
| | Admin | Staff (Residence Manager or assigned) | Family | Vendor |
|---|---|---|---|---|
| See spots, timeline and comparisons | yes | yes, their residences | yes: the baselines and photos from published visits, without staff notes | no |
| Add and edit spots, take photos, set a new baseline | yes | yes | no | no |
| Archive a spot | yes | no | no | no |

## API
- `POST /api/photo-spots` `{propertyId, name, location?, checklistKey?, checklistLabel?, notes?}` → 201
- `POST /api/photo-spots/:id` `{..., version}` → 409 if the spot changed in the meantime
- `POST /api/photo-spots/:id/archive` (admins)
- `POST /api/photo-spots/:id/baseline` `{fileId}`: a photo of this spot, or any JPEG visit photo at the residence. Returns 422 for another spot's photo or a work-order photo, and `unchanged: true` if the photo is already the baseline.
- `POST /api/files` takes an optional `spotId` (JPEG only). With `inspectionId` it is a visit photo; without one it is a new baseline.
- `GET /api/photo-spots/image/:fileId`: families only get baselines and photos from published visits.
- `/api/data` adds `photoSpots: {canEdit, canArchive, limit, spots, shots}`.

## Data
Migration `039_photo_spots.sql`:
- `photo_spots`: the spot, its current baseline, and the version used for edit conflicts.
- `photo_spot_shots`: one row per photo, with the spot, the visit, `kind` (visit or baseline) and the baseline in effect when it was taken.

Photos of a deleted draft drop out because shots are joined to `files`.

## Known limits
- Replacing a baseline needs a connection; visit photos work offline.
- The overlay uses `object-fit: contain`, so a baseline taken at a different aspect ratio shows letterboxed rather than stretched.
- There is no automatic image alignment or change detection. The overlay helps the person line up the shot by eye.

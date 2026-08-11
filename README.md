# Handpicked Operations Management

Mobile + desktop web app for production coordinators, installation coordinators and management.
Three modules over the `handpicked-curtains` Supabase project (`jrevqijbzzwdcwxcnwfa`).

| | |
|---|---|
| Stack | Hand-written HTML/CSS/vanilla JS as native ES modules. **No npm, no bundler, no framework.** |
| Hosting (LIVE) | **https://handpickedfurniture.github.io/handpicked-ops-app/** — GitHub Pages, repo `HandpickedFurniture/handpicked-ops-app`. Update = commit + push to `main`. |
| Local preview | `python -m http.server 8124 --directory ops-app` → http://localhost:8124 (also `.claude/launch.json`) |
| Why Pages | Cloud Run is blocked by the GCP org policy (403 on allUsers) and Supabase cannot serve HTML; Pages also gives HTTPS, which the camera and microphone require |
| Auth | Supabase Auth, email + password, **one account per person** |
| Languages | English / Hindi / Bengali |
| Theme | Light only — `Context_overview.docx` says avoid dark mode |

> **ES modules do not work over `file://`.** Open the preview URL; double-clicking `index.html`
> gives a blank page.

### Deploying

Pages caches assets for 10 minutes, and `index.html` carries an **import map** that pins every
module to a versioned URL. Bump the version in all three places or the deploy half-lands:

| Where | Count |
|---|---|
| `index.html` — 24 import-map entries, the CSS `<link>`, and the `<script type="module" src>` | 26 |
| `BUILD` in `js/config.js` — the footer label, and how you confirm what is live | 1 |

```bash
sed -i 's/2026-08-11\.2/<new-version>/g' index.html js/config.js
grep -o "2026-[0-9.-]*" index.html | sort | uniq -c   # must be one line, count 26
```

Then `git commit && git push origin main`; Pages rebuilds in ~45s. Confirm the footer reads the new
build. A plain reload can still serve the cached `index.html` — hard-refresh, or open the site with a
throwaway document query (`…/?x=1`), which the hash router ignores.

**Why the import map.** A `?v=` on `app.js` alone versioned exactly one file: every
`import "./ui.js"` inside it resolved to an unversioned URL and came straight back out of cache, so
a redeploy served new HTML around old modules. The map fixes that for imports — and the `?v=` on the
`<script src>` is still needed, because a map governs module *specifiers*, not a script element's
`src`. **When you add or rename a file in `js/`, add it to the map** or it will silently never
update.

---

## Modules

**1. Production tracking** (`#/production`) — one row per order with installation date, city, PO
version, every fabric code with its meterage, and a count for each special requirement (roller
blinds, baton sticks, pelmet boxes, roman blinds, motors, tie backs, scaffolding…). Expand a row for
the drawer.

**2. Order status** (`#/status`) — ready, team assigned, order status, **multiple visits** each with
their own outcome and team, internal + Slack comments, and chargeable extras.

**3. Management dashboard** (`#/dashboard`, `#/eod`) — date-bucket tiles, every order-status field as
a filter, billing totals, and an end-of-day report at team **and** overall level.

**4. Transfer of materials** (`#/transfer`) — the order manager marks each order **in progress /
ready / returned / partially returned / cancelled / issue**, with a location code and photos.
Optional item lines record what went out and what came back; posting them writes to the inventory
ledger and **derives** the status from what actually returned. Distinct from the dispatch stages in
production tracking: those are outwork stitching, this is materials going to site.

**5. Inventory** (`#/inventory`) — items, stock on hand, movements, reorder alerts, location codes
and photos. Stock is the **sum of the movement ledger**, never a stored number, so no figure can
drift out of step with its own history.

**6. Photo audit** (`#/audit`) — every photo ever taken, filterable by order, what it was attached
to, date range, uploader and location. Shows the checksum, which store holds the bytes, and the view
count. Removed photos are still listed with who removed them and why.

## The 14 stages, and where each one lives

The stages sit at three different grains, because they are about three different things.

| Stages | Grain | Table |
|---|---|---|
| 1 Ordered · 2 Received · 3 Out of stock · 4 Fabric quality check | order × fabric | `receiving_expectations` (`status`, plus an independent `qc_result` axis) |
| 5 Cutting · 6 Hemming · 7 Ironing · 8 Marking & measurement · 9 Taping · 10 Completed–folded & packed | order × window × layer | `preparation_events` |
| 11–14 Sent to Farooq / Jamal / Shahzad / Other, each **planned → sent → received back** | order | `order_dispatch` |

QC is deliberately a separate axis from status: a fabric can be both `received` and quality-checked.

Every screen has bulk apply — the busiest order has 33 window×layer units, which would be 198 taps
across six stages otherwise.

## Adjustments are a billing artifact

An adjustment is **work done over and above the purchase order**, and it is chargeable to the client.
It lands on `accounting_alerts` — the table the ingestion agent already feeds automatically and that
`agent.py:399` describes as the one "the invoicing workflow is built on top of later".

- Amounts pre-fill from `adjustment_rate_card` via `fn_ops_rate_for`, **never hardcoded in JS**.
  The card is band-aware, so removing 2 curtains prices at AED 0 and 4 at AED 100.
- **A revisit is billable**, so recording visit 2+ auto-proposes an `additional_visit` charge at the
  current rate. It arrives as `new` for a human to confirm or drop — never billed silently.
- `agreed_amount_aed` is a **snapshot**. `product_catalog.price` feeds `v_invoice_po_lines` live with
  no effective-date join, so without the snapshot a later rate change would restate historical
  adjustments.
- A reason is mandatory, enforced in the UI, because `invoice_lines.adjustment_needs_comment` will
  reject a blank one at invoicing time.
- `fn_ops_build_invoice(order_id)` produces a **draft** invoice: `as_per_po` lines from
  `v_invoice_po_lines` plus `adjustment` lines. Re-running rebuilds in place — it never creates a
  second invoice or doubles the lines — and it refuses to touch an invoice that is no longer `draft`.
  Issuing, numbering, VAT and PDF are out of scope.

## Photo evidence

A camera button sits on every status change: each receiving row, production, each dispatch
contractor, order status, each visit, each adjustment, transfers and inventory movements.
**Photos are always optional and upload out of band** — a slow or failed upload never blocks a
coordinator from marking work done.

**Storage is pluggable.** Bytes go to whichever backend is live:

| Backend | When | Setup |
|---|---|---|
| `supabase` | the default, working now | none — private `ops-photos` bucket, no public URL, reads need a 10-minute signed URL |
| `gcs` | once configured | private Google Cloud Storage bucket; the `photo-signed-url` Edge Function mints V4 signed PUT/GET so the browser talks to Google directly and never holds a GCP credential |

The app **probes once a day** and switches on its own. `storage_backend` is recorded per photo, so
photos already in Supabase keep resolving after the switch — no migration, no broken links.

> While GCS is unconfigured the Edge Function is not deployed, so you will see **one benign console
> error mentioning `photo-signed-url` per device per day**. Photos still upload, to Supabase.

Setup commands for the Google Cloud path are in the header of
[`supabase/functions/photo-signed-url/index.ts`](../supabase/functions/photo-signed-url/index.ts).
`gcloud` needs an interactive `gcloud auth login` on your own machine.

### What makes it auditable

- **Nothing is ever hard-deleted.** `fn_ops_delete_photo` soft-deletes: the row, the stored object
  and the stated reason all survive. `DELETE` is revoked from `authenticated` on `order_photos`, and
  the storage policies grant insert and select only — verified returning **403**. A photo that can be
  quietly erased proves nothing.
- **A reason is required** to remove one, and is shown in the audit view alongside who removed it.
- **sha256 captured in the browser at upload**, so the stored bytes can be shown to be the bytes that
  were taken.
- **Every view is logged** to `photo_access_log` — a signed URL is minted at the moment someone
  actually looks, so the view count is real.
- `fn_audit` writes every insert and update to `audit_log` as well.

## Voice input

Feature-detected, never UA-sniffed:

- **Web Speech API** on Android Chrome and desktop Chrome/Edge — free, on-device, streams interim text.
- **MediaRecorder → the `transcribe` Edge Function → Gemini** on iOS Safari, which has no
  `webkitSpeechRecognition` at all.

Both record `input_method` and `lang` on the resulting `order_comments` row.
`getUserMedia` needs a secure context, so **path B must be tested on the deployed HTTPS URL** — a LAN
IP will not do, though `http://localhost:8124` counts as secure.

## Files

```
index.html              shell only
css/app.css             all styling, light theme
js/config.js            Supabase keys, and every canonical vocabulary the app writes
js/i18n.js              en / hi / bn labels
js/api.js               auth-aware fetch, single-flight refresh, offline write queue
js/auth.js              sign-in screen
js/ui.js                DOM + formatting helpers
js/filters.js           the shared filter bar
js/voice.js             speech to text
js/photos.js            pluggable photo upload, signed-URL viewing, location picker
js/drawer.js            per-order drawer (stages 1-14, alerts, comments, emails)
js/mod-production.js    module 1
js/mod-status.js        module 2 + adjustments
js/mod-dashboard.js     module 3 + end-of-day
js/mod-transfer.js      module 4 - transfer of materials
js/mod-inventory.js     module 5 - inventory
js/mod-audit.js         module 6 - photo audit
js/app.js               hash router
check_i18n.py           key parity across the three languages
check_values.py         every written value still matches its CHECK constraint
```

Run both checkers after touching strings or vocabularies:

```bash
python check_i18n.py && python check_values.py
```

## Traps worth knowing

- **A wrong bearer token returns HTTP 200 with `[]`, never 401.** Every table is RLS-locked to
  `authenticated` and `anon` has no policy at all, so an unauthenticated read looks exactly like an
  empty result. `api()` refuses to run without an access token, and the roster reports "no rows with
  no filters" as an auth error rather than an empty list. This already burned `tools/validate.py`.
- **Translate the label, keep the value English.** `data-*` attributes and select `value`s carry
  canonical snake_case. Translate one and its CHECK constraint rejects the write. `check_values.py`
  guards this.
- **Never write to `order_lines_final`.** `fn_rebuild_order` recomputes it wholesale on every PO
  revision, `production_comment` and `optional_comment` included. Captured text goes to
  `order_comments` / `receiving_expectations.ops_note` / `preparation_events.note`.
- **`installation_schedule` is read-only here, and currently unreliable.** It last synced 29 Jul 2026
  and `_row_key()` in `schedule_sync.py` includes `source_row_no`, so 90 of 109 orders have duplicate
  rows. Every read goes through `DISTINCT ON (order_id) … ORDER BY synced_at DESC`, and the app shows
  a staleness banner past 24 h.
- **Supabase rotates refresh tokens.** Concurrent refreshes invalidate each other, so `api.js` uses a
  single-flight promise. Do not remove it.
- **`order_visits.visit_no` is capped at 10** and `v_order_status_wide` pivots exactly 1..10. The UI
  blocks visit 11 with a message; raising the cap would silently drop visits from that view.

## Setup still required

1. **Create the user accounts** in the Supabase dashboard (Authentication → Users) and **disable
   public sign-up** (Authentication → Providers → Email → "Enable sign ups" off). There is no signup
   screen by design.
2. **For iPhone voice input**, deploy the Edge Function with its own Gemini key — the ingestion
   agent's key lives in GCP Secret Manager, which Supabase cannot read:
   ```bash
   supabase secrets set GEMINI_API_KEY=<key>
   supabase functions deploy transcribe
   ```
   Android and desktop work without this.

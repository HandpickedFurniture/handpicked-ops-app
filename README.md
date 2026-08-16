# Handpicked Operations Management

Mobile + desktop web app for production coordinators, installation coordinators, the workshop floor
and management, over the `handpicked-curtains` Supabase project (`jrevqijbzzwdcwxcnwfa`).

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

| Where | How many |
|---|---|
| `index.html` — one import-map entry per file in `js/`, plus the CSS `<link>` and the `<script type="module" src>` | files in `js/` + 2 |
| `BUILD` in `js/config.js` — the footer label, and how you confirm what is live | 1 |

```bash
sed -i 's/<old-version>/<new-version>/g' index.html js/config.js
grep -o "2026-[0-9.-]*" index.html | sort | uniq -c    # must be ONE line
diff <(grep -oE '"\./js/[A-Za-z0-9._-]+\.js"' index.html | tr -d '"' | sed 's|\./js/||' | sort -u) \
     <(ls js/ | sort)                                   # must print nothing
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

## The ribbon, and everything off it

Seven tabs, in the order the day runs: **Home · Production · Preparation · Installation · Inventory ·
PO · Chotu**. More than seven and a phone scrolls the strip sideways, which is how the last tabs stop
being used at all.

Everything else is a real route reached from **Home**, which is the full index: Schedule, Transfers,
Dashboard, Reports, End of day, Photo audit and Roles. The old `Insights` container is gone — it
bundled five unrelated read-only screens behind one tab and buried the line-by-line PO review, the
one screen coordinators work *through*, three clicks deep. That review is the **PO** tab now.

Old links still work. `#/insights…` and `#/production?sec=prep` redirect to wherever their screen
moved to, carrying their filters (see `redirectFor` in `js/app.js`), because those links are sitting
in people's WhatsApp.

Signing in lands on a **launcher** (`#/menu`) — eight big targets, once per sign-in only. A reload or
a shared link goes straight to the screen it names.

## Modules

**1. Production tracking** (`#/production`) — one row per order with installation date, city, PO
version, every fabric code with its meterage, and a count for each special requirement (roller
blinds, baton sticks, pelmet boxes, roman blinds, motors, tie backs, scaffolding…). Expand a row for
the drawer. Every column title sorts, ascending then descending — including the three built out of
several columns each (Fabrics by code, Special requirements by total, Tailors by ladder position).
The sort runs in the browser over the rows already fetched, so it costs no round trip and covers the
whole filtered set rather than a page.

**2. Order status** (`#/status`) — ready, team assigned, order status, **multiple visits** each with
their own outcome and team, internal + Slack comments, and chargeable extras.

**3. Management dashboard** (`#/dashboard`, `#/eod`) — date-bucket tiles, every order-status field as
a filter, billing totals, and an end-of-day report at team **and** overall level.

**4. Transfer of materials** (`#/transfer`) — two sub-tabs.

*Transfers* — the order manager marks each order **in progress / ready / returned / partially
returned / cancelled / issue**, with a location code and photos. Optional item lines record what went
out and what came back; posting them writes to the inventory ledger and **derives** the status from
what actually returned. Distinct from the dispatch stages in production tracking: those are outwork
stitching, this is materials going to site.

*Handovers* — who physically gave what to whom (`handover` / `handover_line`), of a whole **order**
or of loose **inventory** with no order at all. That second case is why it is a sibling table rather
than a column: `material_transfers.order_id` is `NOT NULL`, and an invented order id is how a ledger
starts lying. **Acknowledging is the load-bearing step** — for an inventory handover it is what posts
the lines through `fn_ops_inventory_move`, because "I put it in the van" and "I have it" are
different claims and stock should follow the second one.

**5. Inventory** (`#/inventory`) — items, stock on hand, movements, reorder alerts, location codes
and photos. Stock is the **sum of the movement ledger**, never a stored number, so no figure can
drift out of step with its own history.

**6. Photo audit** (`#/audit`) — every photo ever taken, filterable by order, what it was attached
to, date range, uploader and location. Shows the checksum, which store holds the bytes, and the view
count. Removed photos are still listed with who removed them and why.

**7. Preparation** (`#/prep`) — the workshop's screen. Three panels per order and nothing else:

- **Stacking location** — floor / rack / shelf / zone, written per **window × layer** through
  `fn_ops_apply_prep`. Tick some windows, save a place, tick the rest, save another: that is how one
  order legitimately sits in two racks. Read back through `v_ops_prep_locations`, which takes the
  latest stacking event per unit so re-stacking reports where it is *now*.
- **Special requirements** — the order's non-fabric `receiving_expectations` (motors, remotes, roller
  blinds, cassettes, pull-cord tracks), ticked as they arrive. The **same** `fn_ops_set_receiving`
  the order drawer's Materials tab calls, so the two screens can never disagree.
- **Railing** — the cut list, ticked line by line into `rail_prep_mark` via `fn_ops_set_rail_mark`.
  Keyed on the **PO line**, not the window: one window routinely carries a rail line plus a tie-back
  line plus a "check special requirements" line (3,730 rows over 2,255 window pairs), and keying on
  the window would let one tick claim three different things.

**8. PO review** (`#/po`) — every PO line, with the 21 order-form columns coordinators read from, each
markable and each logged with who marked it. Filterable by marks, procurement requirement and **PO
version** — 45 of 712 orders have been revised, and a revised PO is the one worth re-reading, so
*Revised* is a filter value of its own beside the version numbers.

**9. Chotu** (`#/chotu`) — see below.

## The offline write queue

Every write goes through `submit()` in `js/api.js` into a localStorage queue, because installers are
in vans and lifts. It is safe to replay: each RPC is set-state rather than incremental, and
`fn_ops_apply_prep` derives a deterministic `client_op_id` per unit so a replayed bulk apply collides
row-for-row and does nothing.

**`await submit(...)` genuinely waits.** It used to `return flush()`, and `flush()` returned
`undefined` the moment another flush was already running — so with two writes in quick succession the
second resolved instantly, before its request had gone. Every caller then read `queueDepth()` to
decide what to say, which produced two visible symptoms while perfectly online:

- the toast said **"Saved – will sync when back online"**, because the item really was still queued
  at the instant it looked; and
- the caller's `reload()` re-read the server before the write landed, so the row came back with its
  old value and **the tick appeared to bounce off**.

Nothing was usually lost — the queue drained a second later — but it looked exactly like lost input,
and the faster somebody ticked down a list the more often it happened. `flush()` now returns its
in-flight promise, so everyone waits on the same run; the loop re-reads the queue each pass, so an
item appended by a caller that joined a run in progress is still picked up by it.

**Failures are told apart, not lumped together.** They look identical from outside — a refusal thrown
before the request leaves the browser carries no HTTP status, and neither does a dead lift:

| Failure | Behaviour |
|---|---|
| `permanent` (a read-only account, marked at the throw site) | parked immediately — retrying cannot help |
| 4xx | parked — the server understood and said no |
| 5xx | retried, then parked after `MAX_TRIES`, so a broken write cannot hold the queue hostage |
| no status (fetch itself rejected — no signal) | retried indefinitely, **not** counted; being offline is not the write's fault |

**A parked write is the one case where somebody's input is genuinely gone unless a human acts**, so
it announces itself: a toast when it happens, and a red badge in the header that is a *button*,
opening a tray listing what failed and why, with **Try again** and **Discard**. Previously these
were dropped into localStorage behind a tooltip nobody opens — and the badge was only drawn when the
queue happened to be empty, which is backwards, since writes pile up behind a stuck one.

## Roles

| Role | Writes | Sees |
|---|---|---|
| `ops` | everything | everything |
| `viewer` | **nothing** | every module |
| `prod_viewer` | **nothing** | Production only — no Home, no launcher |

**Only `ops` can write, and the database is what enforces it.** `fn_is_viewer()` tests
`role <> 'ops'`, so all 42 tables' write policies refuse anything else without a single policy
change — and a fourth role added later arrives read-only rather than arriving with write access
everywhere until somebody notices. `isViewer()` in `js/api.js` makes the same test, so the screen and
the database can never disagree about who is read-only. An **unknown** role (lookup failed, or no
`app_roles` row) resolves to `ops` on both sides; that is the one part that is not default-deny, and
it is deliberate — a failed request in a lift must not lock a coordinator out of their own job.

Which **tabs** a role sees is presentation (`ROLE_ROUTES` in `js/app.js`) and nothing more. Verified
by bypassing the app entirely — raw PostgREST calls with a `prod_viewer`'s own bearer token:

| Attempt | Result |
|---|---|
| `PATCH app_roles` to promote self to `ops` | `[]` — **zero rows changed** |
| `PATCH receiving_expectations` to tick a fabric received | `[]` — **zero rows changed** |
| `POST order_comments` | **403, `42501` row-level security violation** |
| `GET` the same rows | works — this role is meant to read |

Note the asymmetry: a blocked UPDATE matches zero rows and returns 200/204, while a blocked INSERT
raises 42501. Both mean nothing was written, but a bare 204 from PostgREST is **not** evidence that
anything changed — ask for `Prefer: return=representation` before concluding it did.

Adding a person: create the account in the Supabase dashboard (Authentication → Users), then set
their role on the Roles screen. There is no signup screen by design.

## Chotu, and why you can trust what it records

One big circle. Tap it, say what happened in English, Hindi or Bengali, and either get an answer read
back or get a filled-in form to check. It exists because the people who know things first — the
tailor who just unwrapped a roll, the driver who just took two motors — are the people least able to
stop and type.

Speech in reuses `js/voice.js` unchanged (on-device Web Speech API on Android and desktop Chrome,
record-then-`transcribe` on iPhone, feature-detected). Speech out is `window.speechSynthesis` — no
key, and it already has Hindi and Bengali voices on these phones. **Answers are always on screen as
well as spoken**; a workshop is loud and a spoken-only answer is no answer.

**The model never writes anything.** Three guards, in order:

1. **Grounded.** `fn_chotu_context` runs first, *as the caller*, and returns the real candidate rows —
   this order's fabrics with their receiving ids, its panels, its rails, the stock list, the crew.
   The model picks from those; it has no database access of its own.
2. **Closed.** `intent` must be one of ten or the reply is downgraded to a plain answer. Every id in
   `fields` is checked against the facts and **removed** if it is not there, in
   `supabase/functions/chotu/index.ts`.
3. **Confirmed.** What arrives in the browser is a *proposal*, drawn as a form. The **Commit button**
   is what calls the RPC — the same `submit()` and the same replay-safe functions every other screen
   uses. Anything the model could not fill comes back in `need[]` and blocks the button.

So the worst a misheard sentence can do is put a wrong-looking card on screen, which somebody
declines. Speech is fast and unreliable, so the voice carries the speed and the button carries the
reliability. The **speaker's name** is asked before the first capture and rides on every write, since
"who told us this" is the first question anybody asks about a record that turns out to be wrong.

Verified against the live database: asking *"what fabrics are still pending for order 67813"* returns
the three real codes and meterages; saying *"fabric zz9999-plural-z-alpha arrived"* is refused, names
the three real options, and leaves Commit disabled.

Adding an intent means adding it to `INTENTS`, to the `validate()` switch, and to `commit()` in
`js/mod-chotu.js`. If it does not map to an RPC that already exists, it is the wrong shape.

### The shared filter bar

Production, Preparation, Installation, Transfers, the PO review and the dashboard all mount the same
bar (`js/filters.js`).
Every value filter is a **list of checkboxes**, so it takes any number of values at once: "Dubai and
Abu Dhabi", "today and tomorrow", "sent and received back". Values within a field are OR-ed and the
fields are AND-ed. Scalar columns become PostgREST `in.(…)`, array columns become `ov.{…}` (overlap,
ie "holds any of these"), and ticking *Unknown city* alongside a real one becomes a single
`or=(city.is.null,city.in.(…))` — as two predicates it would AND itself down to nothing.

Long lists get their own search box and draw at most 150 rows at a time: window ref has ~2,500
distinct values and fabric 1 has ~455. Whatever is already ticked is always drawn, however far the
search has narrowed past it.

**The open panel is `position: fixed`, deliberately.** `.filterbar` carries `overflow: hidden` (it is
what rounds the orange strip's corners), and an absolutely-positioned panel inside it was **clipped
by the card** — the fields drawn last, Marks and Procurement requirement, open lowest and were cut
off entirely. No amount of height fixed that, because the clip was upstream of the height. Out of
flow, no ancestor can clip it; `place()` in `js/filters.js` writes both offsets against the viewport,
clamps them to the screen, and flips the panel above the button when the list would not fit below.
The cost is that a fixed panel does not follow the page, so any scroll closes it.

Multi-values ride in the hash as a **repeated key** (`?city=Dubai&city=Sharjah`) rather than a joined
string — three option values contain a comma, and `URLSearchParams` gets the escaping right where a
separator of our own would need rules nobody would remember. One-value links written before any of
this still read back correctly, so a `#/production?bucket=overdue` sitting in somebody's WhatsApp
keeps working.

## The 14 stages, and where each one lives

The stages sit at three different grains, because they are about three different things.

| Stages | Grain | Table |
|---|---|---|
| 1 Ordered · 2 Received · 3 Out of stock · 4 Fabric quality check | order × fabric | `receiving_expectations` (`status`, plus an independent `qc_result` axis) |
| 5 Cutting · 6 Hemming · 7 Ironing · 8 Marking & measurement · 9 Taping · 10 Completed–folded & packed | order × window × layer | `preparation_events` |
| 11–14 Sent to Farooq / Jamal / Shahzad / Other, each **planned → sent → received back → quality check success → paid** | order | `order_dispatch` |

`paid` is a rung above `qc_passed`, not a state beside it: settling with the last tailor closes
production exactly as passing the check does. `order_dispatch` carries a payment axis of its own
(`payment_status` / `paid_at`, read by the Dragon Mart report) and `fn_ops_set_dispatch` keeps the
two in step in both directions — moving a row back off `paid` returns it to `unpaid`.

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
[`supabase/functions/photo-signed-url/index.ts`](supabase/functions/photo-signed-url/index.ts).
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
2. **`GEMINI_API_KEY` is already set** on this project, so iPhone voice input and Chotu both work.
   If it ever has to be replaced, the ingestion agent's key lives in GCP Secret Manager where
   Supabase cannot read it, so it needs setting here in its own right:
   ```bash
   supabase secrets set GEMINI_API_KEY=<key>
   ```

## Edge Functions

The three functions in `supabase/functions/` live in **this** repo because all three exist only to
serve this app — `js/voice.js` calls `transcribe`, `js/mod-chotu.js` calls `chotu`, `js/photos.js`
calls `photo-signed-url`. Deploy from the repo root, which is where the `supabase/` directory sits:

```bash
supabase functions deploy chotu --project-ref jrevqijbzzwdcwxcnwfa
```

All three run with `verify_jwt = true` and pass the caller's own bearer token through to PostgREST,
so a function can never become a way around RLS.

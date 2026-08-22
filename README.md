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

Everything else is a real route reached from **Home**, which is the full index: Finance, Schedule,
Transfers, Dashboard, Reports, End of day, Photo audit and Roles. The old `Insights` container is gone — it
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

**2. Installation** (`#/status`) — ready, team assigned, order status, **multiple visits**, the
Kurtains comment, and chargeable extras. The expanded panel is readiness, the order's own fields,
its visits, its extra work, and one button. It no longer carries links out to Transfers, Stock and
Photo audit: those were three ways to leave the screen somebody had just opened to record what
happened on site, and all three are one tap from Home.

**The status is a coloured pill beside the dropdown**, so the panel and the list say the same thing
the same way — a select only shows its value to someone who reads it.

**Alteration is counts, not a yes/no**, and the two kinds live where each is used. The panel carries
*Planned* — what the PO already covers, a property of the order as sold. *Adjustment* — what arose on
site — is in the charge sheet, next to the money it produces, because having it in both places meant
the same numbers were entered twice, a day apart, by the same person.

Each is entered as **windows by layer count** and the curtain total is derived beside it, because
**a 2 layer window is two curtains** and that doubling is the single most expensive mistake in this
business. `order_status.alteration` stays and is now **derived** from the four counts
(`fn_ops_save_visit` sets it when any count key is sent): it is read by the shared filter bar, the
dashboard tile, column and CSV, the production flag chips, Chotu's `order_edit` and the schedule
tags, and unpicking it from all of those is a change of its own. A caller that sends no count keys
keeps the explicit boolean it has always sent — which is what keeps Chotu working. Each screen sends
only its own pair, so neither can wipe the other's.

**One sheet adds a visit, a charge, or both.** There were two buttons, one at the foot of each
section, and they were two halves of a single event: the team went back, and while they were there
they did work that is over and above the PO. Two buttons made that two sheets and two saves, and the
second save is the one people did not come back for — which is how an order ends up with a revisit
recorded and no charge against it, or a charge with no visit to explain it. `+ Add visit or charge`
now sits below both lists, with a switch on each half; opening a visit from its own row is the same
sheet with the visit half fixed on.

**The charge is written first**, and the order is load-bearing: `fn_ops_save_visit` auto-proposes an
`additional_visit` charge on visit 2+ and skips it only when one already exists for that visit, so
writing the explicit charge first is what stops a hand-entered revisit charge and an auto-proposed
one both landing on the same visit. Any other charge type does not match that test and the automatic
one still arrives beside it, which is right: a return trip is billable on top of the work done on it.
**The eleventh visit does not refuse the sheet** — the visit half locks off at ten and the charge
half still works, because an order on its eleventh problem is exactly the one with money on it.

### The visit calculator

Visit date, visit outcome and the six installer dropdowns are **gone**: 0 of 120 visits ever carried
a status and nobody filled the names in, while the thing this screen is actually for — working out
what a return trip cost — was being done on paper. The two comment boxes are now one, saved to the
**Kurtains** channel.

In their place, a calculator that **never invents a rate**:

| Line | Where the money comes from |
|---|---|
| Extra visits | `adjustment_rate_card` via `fn_ops_rate_for`, the **unit** rate × the count |
| Adjustment alteration | same rate, entered here as 1-layer and 2-layer window counts and written back to `order_status` |
| Curtains remade | `remake_rate_card` through `v_ops_order_windows` — one tick-box per **window**, style, layers and width pre-filled and all three overridable |
| Additional materials | typed — there is no rate for it |
| Transport | typed — vehicle hire goes by distance and only the office sets that figure |

`fn_ops_rate_for` returns the **flat** rate for a `per visit` unit whatever quantity it is asked
about, so the multiplication happens against `rate_aed` in the browser — asking it for three visits
would otherwise price as one.

Every line shows its own working, and the whole sum is written out in words into the comment box
with a **Copy** button, ready to paste into Slack. The same text becomes the adjustment's reason,
which is what `invoice_lines.adjustment_needs_comment` demands and what an accountant reads three
weeks later. Two details that were got wrong first time and are worth keeping: the remade line
prints the **doubled** rate (92, not 46) so it multiplies out to the amount beside it, and widths
keep **two** decimals — `num()` rounds to one, and 1.84 m shown as 1.8 m does not reproduce the
figure.

**The picker lists every window, not every priceable line.** `v_ops_order_curtains` holds only lines
with a width, which is right for pricing and wrong for a picker: 100 of the 2,742 windows in the book
carry no priceable line at all — a tie back, a remote, a velcro job — and were silently not offered,
though any of them can still have been reworked. `v_ops_order_windows` is every window, with its
**widest** priceable curtain attached when it has one. Window names are **whitespace-normalised**
(17 pairs in the book differ by nothing but a double space and would otherwise appear twice), a
window with no width says so and waits for one to be typed, and a window with more than one curtain
— 367 of them — says how many rather than quietly dropping the rest.

**Why the charge exists is a value now.** `accounting_alerts.reason_code` is a closed list beside the
free-text reason: client changed their mind, new work after the PO, consultation issue, supplier
issue, client not available, site not ready, client damaged the goods, production issue, installation
issue, missing item, other. The last three mean the work is **ours to put right** and is normally
absorbed at AED 0 — picking one says so in a banner, without refusing the charge, because a
coordinator who has agreed a figure with a client outranks a rule of thumb. **Supplier issue is
charged** and is deliberately not the same value as production issue: folding the two together is
where this business loses the most money. The list lives in `ADJ_REASONS` in `js/config.js` and is
guarded by `check_values.py` against `accounting_alerts_reason_code_check`, like every other
vocabulary. It reaches Finance through `v_ops_finance_adjustments`.

**Charge this total** turns the calculation into one adjustment: the total in the amount, the
working in the reason, and the charge type set to whichever part was biggest — the same rule Chotu
is given for an adjustment made of several parts. The amount then **tracks the total** until
somebody types in the amount box itself; without that the figure captured when the button was
pressed would sit frozen while the total moved on, and the sheet would show two numbers for one job.

Above the list sits an **outcome filter**: one dropdown, *Any* plus the ten statuses, narrowing the
board to the orders sitting on one of them. It rides outside the shared bar on its own `status`
param — the **same key the dashboard uses**, so a link filtered on one screen opens filtered on the
other — and it filters the moment it is picked rather than waiting for Apply, because it is one
control with one value. Apply on the shared bar carries it along; without that the bar would rebuild
the query string from the filter fields alone and drop it.

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
version** — a revised PO is the one worth re-reading, so
*Revised* is a filter value of its own beside the version numbers.

**9. Chotu** (`#/chotu`) — see below.

**10. Finance** (`#/finance`) — where the accounts team takes the figures for an invoice. Two grids
behind one route. **Orders** is one row per billable PO line: order number, the billing SKU beside
the PO SKU, description, quantity, adjusted width, price per unit, unit value and Credits, with an
expand button carrying the whole 93-column PO row. **Adjustments** is the chargeable extras in the
exact column order they get pasted into a sheet — City, Comment from Installation, Order name,
Customer name, Amount, Reason — with a Copy for Sheets that writes tab-separated text, because a
comma-separated paste lands in one column.

Both grids sort on any header, select by row / by order / by everything shown, export CSV, and mark
in bulk. Never-credit items (remotes, tie-backs, express-install freebies — the list is DATA, in
`finance_no_credit_item`) are faded and locked at zero rather than hidden: the accountant still has
to see the tie-back is on the order, they just must never bill it.

**Three columns that look alike and are not.** `price_per_unit` is what the catalog charges for one.
`unit_value` is what the system computed for the line. `credits_aed` is what will actually be
invoiced — the finance override if somebody typed one, else unit_value, and always zero for a
never-credit item. Unit value is read-only for exactly that reason.

Edits never touch `order_lines_final`. `fn_rebuild_order` recomputes that table wholesale on every
PO revision, so overrides live in `finance_line_edit` keyed by order + **version** + line. Including
the version is the point: a revised PO is precisely where last week's agreed figure should stop
applying rather than silently carry over.

Six review rules are computed in `v_ops_finance_lines`, never in the browser, so the chips, the
filter and the bright highlight cannot drift apart: unpriced lines, uncharged removals, a window
over 450 cm with no scaffolding, pull cord, a duplicate line that carries money, and a Roman blind
with no supplier type. The duplicate rule counts only paid lines — matching on window plus product
alone flagged 416, topped by "Tie Back FOC" nine times on one window, which is correct data and free
anyway.

### Where an adjustment's money came from, and what finance does with it after

**Propose amount** writes the rate card's figure onto adjustments that already exist. The arithmetic
is not in the browser: `fn_finance_propose_adjustment_amount` looks every row up through
`fn_ops_rate_for`, the same function the Installation capture sheet and Chotu call, so three screens
can never quote different money for the same work. The grid's `card_amount_aed` comes through that
same function inside `v_ops_finance_adjustments`, which is why the preview and the write cannot
disagree — and it is the **banded total** (rate × quantity, less the free-metre allowance), not
`card_rate_aed`, which is the per-unit rate.

**It shows before it writes.** The button opens the list of what would change, old → new, because
this restates money on rows somebody else captured, in bulk. An amount a person set is skipped by
default and only replaced behind an explicit tick — an agreed figure is a decision, not a
calculation — and the RPC reports what it left alone (`skipped_manual`, `skipped_no_rate`) rather
than silently doing less than the button implied.

**`amount_source` exists because the amounts cannot answer the question.** `fn_ops_add_adjustment`
stores `agreed_amount_aed = coalesce(typed, card rate)`, so the agreed column is *always* set — a
row where agreed equals suggested is either somebody accepting the card rate or somebody typing the
same number, and those are not the same thing when a client queries the invoice. The column records
which; the grid shows `∑ System calculated` when it is the card's. Typing over the amount flips it
to `manual`, and **clearing the box hands the row back to the rate card** rather than storing zero,
which is the only way to undo an override without knowing what the figure used to be.

**Three tick boxes per adjustment** — Updated on 3D sheet, Invoice created, Paid — each with an
`_at` / `_by` pair, on hover. They are deliberately independent rather than one three-step status:
an adjustment can be invoiced without ever reaching the 3D sheet, and paid work still has to be
reconciled onto it afterwards. Un-ticking clears the stamp; a timestamp left standing beside a
`false` is a record of something that is no longer true. Toggling does **not** repaint the grid —
redrawing under somebody working down a column moves the next box out from under their finger.

Migrations: `adjustment_amount_source_and_finance_flags`,
`finance_adjustment_amount_and_flag_rpcs`,
`expose_adjustment_amount_source_and_finance_flags_in_views` (22 Aug 2026).

**One thing to know before trusting a proposed figure.** The rate card and the written policy
disagree in two places, and Propose amount follows the **card**, like every other screen: `tieback`
is stored as 150 *per piece*, so four tie backs propose 600 where the policy is a flat 150 for the
job; and `pickup` is stored at 100 where the policy says 150 each way. Chotu is told to correct both
in its prompt, which is why its totals can differ from this button's. Fixing that belongs in
`adjustment_rate_card`, not in a third opinion in the browser.

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

**One bad write no longer strands the rest.** `drain()` walks the queue by index; a write that fails
for a reason specific to it steps aside and lets everything behind it through. Only a genuine network
failure stops the run, and it should — with no signal the next seventeen will not go either. This is
the head-of-line problem, and it is what leaves somebody staring at "18 waiting to sync" that never
moves.

**Retry cadence follows the queue:** 5s while anything is waiting, 30s when idle, plus a flush on
`online`, `focus`, `pageshow` and `visibilitychange`. A flat 20s meant a phone coming out of a lift
sat for up to another twenty seconds — which is exactly the moment somebody decides it is broken.

**Both badges are buttons.** Tapping either opens one tray: what is still waiting, what failed and
why, a **Sync now** that drains both, and **Discard** for the parked ones. A number you can only
watch is what makes people re-enter work they have already done. A parked write also fires a toast
the moment it happens, since that is the one case where input is genuinely gone unless a human acts.

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
2. **Closed.** `intent` must be one of **sixteen** or the reply is downgraded to a plain answer.
   Every id in `fields` is checked against the facts and **removed** if it is not there, in
   `supabase/functions/chotu/index.ts`.
3. **Confirmed.** What arrives in the browser is a *proposal*, drawn as a form. The **Commit button**
   is what calls the RPC — the same `submit()` and the same replay-safe functions every other screen
   uses. Anything the model could not fill comes back in `need[]` and blocks the button.

So the worst a misheard sentence can do is put a wrong-looking card on screen, which somebody
declines. Speech is fast and unreliable, so the voice carries the speed and the button carries the
reliability. **Who said it comes from the signed-in account**, never a typed name — Chotu used to ask
and keep it in localStorage, which was a question with a better answer already on file, and a
free-text one at that, so the same person could be "Kausar", "kausar" and "Kausar M" on three
records.

**Sixteen intents.** Beyond receiving, prep, rails, status, tailors, issues, stock and handovers, it
can add a whole numbered visit, propose an adjustment against the live rate card, edit order-level
fields, and write a plain note. Adding a visit **always asks which outcome to mark** — a visit with
no outcome is a row nobody can act on, and assuming it went well is the one assumption never to
make. The visit number comes from `fn_chotu_context`, never from the model, because
`order_visits.visit_no` is capped at ten.

**An adjustment can carry the outcome with it.** "We went back, altered two curtains, and it is done
now" is one sentence with two writes in it, and the adjustment card has an **Order status** dropdown
so both commit on one tap. The field is **optional in a way the visit's outcome is not**: the model
is told to leave it out when they only described the work, it is never added to `need[]`, and blank
means the order keeps the status it had. Silence is not an outcome — a job being worked on is not a
job that finished.

**Charge types are DERIVED from `adjustment_rate_card`, not hardcoded.** They were a literal list of
ten; when two more were added to the CHECK and the app, Chotu silently could not propose either and
said only that it needed a charge type. Deriving them means a new charge reaches Chotu the moment it
has a rate.

**Every capture is written to `chotu_log`**, through the same offline queue, whether or not it also
reached a real table — and **an order number that matches nothing still lands there**, flagged, with
Chotu saying so out loud rather than silently attaching the note to a different order. Chotu can
read that log back: `fn_chotu_context` carries the last 30 entries, this order's history when an
order is in scope, so "what did anyone say about 63930" works.

**The confirmation card is a form.** Every field is editable and every field with a vocabulary is a
dropdown drawn from the same closed list the database checks, so a correction cannot invent a value
either. Photos attach, and so do files — the camera input is `capture="environment"`, which can only
ever open the camera, so a supplier's PDF or a photo already in the gallery needs the second button.

Verified against the live database: asking *"what fabrics are still pending for order 67813"* returns
the three real codes and meterages; saying *"fabric zz9999-plural-z-alpha arrived"* is refused, names
the three real options, and leaves Commit disabled.

**The order number is found in the browser, before the facts are fetched.** Every order id is exactly
five digits, so `orderIn()` in `js/mod-chotu.js` pulls it straight out
of the sentence. This is load-bearing rather than an optimisation: the facts are fetched *before* the
model runs, so an order that is not identified on the first pass is one the model was never shown —
and it then correctly reports that it cannot find it. Chotu used to depend on the model echoing the
number back so the browser could ask a second time, which works when the number is typed and is a
coin toss when it is spoken, because `70 770`, `70,770` and `7 0 7 7 0` all come out of the
transcriber and none of them is a five-digit token.

A number is only *adopted* once the facts confirm it is a real order — `facts.order` comes back null
otherwise — so "we used 12345 meters" does not leave a bogus order in scope for the next sentence.

Chotu sees **every live order**, not a slice: `facts.orders` is one compact row each (~64 kB for 700+)
and `facts.counts` holds the real totals, so "how many orders do you know about" answers from a count
and a customer name resolves to an order number. It used to see only the urgency slice and answered
"80". The browser's copy of the facts drops `orders`, `due` and `log` — the card is drawn from
fabrics, materials, rails, units, inventory and people, and the phone should not pay to download the
rest down mobile data.

The `due` list in `fn_chotu_context` is ordered by **urgency**, not by date: today, tomorrow, the day
after, then overdue most-recent-first. It was `order by installation_date limit 60`, which sounds
right and is exactly wrong — there are 390 overdue orders, so all 60 slots filled with the oldest of
them (late June) and nothing due this week ever appeared. That is how a live order due in two days
came back as "I have no details".

Adding an intent means adding it to `INTENTS`, to the `validate()` switch, to `INTENT_OPTIONS`, to
the card and to `commit()` in `js/mod-chotu.js`. If it does not map to an RPC that already exists, it
is the wrong shape.

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
- **Capture is always a charge.** There is no "charge the client" choice on the way in — the old
  dropdown asked at capture time a question the row already answers afterwards with **Confirm** and
  **Do not charge**, and two controls for one decision is how they end up disagreeing. Everything
  arrives `chargeable`, status `new`; dropping one sets `chargeable = false` and status `dropped` in
  the one place that decision lives.
- **The charge and the outcome commit together.** Both the Installation module's visit-or-charge
  sheet and Chotu's adjustment card carry an **Order status** dropdown, blank by default, meaning
  *leave it alone*. Pick one and the same button writes `fn_ops_add_adjustment` and then
  `fn_ops_save_visit`, queued in that order so a phone that lost signal replays both. This exists because an adjustment is
  almost always somebody reporting back from site with two things in their head at once — what
  happened and what it cost — and the second save was the one that got forgotten.
  The status write always sets `skip_visit_charge` (the charge is the one just captured, not a second
  auto-proposed revisit) and points at the **last recorded** visit, never the number typed against
  the charge: `fn_ops_save_visit` upserts an `order_visits` row, so aiming it at a visit that has not
  happened yet would invent one.
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
js/mod-comments.js      module 8 - the line-by-line PO review
js/mod-chotu.js         module 9 - the voice screen
js/mod-finance.js       module 10 - the two finance grids
js/mod-schedule.js      the schedule board
js/app.js               hash router
check_i18n.py           key parity across the three languages
check_values.py         every written value still matches its CHECK constraint
tools/check_columns.py  every column the app SELECTs still exists
```

Run all three checkers after touching strings, vocabularies, a module or a view:

```bash
python check_i18n.py && python check_values.py && python tools/check_columns.py
```

`check_columns.py` runs automatically on a Stop hook and blocks on failure. It exists because a
migration dropped two columns from `v_ops_order_roster` and nothing failed until the next morning,
for the staff, on four screens at once — PostgREST refuses the WHOLE request when one column in the
select list is missing. It needs no credentials: the select list is resolved before RLS, so an
unauthenticated request carrying the publishable key gets 400 for a bad column and 200 for a good
one, which is the same code path the browser takes.

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
- **`verify_jwt = true` does NOT reject a request with no Authorization header at all.** It validates
  the header only when one is present. A caller holding just the publishable key — which ships inside
  this app and is public — reached `chotu` and got real order data, and reached `sched-ask` and got
  live Gemini output on our own bill. Both functions now check for a bearer token themselves. **Any
  new Edge Function must do the same**; the platform will not do it for you.
- **Use `authedFetch` for anything that does not go through `api()`.** A proactive token refresh is
  not enough on its own: `freshToken()` renews only when `session.expires_at` says the token is
  nearly up, and a session restored from an older localStorage shape has no `expires_at`, so that
  branch never fires. What rescues it is the refresh triggered BY a 401 — which `api()` has always
  done and which is why every other screen kept working while Chotu answered "unavailable (401)".
- **A dropped view column takes down four screens at once**, silently, until somebody opens the tab.
  See `tools/check_columns.py` above, and run it after any migration that touches a view.
- **Adding a charge type touches five places** — the CHECK on `accounting_alerts` and on
  `adjustment_rate_card`, a rate-card row, `CHARGE_TYPES` in `js/config.js`, and its `chg.*` labels in
  all three languages. Chotu's vocabulary is no longer one of them: it derives from the rate card.

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

The four functions in `supabase/functions/` live in **this** repo because all four exist only to
serve this app — `js/voice.js` calls `transcribe`, `js/mod-chotu.js` calls `chotu`,
`js/mod-schedule.js` calls `sched-ask`, `js/photos.js` calls `photo-signed-url`. Deploy from the repo
root, which is where the `supabase/` directory sits:

```bash
supabase functions deploy chotu --project-ref jrevqijbzzwdcwxcnwfa
```

Only `chotu` and `sched-ask` are currently deployed; the other two are 404 on the project.

They pass the caller's own bearer token through to PostgREST, so a function can never become a way
around RLS — and each one checks for that token itself before doing any work, because `verify_jwt`
does not (see Traps).

**Keep this directory in step with what is deployed.** `sched-ask` was recovered into the repo on
18 Aug 2026 having never been in it: it existed only on Supabase, so nobody reading this project
could see what the Schedule question box did, and a deploy from source would have replaced it with
nothing. If you edit a function in the dashboard, bring the change back here — the dashboard is a
deploy target, not where code is written.

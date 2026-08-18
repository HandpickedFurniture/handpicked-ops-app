/**
 * Chotu log -> Google Doc.  PASTE THIS INTO YOUR DOC'S APPS SCRIPT.
 *
 * The Doc is a COPY. chotu_log in Supabase is the source of truth: phones are offline in a
 * workshop and a webhook cannot be, so the capture is written to the database first, through the
 * offline queue, and pushed here afterwards. If this script breaks, nothing is lost - the rows sit
 * with synced_at still null and go out on the next run.
 *
 * SETUP
 *   1. Create a Google Doc. Call it something like "Chotu log".
 *   2. From the Doc: Extensions > Apps Script. Delete what is there, paste this whole file.
 *   3. Put the Doc's id in DOC_ID below - it is the long string in the Doc's URL between
 *      /d/ and /edit.
 *   4. Put a long random string in TOKEN below. Invent one; it is a shared password between
 *      Supabase and this script, and it is the ONLY thing stopping a stranger who guesses your
 *      web-app URL from writing into the Doc.
 *   5. Deploy > New deployment > type "Web app".
 *        Execute as: Me
 *        Who has access: Anyone          <- required; Supabase cannot log in as you
 *      Copy the /exec URL it gives you.
 *   6. Give Ashmeet the /exec URL and the TOKEN. They go into Supabase secrets as
 *      CHOTU_DOC_WEBHOOK and CHOTU_DOC_TOKEN.
 *
 * "Anyone" sounds alarming and is why the token exists: the URL is unguessable, and a request
 * without the right token is refused before the Doc is touched.
 */

const DOC_ID = 'PASTE_THE_DOC_ID_HERE';
const TOKEN  = 'PASTE_A_LONG_RANDOM_STRING_HERE';

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return reply({ ok: false, error: 'no body' });
    const body = JSON.parse(e.postData.contents);

    if (!TOKEN || TOKEN === 'PASTE_A_LONG_RANDOM_STRING_HERE') {
      return reply({ ok: false, error: 'script not configured: set TOKEN' });
    }
    if (body.token !== TOKEN) return reply({ ok: false, error: 'bad token' });

    const entries = body.entries || [];
    if (!entries.length) return reply({ ok: true, written: 0 });

    /* One lock for the whole batch. Two pushes overlapping would interleave paragraphs into the
     * wrong sections, and a log nobody trusts is a log nobody reads. */
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const doc = DocumentApp.openById(DOC_ID);
      const bodyEl = doc.getBody();
      entries.forEach(function (row) { writeEntry(bodyEl, row); });
      doc.saveAndClose();
    } finally {
      lock.releaseLock();
    }
    return reply({ ok: true, written: entries.length });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

/* Grouped by order, newest first inside each group.
 *
 * Newest-first is why this inserts directly after the heading rather than hunting for the end of
 * the section: finding a section's last paragraph means scanning forward for the next heading and
 * getting the boundary right every time, and inserting at heading+1 needs neither. */
function writeEntry(bodyEl, row) {
  const key = row.order_id ? ('Order ' + row.order_id) : 'No order given';
  const title = row.matched === false ? (key + '  (not in our records)') : key;

  let idx = findHeading(bodyEl, key);
  if (idx === -1) {
    const h = bodyEl.appendParagraph(title);
    h.setHeading(DocumentApp.ParagraphHeading.HEADING2);
    idx = bodyEl.getChildIndex(h);
  }

  const line = bodyEl.insertParagraph(idx + 1, entryText(row));
  line.setHeading(DocumentApp.ParagraphHeading.NORMAL);
}

/* Matches on the heading's leading text, so the "(not in our records)" suffix on an unmatched
 * order still lands in the same section as the rest of that order number. */
function findHeading(bodyEl, key) {
  const n = bodyEl.getNumChildren();
  for (let i = 0; i < n; i++) {
    const c = bodyEl.getChild(i);
    if (c.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const p = c.asParagraph();
    if (p.getHeading() !== DocumentApp.ParagraphHeading.HEADING2) continue;
    if (p.getText().indexOf(key) === 0) return i;
  }
  return -1;
}

function entryText(row) {
  const bits = [row.at || '', row.who || 'unknown'];
  if (row.intent) bits.push(row.intent);
  if (row.saved === false) bits.push('NOT SAVED - note only');
  let t = bits.join('  |  ') + '\n' + (row.said || '');
  if (row.i_said) t += '\nChotu: ' + row.i_said;
  return t;
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* Run this once from the editor to check DOC_ID and permissions before deploying. It writes one
 * obvious test line you can then delete. */
function testWrite() {
  const doc = DocumentApp.openById(DOC_ID);
  writeEntry(doc.getBody(), {
    at: '2026-01-01 00:00', who: 'setup test', order_id: '00000',
    said: 'If you can read this, DOC_ID and permissions are correct. Delete this line.',
    intent: 'answer', saved: true, matched: true,
  });
  doc.saveAndClose();
}

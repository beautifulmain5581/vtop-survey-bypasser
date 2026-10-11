/**
 * content.js — VTOP Survey Bypasser · Core Automation Engine
 *
 * Architecture:
 *  - On every VTOP page load, checks chrome.storage.local for the
 *    autoFillActive flag.
 *  - Uses a MutationObserver + periodic polling hybrid to detect when
 *    VTOP's asynchronously rendered tables are ready.
 *  - Scenario A: Course List page → clicks the first red "Post" button.
 *  - Scenario B: Feedback Form page → selects 5-star rating for every
 *    row, skips textareas, then clicks the green Submit button.
 *
 * Storage keys used:
 *  autoFillActive   {boolean}  Master on/off switch
 *  autoFillComplete {boolean}  Set true when all feedback is done
 *  submittedCount   {number}   Incremented after each successful submit
 *  pendingCount     {number}   Updated on the course-list page
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum time (ms) to wait for async table rendering before giving up. */
const OBSERVER_TIMEOUT_MS = 20_000;

/** Delay (ms) between selecting all stars and clicking Submit, giving the
 *  VTOP Angular/jQuery listeners time to register each click event. */
const PRE_SUBMIT_DELAY_MS = 600;

/** How often (ms) the fallback polling interval re-checks the DOM. */
const POLL_INTERVAL_MS = 500;

// ─── Entry point ─────────────────────────────────────────────────────────────

(function init() {
  // ── Triggered on page load (handles post-navigation cycles) ──────────────
  chrome.storage.local.get(
    ['autoFillActive', 'submittedCount', 'pendingCount'],
    (state) => {
      if (chrome.runtime.lastError) {
        console.warn('[VTOP-Auto] Storage read error:', chrome.runtime.lastError);
        return;
      }
      if (!state.autoFillActive) return; // Automation not active — do nothing.
      waitForPageReady(onPageReady);
    }
  );

  // ── Triggered by popup's sendMessage (first activation, no reload) ────────
  // This allows the popup to start automation on the CURRENT page without
  // reloading it, which would trigger VTOP's multi-session guard and log
  // the user out.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'START_AUTOFILL') {
      waitForPageReady(onPageReady);
      sendResponse({ status: 'started' });
    }
  });
})();

// ─── Core element waiter ─────────────────────────────────────────────────────

/**
 * Generic DOM waiter: polls + observes until predicate() returns true,
 * then fires callback exactly once and cleans up.
 *
 * Used by both the page-load path AND the post-click AJAX fallback path so
 * the automation continues regardless of whether VTOP uses full-page
 * navigation or inline AJAX rendering.
 *
 * @param {Function} predicate     Returns true when the awaited state is ready.
 * @param {Function} callback      Called once when predicate is satisfied.
 * @param {number}  [timeoutMs]    Give up after this many ms (default 20 s).
 */
function waitForElement(predicate, callback, timeoutMs = OBSERVER_TIMEOUT_MS) {
  if (predicate()) { callback(); return; }

  // Guard: body may be null if called during early page load
  if (!document.body) {
    setTimeout(() => waitForElement(predicate, callback, timeoutMs), 100);
    return;
  }

  let settled = false;

  function resolve() {
    if (settled) return;
    settled = true;
    clearInterval(pollTimer);
    observer.disconnect();
    callback();
  }

  const observer = new MutationObserver(() => { if (predicate()) resolve(); });
  observer.observe(document.body, { childList: true, subtree: true });

  const pollTimer = setInterval(() => { if (predicate()) resolve(); }, POLL_INTERVAL_MS);

  setTimeout(() => {
    if (!settled) {
      settled = true;
      clearInterval(pollTimer);
      observer.disconnect();
      console.warn('[VTOP-Auto] waitForElement timed out.');
      // Abort gracefully so the UI doesn't spin forever
      chrome.storage.local.set({ autoFillActive: false });
    }
  }, timeoutMs);
}

/**
 * Waits until the VTOP page has rendered its core interactive elements
 * (Post/Posted buttons or the feedback Submit button).
 *
 * @param {Function} callback  Called once page is ready.
 */
function waitForPageReady(callback) {
  waitForElement(isPageReady, callback);
}

/**
 * Returns true when either a "Post" / "Posted" button OR a Submit
 * button is present — meaning VTOP has finished rendering its tables.
 */
function isPageReady() {
  // Scenario A indicator: the course feedback table with Post buttons
  const hasCourseList = document.querySelector(
    'input[value="Post"], button[value="Post"], ' +
    'input[value="Posted"], button[value="Posted"]'
  );
  if (hasCourseList) return true;

  // Sometimes rendered as <a> tags or <td> containing text "Post"
  const allButtons = [...document.querySelectorAll('button, input[type="button"], input[type="submit"], a')];
  const hasPostText = allButtons.some(el => el.textContent.trim() === 'Post' || el.value === 'Post');
  if (hasPostText) return true;

  // Scenario B indicator: the Submit button on the feedback form
  const hasSubmit = findSubmitButton();
  if (hasSubmit) return true;

  return false;
}

// ─── Main dispatch ────────────────────────────────────────────────────────────

/**
 * Called once the page is ready. Determines which scenario we are in
 * and delegates accordingly.
 */
function onPageReady() {
  // Re-read storage in case the user stopped the automation while we waited
  chrome.storage.local.get(['autoFillActive'], (state) => {
    if (!state.autoFillActive) return;

    const submitBtn = findSubmitButton();
    if (submitBtn) handleFeedbackForm(submitBtn);
    else handleCourseList();
  });
}

// ─── Scenario A: Course List ──────────────────────────────────────────────────

/**
 * Scans the DOM for a red "Post" button (exact text, case-sensitive).
 * Clicks the first one found, or signals completion if none remain.
 */
function handleCourseList() {
  const postButtons = findPostButtons();
  const postedCount = findPostedElements().length;

  // Update the pending counter in storage (for the popup UI)
  chrome.storage.local.set({ pendingCount: postButtons.length });

  if (postButtons.length === 0) {
    chrome.storage.local.set({
      autoFillActive:   false,
      autoFillComplete: true,
      pendingCount:     0,
    }, () => {
      // Show a visible notification overlay instead of alert()
      // so we don't block the page inside a content script context
      showCompletionBanner(postedCount);
    });
    return;
  }

  // Click the first available "Post" button
  const target = postButtons[0];
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });

  setTimeout(() => {
    target.click();

    // ── AJAX / SPA fallback ─────────────────────────────────────────────────
    // If VTOP loads the feedback form without a full page navigation (e.g. via
    // AJAX into the same frame), the Submit button will appear in the current
    // DOM and this watcher will catch it.
    // If VTOP DOES do a full page reload, this observer is garbage-collected
    // the moment the page unloads and the fresh content.js handles everything.
    // The 300 ms delay gives the click's navigation/AJAX time to begin so
    // we don't accidentally match a stale Submit button from a prior state.
    setTimeout(() => {
      waitForElement(() => !!findSubmitButton(), onPageReady);
    }, 300);
  }, 350);
}

/**
 * Returns all clickable elements whose visible text is exactly "Post"
 * (not "Posted"). Checks buttons, input[type=button/submit], and <a> tags.
 */
function findPostButtons() {
  const candidates = [
    ...document.querySelectorAll('button'),
    ...document.querySelectorAll('input[type="button"]'),
    ...document.querySelectorAll('input[type="submit"]'),
    ...document.querySelectorAll('a'),
  ];

  return candidates.filter(el => {
    // Ignore disabled or hidden elements (like template rows)
    if (el.disabled) return false;
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;

    const text = (el.value || el.textContent || '').trim();
    return text === 'Post';
  });
}

/**
 * Returns all elements whose text is "Posted" (already completed rows).
 */
function findPostedElements() {
  const candidates = [
    ...document.querySelectorAll('button'),
    ...document.querySelectorAll('input[type="button"]'),
    ...document.querySelectorAll('input[type="submit"]'),
    ...document.querySelectorAll('span'),
    ...document.querySelectorAll('td'),
  ];

  return candidates.filter(el => {
    // Ignore hidden elements
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;

    const text = (el.value || el.textContent || '').trim();
    return text === 'Posted';
  });
}

// ─── Scenario B: Feedback Form ────────────────────────────────────────────────

/**
 * Selects the 5th star (highest rating) for every rating row in all
 * feedback tables, then clicks the Submit button.
 *
 * VTOP renders stars as one of several patterns observed in the screenshots:
 *   1. <input type="radio" value="5" name="..."> (classic radio)
 *   2. <input type="radio" value="5" id="...">
 *   3. Star-icon elements inside <label> / <td> that wrap radio inputs
 *   4. <span> or <i> elements with star classes (e.g. fa-star, glyphicon-star)
 *
 * Strategy: We try all known patterns in order, then fall back to a
 * table-row approach to ensure we never miss a rating.
 *
 * @param {Element} submitBtn  The green Submit button element.
 */
function handleFeedbackForm(submitBtn) {
  // Shared deduplication Set — tracks radio `name` attributes already
  // processed so Strategies 1, 2, and 3 never double-click the same row.
  // Double-clicking a radio can fire change events twice and looks bot-like.
  const processedNames = new Set();

  // ── Strategy 1: Standard radio inputs with value="5" ────────────
  // Most common VTOP rendering: plain <input type="radio" value="5">
  const radioFives = document.querySelectorAll(
    'input[type="radio"][value="5"], input[type="radio"][value="5.0"]'
  );
  radioFives.forEach(radio => {
    if (radio.checked || isInsideTextareaRow(radio)) return;
    const key = radio.name || radio.id;
    if (!key || processedNames.has(key)) return;
    processedNames.add(key);
    radio.click();
    radio.checked = true;
  });

  // ── Strategy 2: Star label/span click (CSS/JS star widgets) ──────
  selectStarsViaLabels(processedNames);

  // ── Strategy 3: Table-row fallback ───────────────────────────────
  selectViaTableRows(processedNames);

  // Wait for click events to register in VTOP's JS framework,
  // then submit. The delay also mimics a brief human review pause.
  // NOTE: This function never writes to textareas — only radio inputs are
  // clicked. Suggestion rows are skipped by isInsideTextareaRow().
  setTimeout(() => {
    chrome.storage.local.get(['submittedCount'], (state) => {
      const newCount = (state.submittedCount || 0) + 1;
      chrome.storage.local.set({ submittedCount: newCount }, () => {
        submitBtn.click();

        // ── AJAX / SPA fallback ───────────────────────────────────────────────
        // If VTOP returns to the course list without a full page reload,
        // watch for Post buttons to reappear and continue the loop.
        // If it IS a full reload, this observer is gc'd and init() handles it.
        setTimeout(() => {
          waitForElement(() => findPostButtons().length > 0, onPageReady);
        }, 300);
      });
    });
  }, PRE_SUBMIT_DELAY_MS);
}

/**
 * Clicks the highest-rated label for each radio group (CSS/JS star widgets).
 * @param {Set<string>} processedNames  Shared dedup guard from handleFeedbackForm.
 */
function selectStarsViaLabels(processedNames) {
  // Group radio buttons by their `name` attribute
  const radioGroups = {};
  document.querySelectorAll('input[type="radio"]').forEach(radio => {
    const name = radio.name || radio.id.replace(/\d+$/, '');
    if (!name) return;
    if (!radioGroups[name]) radioGroups[name] = [];
    radioGroups[name].push(radio);
  });

  Object.values(radioGroups).forEach(radios => {
    if (radios.length < 2) return; // Not a rating group

    // Find the radio with the highest numeric value
    let best = null;
    let bestVal = -Infinity;
    radios.forEach(r => {
      const v = parseFloat(r.value);
      if (!isNaN(v) && v > bestVal) { bestVal = v; best = r; }
    });

    if (!best || best.checked) return;
    if (isInsideTextareaRow(best)) return;

    const key = best.name || best.id;
    if (processedNames.has(key)) return; // Already handled by Strategy 1
    processedNames.add(key);

    const label = document.querySelector(`label[for="${best.id}"]`);
    if (label) label.click();
    else { best.click(); best.checked = true; }
  });
}

/**
 * Table-row fallback: iterates <tr> elements in feedback tables and
 * clicks the highest-value radio in the Rating column.
 * @param {Set<string>} processedNames  Shared dedup guard from handleFeedbackForm.
 */
function selectViaTableRows(processedNames) {
  // Target only tables that have a "Rating" or "Statement" header
  const tables = [...document.querySelectorAll('table')].filter(t =>
    t.textContent.toLowerCase().includes('rating') ||
    t.textContent.toLowerCase().includes('statement')
  );

  tables.forEach(table => {
    [...table.querySelectorAll('tr')].forEach(row => {
      if (row.querySelector('th')) return;       // Header row
      if (row.querySelector('textarea')) return; // Suggestion row

      const radios = [...row.querySelectorAll('input[type="radio"]')];
      if (radios.length === 0) return;

      // Pick the highest-value radio; fall back to the last one
      let best = null, bestVal = -Infinity;
      radios.forEach(r => {
        const v = parseFloat(r.value);
        if (!isNaN(v) && v > bestVal) { bestVal = v; best = r; }
      });
      if (!best) best = radios[radios.length - 1];

      if (!best || best.checked) return;

      const key = best.name || best.id;
      if (processedNames.has(key)) return; // Already handled
      processedNames.add(key);

      const label = document.querySelector(`label[for="${best.id}"]`);
      if (label) label.click();
      else { best.click(); best.checked = true; }
    });
  });
}

/**
 * Returns true if the given element lives inside a table row that also
 * contains a <textarea>. These are "Suggestions for improvement" rows
 * and must not be given a star rating.
 *
 * @param {Element} el
 * @returns {boolean}
 */
function isInsideTextareaRow(el) {
  const row = el.closest('tr');
  return row ? !!row.querySelector('textarea') : false;
}

// ─── Submit button detection ──────────────────────────────────────────────────

/**
 * Finds the green Submit button on the feedback form.
 * VTOP's Submit button can appear as:
 *   <input type="submit" value="Submit">
 *   <button type="submit">Submit</button>
 *   <button class="btn btn-success">Submit</button>
 *   <input type="button" value="Submit">
 *
 * We intentionally do NOT match the "Back" button.
 *
 * @returns {Element|null}
 */
function findSubmitButton() {
  // Prefer explicit submit inputs/buttons with value "Submit"
  const submitInput = document.querySelector(
    'input[type="submit"][value="Submit"], input[type="button"][value="Submit"]'
  );
  if (submitInput) return submitInput;

  // Fallback: <button> whose trimmed text is exactly "Submit"
  const allButtons = [...document.querySelectorAll('button')];
  const submitBtn = allButtons.find(b => b.textContent.trim() === 'Submit');
  if (submitBtn) return submitBtn;

  return null;
}

// ─── Completion banner ────────────────────────────────────────────────────────

/**
 * Injects a non-blocking, auto-dismissing completion banner into the page.
 * Avoids using window.alert() which blocks script execution inside
 * content scripts on some browsers.
 *
 * @param {number} totalPosted  Number of forms already in "Posted" state.
 */
function showCompletionBanner(totalPosted) {
  // Remove any existing banner
  document.getElementById('vtop-auto-banner')?.remove();

  const banner = document.createElement('div');
  banner.id = 'vtop-auto-banner';
  banner.innerHTML = `
    <div id="vtop-auto-inner">
      <div id="vtop-auto-icon">✅</div>
      <div>
        <strong>Feedback Automation Complete!</strong><br>
        <small>All available subjects have been submitted successfully.</small>
      </div>
      <button id="vtop-auto-close" title="Dismiss">✕</button>
    </div>
  `;

  Object.assign(banner.style, {
    position:     'fixed',
    top:          '20px',
    right:        '20px',
    zIndex:       '2147483647',
    background:   'linear-gradient(135deg, #065f46, #047857)',
    color:        '#ecfdf5',
    borderRadius: '12px',
    boxShadow:    '0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.1)',
    fontFamily:   'Segoe UI, system-ui, sans-serif',
    fontSize:     '14px',
    padding:      '0',
    maxWidth:     '360px',
    animation:    'vtopSlideIn 0.4s ease',
  });

  const inner = banner.querySelector('#vtop-auto-inner');
  Object.assign(inner.style, {
    display:    'flex',
    alignItems: 'center',
    gap:        '14px',
    padding:    '16px 18px',
  });

  const icon = banner.querySelector('#vtop-auto-icon');
  Object.assign(icon.style, { fontSize: '28px', flexShrink: '0' });

  const closeBtn = banner.querySelector('#vtop-auto-close');
  Object.assign(closeBtn.style, {
    marginLeft:  'auto',
    background:  'none',
    border:      'none',
    color:       '#a7f3d0',
    fontSize:    '16px',
    cursor:      'pointer',
    flexShrink:  '0',
    padding:     '4px 6px',
    borderRadius:'6px',
  });

  // Inject keyframe animation
  const style = document.createElement('style');
  style.textContent = `
    @keyframes vtopSlideIn {
      from { opacity: 0; transform: translateY(-20px) scale(0.95); }
      to   { opacity: 1; transform: translateY(0)    scale(1);    }
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(banner);

  // Close on button click
  closeBtn.addEventListener('click', () => banner.remove());

  // Auto-dismiss after 8 seconds
  setTimeout(() => banner.remove(), 8000);
}

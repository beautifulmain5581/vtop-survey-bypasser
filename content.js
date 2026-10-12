/**
 * content.js — VTOP Survey Bypasser · Core Automation Engine
 *
 * Architecture:
 *  - On every VTOP page load, checks chrome.storage.local for the
 *    autoFillActive flag.
 *  - Uses a MutationObserver + periodic polling hybrid to detect when
 *    VTOP's asynchronously rendered tables are ready.
 *  - Scenario A: Course List page → clicks the first red "Post" button.
 *  - Scenario B: Feedback Form page → selects chosen star rating (1-5) for every
 *    row, skips textareas, then clicks the green Submit button.
 *
 * Storage keys used:
 *  autoFillActive   {boolean}  Master on/off switch
 *  autoFillComplete {boolean}  Set true when all feedback is done
 *  submittedCount   {number}   Incremented after each successful submit
 *  pendingCount     {number}   Updated on the course-list page
 *  targetRating     {number}   Selected star rating (1-5, defaults to 5)
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
    ['autoFillActive', 'submittedCount', 'pendingCount', 'targetRating'],
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
 * Returns true when either course buttons ("Post" / "Posted") OR the
 * feedback form Submit button is present in the DOM.
 */
function isPageReady() {
  if (findPostButtons().length > 0) return true;
  if (findPostedElements().length > 0) return true;
  if (findSubmitButton()) return true;
  return false;
}

// ─── Main dispatch ────────────────────────────────────────────────────────────

/**
 * Called once the page is ready. Determines which scenario we are in
 * and delegates accordingly.
 */
function onPageReady() {
  // Re-read storage in case the user stopped the automation or changed rating while we waited
  chrome.storage.local.get(['autoFillActive', 'targetRating'], (state) => {
    if (!state.autoFillActive) return;

    const rawRating = state.targetRating != null ? Number(state.targetRating) : 5;
    const targetRating = Math.min(5, Math.max(1, isNaN(rawRating) ? 5 : Math.round(rawRating)));

    const submitBtn = findSubmitButton();
    if (submitBtn) handleFeedbackForm(submitBtn, targetRating);
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
      chrome.storage.local.get(['targetRating'], (state) => {
        const rating = Number(state.targetRating) || 5;
        showCompletionBanner(postedCount, rating);
      });
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
 * Returns all clickable elements whose visible text is "Post" (case-insensitive,
 * not "Posted"). Checks buttons, inputs, and links.
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

    const text = (el.value || el.textContent || '').trim().toLowerCase();
    return text === 'post';
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
    ...document.querySelectorAll('div'),
    ...document.querySelectorAll('a'),
  ];

  return candidates.filter(el => {
    // Ignore hidden elements
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;

    const text = (el.value || el.textContent || '').trim().toLowerCase();
    return text === 'posted';
  });
}

// ─── Scenario B: Feedback Form ────────────────────────────────────────────────

/**
 * Finds the radio input that best matches the desired rating (1 to 5).
 *
 * Strategy order:
 *  1. Exact numeric value match (e.g. value="4" or value="4.0")
 *  2. Closest numeric value if on a different scale (e.g. 1-3 or 1-10)
 *  3. Positional fallback by index if values are non-numeric strings
 *     (e.g., maps rating 1..5 across available radios from 0 to length - 1)
 *
 * @param {HTMLInputElement[]} radios
 * @param {number} targetRating
 * @returns {HTMLInputElement|null}
 */
function findTargetRadio(radios, targetRating = 5) {
  if (!radios || radios.length === 0) return null;

  // 1. Exact numeric value match
  for (const r of radios) {
    const val = parseFloat(r.value);
    if (!isNaN(val) && val === targetRating) {
      return r;
    }
  }

  // 2. Closest numeric value
  const numericList = radios
    .map(r => ({ radio: r, val: parseFloat(r.value) }))
    .filter(item => !isNaN(item.val));

  if (numericList.length > 0) {
    numericList.sort((a, b) => Math.abs(a.val - targetRating) - Math.abs(b.val - targetRating));
    return numericList[0].radio;
  }

  // 3. Positional index fallback: map 1..5 across available radios
  const targetIndex = Math.min(Math.max(targetRating - 1, 0), radios.length - 1);
  return radios[targetIndex] || null;
}

/**
 * Selects the requested star rating (1-5) for every rating row in all
 * feedback tables, then clicks the Submit button.
 *
 * @param {Element} submitBtn       The green Submit button element.
 * @param {number}  [targetRating=5]  Desired rating from 1 to 5.
 */
function handleFeedbackForm(submitBtn, targetRating = 5) {
  // Shared deduplication Set — tracks radio `name` attributes already
  // processed so Strategies 1, 2, and 3 never double-click the same row.
  const processedNames = new Set();

  // ── Strategy 1: Standard radio inputs matching target rating ────
  // Most common VTOP rendering: plain <input type="radio" value="N"> or "N.0"
  const targetStr = String(targetRating);
  const targetFloatStr = targetRating.toFixed(1);
  const targetRadios = document.querySelectorAll(
    `input[type="radio"][value="${targetStr}"], input[type="radio"][value="${targetFloatStr}"]`
  );
  targetRadios.forEach(radio => {
    if (isInsideTextareaRow(radio)) return;
    const key = radio.name || radio.id;
    if (!key || processedNames.has(key)) return;
    processedNames.add(key);

    if (!radio.checked) {
      radio.click();
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  // ── Strategy 2: Star label/span click (CSS/JS star widgets) ──────
  selectStarsViaLabels(processedNames, targetRating);

  // ── Strategy 3: Table-row fallback ───────────────────────────────
  selectViaTableRows(processedNames, targetRating);

  // Wait for click events to register in VTOP's JS framework,
  // then submit. The delay also mimics a brief human review pause.
  setTimeout(() => {
    chrome.storage.local.get(['submittedCount'], (state) => {
      const newCount = (state.submittedCount || 0) + 1;
      chrome.storage.local.set({ submittedCount: newCount }, () => {
        submitBtn.click();

        // ── AJAX / SPA fallback ───────────────────────────────────────────────
        // Wait for course list or next form to render (avoids 20s hang on completion)
        setTimeout(() => {
          waitForElement(() => isPageReady(), onPageReady);
        }, 300);
      });
    });
  }, PRE_SUBMIT_DELAY_MS);
}

/**
 * Clicks the target-rated label for each radio group (CSS/JS star widgets).
 * @param {Set<string>} processedNames   Shared dedup guard from handleFeedbackForm.
 * @param {number}      [targetRating=5]
 */
function selectStarsViaLabels(processedNames, targetRating = 5) {
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

    const best = findTargetRadio(radios, targetRating);
    if (!best || best.checked) return;
    if (isInsideTextareaRow(best)) return;

    const key = best.name || best.id;
    if (processedNames.has(key)) return; // Already handled by Strategy 1
    processedNames.add(key);

    const label = document.querySelector(`label[for="${best.id}"]`);
    if (label) {
      label.click();
    } else {
      best.click();
      best.checked = true;
      best.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
}

/**
 * Table-row fallback: iterates <tr> elements in feedback tables and
 * clicks the target-value radio in the Rating column.
 * @param {Set<string>} processedNames   Shared dedup guard from handleFeedbackForm.
 * @param {number}      [targetRating=5]
 */
function selectViaTableRows(processedNames, targetRating = 5) {
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

      const best = findTargetRadio(radios, targetRating);
      if (!best || best.checked) return;

      const key = best.name || best.id;
      if (processedNames.has(key)) return; // Already handled
      processedNames.add(key);

      const label = document.querySelector(`label[for="${best.id}"]`);
      if (label) {
        label.click();
      } else {
        best.click();
        best.checked = true;
        best.dispatchEvent(new Event('change', { bubbles: true }));
      }
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
 * Finds the Submit button on the feedback form (case-insensitive).
 *
 * @returns {Element|null}
 */
function findSubmitButton() {
  const candidates = [
    ...document.querySelectorAll('input[type="submit"]'),
    ...document.querySelectorAll('input[type="button"]'),
    ...document.querySelectorAll('button'),
  ];

  return candidates.find(el => {
    if (el.disabled) return false;
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;

    const text = (el.value || el.textContent || '').trim().toLowerCase();
    return text === 'submit';
  }) || null;
}

// ─── Completion banner ────────────────────────────────────────────────────────

/**
 * Injects a non-blocking, auto-dismissing completion banner into the page.
 * Avoids using window.alert() which blocks script execution inside
 * content scripts on some browsers.
 *
 * @param {number} totalPosted   Number of forms already in "Posted" state.
 * @param {number} [targetRating=5]
 */
function showCompletionBanner(totalPosted, targetRating = 5) {
  // Remove any existing banner
  document.getElementById('vtop-auto-banner')?.remove();

  const safeRating = Math.min(5, Math.max(1, Math.round(Number(targetRating) || 5)));

  const banner = document.createElement('div');
  banner.id = 'vtop-auto-banner';
  banner.innerHTML = `
    <div id="vtop-auto-inner">
      <div id="vtop-auto-icon">✅</div>
      <div>
        <strong>Feedback Automation Complete!</strong><br>
        <small>All available subjects submitted with ${safeRating}★ rating.</small>
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

  // Inject keyframe animation once
  if (!document.getElementById('vtop-auto-style')) {
    const style = document.createElement('style');
    style.id = 'vtop-auto-style';
    style.textContent = `
      @keyframes vtopSlideIn {
        from { opacity: 0; transform: translateY(-20px) scale(0.95); }
        to   { opacity: 1; transform: translateY(0)    scale(1);    }
      }
    `;
    document.head.appendChild(style);
  }
  document.body.appendChild(banner);

  // Close on button click
  closeBtn.addEventListener('click', () => banner.remove());

  // Auto-dismiss after 8 seconds
  setTimeout(() => banner.remove(), 8000);
}

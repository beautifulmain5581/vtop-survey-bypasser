/**
 * popup.js — VTOP Survey Bypasser
 * Manages the popup UI state and communicates start/stop signals
 * to the content script via chrome.storage.local.
 */

'use strict';

// ─── DOM refs ────────────────────────────────────────────────────────────────
const btnStart      = document.getElementById('btnStart');
const statusCard    = document.getElementById('statusCard');
const statusDot     = document.getElementById('statusDot');
const statusValue   = document.getElementById('statusValue');
const counterPosted = document.getElementById('counterPosted');
const counterPending= document.getElementById('counterPending');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Syncs the popup UI to the current storage state.
 * @param {object} state - The chrome.storage.local snapshot.
 */
function renderUI(state) {
  const isActive = !!state.autoFillActive;

  // Button
  btnStart.textContent = isActive ? '⏹  Stop Automation' : '▶\u00A0\u00A0Start Auto-Fill';
  btnStart.className   = `btn-start ${isActive ? 'running' : 'idle'}`;

  // Status indicator
  statusDot.className  = `status-dot ${isActive ? 'active' : (state.autoFillComplete ? 'stopped' : '')}`;
  statusCard.className = `status-card ${isActive ? 'active' : (state.autoFillComplete ? 'stopped' : '')}`;

  if (state.autoFillComplete) {
    statusValue.textContent = '✅ All feedback submitted!';
  } else if (isActive) {
    statusValue.textContent = '🤖 Automation running…';
  } else {
    statusValue.textContent = 'Idle — waiting to start';
  }

  // Counters
  counterPosted.textContent  = state.submittedCount  ?? 0;
  counterPending.textContent = state.pendingCount != null ? state.pendingCount : '—';
}

/**
 * Reads current storage state and updates the UI.
 */
function refreshUI() {
  chrome.storage.local.get(
    ['autoFillActive', 'autoFillComplete', 'submittedCount', 'pendingCount'],
    renderUI
  );
}

// ─── Button click handler ─────────────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  const state = await chrome.storage.local.get(['autoFillActive']);

  if (state.autoFillActive) {
    // ── STOP ──────────────────────────────────────────────
    await chrome.storage.local.set({ autoFillActive: false });
    renderUI({ autoFillActive: false });
  } else {
    // ── START ─────────────────────────────────────────────
    // Clear any stale completion flag from a previous run
    await chrome.storage.local.set({
      autoFillActive:   true,
      autoFillComplete: false,
      submittedCount:   0,
      pendingCount:     null,
    });

    renderUI({ autoFillActive: true, submittedCount: 0 });

    // Signal the already-injected content script to start — NO reload.
    // Reloading triggers VTOP's multi-session guard and logs the user out.
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0) {
      const tabId = tabs[0].id;

      // Try messaging the already-injected content script first.
      chrome.tabs.sendMessage(tabId, { action: 'START_AUTOFILL' }, (response) => {
        if (chrome.runtime.lastError) {
          // sendMessage failed — content script is not present in this tab.
          // This happens when the extension is reloaded but the VTOP tab was
          // NOT refreshed afterward. Fix: inject content.js programmatically.
          // This does NOT reload the page, so no VTOP session risk.
          chrome.scripting.executeScript({
            target: { tabId },
            files:  ['content.js'],
          }).catch((err) => {
            console.error('[VTOP-Auto] executeScript error:', err);
          }).finally(() => {
            window.close();
          });
        } else {
          window.close();
        }
      });
    } else {
      window.close();
    }
  }
});

// ─── Storage change listener (live updates while popup is open) ───────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') refreshUI();
});

// ─── Initial render on popup open ────────────────────────────────────────────
refreshUI();

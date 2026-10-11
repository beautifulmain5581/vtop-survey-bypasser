/**
 * background.js — VTOP Survey Bypasser · Service Worker
 *
 * Monitors the active tab's URL at all times.
 * If the user navigates away from any *.vit.ac.in page,
 * or closes/switches to a non-VTOP tab, automation is
 * automatically disabled — no manual "Stop" required.
 */

const VTOP_HOSTNAME_PATTERN = /\.vit\.ac\.in$/i;

/**
 * Checks if a URL belongs to the VTOP domain.
 * @param {string} url
 * @returns {boolean}
 */
function isVtopUrl(url) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    return VTOP_HOSTNAME_PATTERN.test(hostname);
  } catch {
    return false;
  }
}

/**
 * Disables automation if the given URL is not a VTOP page.
 * @param {string|undefined} url
 */
async function checkAndDisable(url) {
  // Never disable on an unknown/empty URL — this happens during intermediate
  // navigation states (e.g. between VTOP pages) when tab.url is momentarily
  // undefined. Disabling here would kill the automation mid-loop.
  if (!url) return;
  if (isVtopUrl(url)) return; // Still on VTOP — do nothing.

  const state = await chrome.storage.local.get(['autoFillActive']);
  if (state.autoFillActive) {
    await chrome.storage.local.set({ autoFillActive: false });
  }
}

// ── Fires when a tab's URL changes (navigation, redirects) ────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only react to a confirmed, explicit URL change.
  // Generic 'loading'/'complete' status events without a URL change are
  // ignored — during those, tab.url can be undefined which would incorrectly
  // disable the automation mid VTOP-to-VTOP navigation.
  if (!changeInfo.url) return;

  chrome.tabs.query({ active: true, currentWindow: true }, (activeTabs) => {
    if (activeTabs.length > 0 && activeTabs[0].id === tabId) {
      checkAndDisable(changeInfo.url); // changeInfo.url is always defined here
    }
  });
});

// ── Fires when the user switches to a different tab ───────────────────────────
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    checkAndDisable(tab.url);
  });
});

// ── Fires when the user closes a tab entirely ─────────────────────────────────
chrome.tabs.onRemoved.addListener((_tabId, _removeInfo) => {
  // Check if any remaining active tab is still on VTOP
  chrome.tabs.query({ active: true, currentWindow: true }, (activeTabs) => {
    const url = activeTabs.length > 0 ? activeTabs[0].url : undefined;
    checkAndDisable(url);
  });
});

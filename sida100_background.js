// TextTV Extension – Background Service Worker
// Handles: cross-origin page fetching (CORS bypass), tab state persistence

// ─────────────────────────────────────────────────────────────────────────────
// State helpers via chrome.storage.session (survives SW restarts)
// ─────────────────────────────────────────────────────────────────────────────

async function getTabState(tabId) {
  const key = `tab_${tabId}`;
  const result = await chrome.storage.session.get(key);
  return result[key] || { active: false };
}

async function setTabState(tabId, state) {
  await chrome.storage.session.set({ [`tab_${tabId}`]: state });
}

// ─────────────────────────────────────────────────────────────────────────────
// Message listener
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Fetch a page on behalf of the content script (bypasses CORS)
  if (msg.action === 'fetchPage') {
    fetch(msg.url, {
      credentials: 'include',
      headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    })
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const contentType = r.headers.get('content-type') || '';
        const html = await r.text();
        return { html, finalUrl: r.url, contentType };
      })
      .then(res => sendResponse({
        success: true,
        html: res.html,
        finalUrl: res.finalUrl,
        contentType: res.contentType
      }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep message channel open for async response
  }

  // Set TextTV state for the sending tab
  if (msg.action === 'setState') {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      setTabState(tabId, { active: msg.active })
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
    } else {
      sendResponse({ ok: false });
    }
    return true;
  }

  // Get TextTV state for the sending tab
  if (msg.action === 'getState') {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      getTabState(tabId)
        .then(state => sendResponse({ active: state.active }))
        .catch(() => sendResponse({ active: false }));
    } else {
      sendResponse({ active: false });
    }
    return true;
  }

  // Get state for a specific tab (used by popup)
  if (msg.action === 'getStateForTab') {
    getTabState(msg.tabId)
      .then(state => sendResponse({ active: state.active }))
      .catch(() => sendResponse({ active: false }));
    return true;
  }

});

// ─────────────────────────────────────────────────────────────────────────────
// Auto-reactivate after navigation
// ─────────────────────────────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const state = await getTabState(tabId);
  if (!state.active) return;

  // Re-activate TextTV on the newly loaded page
  chrome.tabs.sendMessage(tabId, { action: 'reactivate' }).catch(() => {
    // Content script might not be ready yet – retry once after a short delay
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, { action: 'reactivate' }).catch(() => {});
    }, 500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Keyboard command listener (Alt+T / command defined in manifest)
// ─────────────────────────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async command => {
  if (command === 'toggle-sida100') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    const blocked = /^(chrome|chrome-extension|about|edge|data):/i;
    if (blocked.test(tab.url || '')) return;

    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'toggle' });
    } catch {
      // Content script not yet injected – inject and activate
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['sida100_content.js'],
        });
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ['sida100_content.css'],
        });
        await new Promise(r => setTimeout(r, 80));
        await chrome.tabs.sendMessage(tab.id, { action: 'activate' });
      } catch (err) {
        console.warn('[TextTV SW] Failed to inject on command:', err);
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Clean up on tab close
// ─────────────────────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove(`tab_${tabId}`);
});

/* ═══════════════════════════════════════════════════════════════════════════
   TextTV Extension – Popup Script
   ═══════════════════════════════════════════════════════════════════════════ */
(async () => {
  const toggleBtn = document.getElementById('toggleBtn');
  const statusEl  = document.getElementById('statusEl');
  const clockEl   = document.getElementById('popupClock');

  // ── Live clock ──────────────────────────────────────────────────────────
  function tickClock() {
    const d = new Date();
    const p = v => String(v).padStart(2, '0');
    clockEl.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  tickClock();
  setInterval(tickClock, 1000);

  // ── Get active tab ───────────────────────────────────────────────────────
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab) {
    statusEl.textContent = '✗ INGEN FLIK';
    statusEl.className   = 'status-value is-error';
    return;
  }

  // Block list – can't inject into these
  const blocked = /^(chrome|chrome-extension|about|edge|data):/i;
  if (blocked.test(tab.url || '')) {
    statusEl.textContent = '✗ EJ TILLÅTEN SIDA';
    statusEl.className   = 'status-value is-error';
    toggleBtn.disabled   = true;
    return;
  }

  // ── Sync state from content script ──────────────────────────────────────
  let isActive = false;

  async function syncStatus() {
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { action: 'getStatus' });
      isActive = resp?.active ?? false;
    } catch {
      // Content script not yet injected – state is inactive
      isActive = false;
    }
    renderUI();
  }

  function renderUI() {
    toggleBtn.disabled = false;
    if (isActive) {
      statusEl.textContent = '● AKTIV';
      statusEl.className   = 'status-value is-active';
      toggleBtn.textContent = '■ STÄNG SIDA 100';
      toggleBtn.className   = 'toggle-btn is-on';
    } else {
      statusEl.textContent = '○ INAKTIV';
      statusEl.className   = 'status-value';
      toggleBtn.textContent = '► AKTIVERA SIDA 100';
      toggleBtn.className   = 'toggle-btn';
    }
  }

  await syncStatus();

  // ── Toggle click ─────────────────────────────────────────────────────────
  toggleBtn.addEventListener('click', async () => {
    toggleBtn.disabled    = true;
    statusEl.textContent  = '… ARBETAR …';
    statusEl.className    = 'status-value';

    try {
      // Try to talk to the already-injected content script
      await chrome.tabs.sendMessage(tab.id, { action: 'toggle' });
    } catch {
      // Content script not present → inject it now, then activate
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['sida100_content.js'],
        });
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ['sida100_content.css'],
        });
        // Give it a moment to register its message listener
        await new Promise(r => setTimeout(r, 80));
        await chrome.tabs.sendMessage(tab.id, { action: 'activate' });
      } catch (err) {
        statusEl.textContent = '✗ KAN EJ KÖRAS';
        statusEl.className   = 'status-value is-error';
        toggleBtn.disabled   = false;
        console.error('[TextTV popup]', err);
        return;
      }
    }

    // Re-read actual state from content script instead of optimistic flip.
    // Guards against desync if activate() threw internally (replaceState etc.)
    await syncStatus();
  });

})();

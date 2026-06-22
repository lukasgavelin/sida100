# Privacy Policy – Sida 100 Chrome Extension

**Last updated: June 2026**

## Summary

Sida 100 does not collect, transmit, or sell any personal data whatsoever.

## Data Collection

Sida 100 does **not** collect any personal information. The extension:

- Does **not** track your browsing history
- Does **not** send any data to external servers
- Does **not** use analytics or telemetry
- Does **not** store any personal identifiers

## How the Extension Works

All processing happens entirely within your browser:

1. **Content transformation**: The extension reads the text content of the page you are visiting and re-renders it in a TextTV aesthetic. This processing is local and ephemeral.
2. **Tab state**: The extension stores whether TextTV mode is active per tab using `chrome.storage.session`. This data exists only in your current browser session and is cleared when you close the tab or restart Chrome.
3. **Page fetching**: When navigating same-domain links, the extension's background service worker fetches the target page on your behalf to bypass CORS restrictions. The fetched HTML is processed locally and never stored or sent elsewhere.

## Permissions Used

| Permission | Why it's needed |
|---|---|
| `activeTab` | To read and transform the current page |
| `scripting` | To inject the TextTV overlay into the page |
| `storage` | To remember if TextTV mode was active (session only) |
| `tabs` | To communicate between the popup and the active tab |
| `<all_urls>` (host permission) | To fetch same-domain pages for AJAX navigation |

## Third-Party Services

The extension bundles the **VT323** font locally. No requests are made to Google Fonts or any other external service during normal use.

## Contact

If you have any questions about this privacy policy, please open an issue at:  
https://github.com/lukasgavelin/sida100

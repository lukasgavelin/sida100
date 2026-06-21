/* ═══════════════════════════════════════════════════════════════════════════
   TextTV Extension – Content Script
   Transforms any web page into classic Teletext / TextTV aesthetic.

   Navigation strategy (Alt. D – Hybrid):
   • Same-domain links  → AJAX fetch via background SW (seamless, no reload)
   • External links     → Normal navigation + auto-reactivation on new page
   ═══════════════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  // Double-injection guard
  if (window.__texttvInit) return;
  window.__texttvInit = true;

  // ─────────────────────────────────────────────────────────────────────────
  // STATE
  // ─────────────────────────────────────────────────────────────────────────
  const S = {
    active: false,
    overlay: null,
    closeBtn: null,      // Close button – lives outside the overflow container
    links: new Map(),    // num  → absolute URL
    revLinks: new Map(), // URL  → num
    nextNum: 101,
    clockTimer: null,
    navAbort: null,      // AbortController for in-flight AJAX navigation
  };

  // ─────────────────────────────────────────────────────────────────────────
  // CONSTANTS & REGEXES
  // ─────────────────────────────────────────────────────────────────────────
  // Tags whose subtrees are always skipped wholesale
  const VOID_TAGS = new Set([
    'SCRIPT','STYLE','NOSCRIPT','IFRAME','OBJECT','EMBED',
    'FORM','INPUT','BUTTON','SELECT','TEXTAREA',
    'SVG','CANVAS','VIDEO','AUDIO','IMG','PICTURE','MAP','FIGURE',
  ]);

  // Semantic elements that are navigation / chrome (not page body)
  const CHROME_TAGS = new Set(['NAV','HEADER','FOOTER','ASIDE']);

  // Block-level tags used to distinguish "text-div" leaf nodes from containers
  // (handles Substack, Medium, Ghost, Notion — where body text lives in <div>s)
  const BLOCK_CHILD_TAGS = new Set(['DIV','SECTION','ARTICLE','MAIN','P','UL','OL',
    'DL','TABLE','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','PRE','FIGURE','HR']);

  // Class/id patterns that indicate non-content regions
  // Matches class/id names that reliably indicate non-content regions.
  // Deliberately avoids single words like "share", "social", "alert" that
  // appear legitimately in content class names (share-price, alert-level, etc.)
  const BAD_RE = /\b(navbar|nav-(?:bar|menu|wrapper|links|list)|menubar|main-nav|site-nav|top-nav|primary-nav|secondary-nav|sidebar|sticky-sidebar|cookie-(?:bar|notice|consent|banner|wall|overlay)|advert(?:isement)?|adsense|dfp-|social-share|share-(?:btn|button|bar|icon|link)s?|toolbar|breadcrumb|paginat(?:ion|or)|related-(?:post|article|content)s?|promo-(?:bar|banner)|widget-area|modal-(?:overlay|wrapper|dialog)|popup-(?:overlay|wrapper)|notif(?:ication)?-(?:bar|popup|toast|banner)|alert-(?:bar|banner|box)|skip-(?:link|nav)|sr-only|visually-hidden|print-only|offscreen|carousel|malservice|m\u00e5lservice|scoreboard|fixtures)\b/i;

  // URL path segments that are clearly navigation / utility, not content
  // Matches nav/utility path segments anywhere in the URL (e.g. /en/login, /user/privacy)
  const FOOTER_SKIP_RE = /(?:^|\/)(?:log(?:in|out|ga[-_]in)|sign[-_]?(?:in|up|out)|registr|cookie|privacy|integritet|villkor|terms|impressum|gdpr|about|om[-_]oss|contact|kontakt|help|hj(?:\u00e4|a)lp|faq|search|s[\u00f6o]k|404|sitemap|accessibility|tillg(?:\u00e4|a)nglighet)(?:\/|\?|$)/i;

  // MediaWiki/Wiki namespace prefixes or other special paths to skip in site navigation
  const NAV_SKIP_RE = /(?:^|\/|:)(?:special|wikipedia|hj(?:a|\u00e4)lp|kategori|portal|diskussion|anv(?:a|\u00e4)ndare|mall|fil|category|help|talk|user|template|file)(?::|%3A)/i;

  // Link text patterns that indicate utility/navigation items we want to filter out
  const NAV_TEXT_SKIP_RE = /(?:ladda (?:ned|ner)|download|skriv ut|print|pdf|skapa (?:en )?bok|logg?a? in|sign in|skapa konto|create account|specialsidor|special pages|allm\u00e4nt f\u00f6rbeh\u00e5ll|donera|st\u00f6d|donate|om wikipedia|about wikipedia|kontakta|senaste \u00e4ndringar|slumpm\u00e4ssig|hj(?:\u00e4|a)lp|nyhetsbrev|kundsupport|kundtj\u00e4nst|kundservice|prenumerera|prenumeration|erbjudande|erbjudanden|digitala magasin|historiska arkivet|\u00f6versikt|kontoinst\u00e4llningar|sekretessinst\u00e4llningar|e-tidning|k\u00f6p plus|annonsera|tipsa)/i;

  // ─────────────────────────────────────────────────────────────────────────
  // FONT LOADER  (inject VT323 from Google Fonts; falls back to Courier New)
  // ─────────────────────────────────────────────────────────────────────────
  function injectFont() {
    if (document.getElementById('__ttv_gfont')) return;
    const link = document.createElement('link');
    link.id   = '__ttv_gfont';
    link.rel  = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=VT323&display=swap';
    (document.head || document.documentElement).appendChild(link);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────
  function make(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls)            el.className   = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function resolveURL(href, base) {
    if (!href || !href.trim()) return null;
    if (href.startsWith('javascript:') || href.startsWith('#')) return null;
    try { return new URL(href, base).href; } catch { return null; }
  }

  function getLinkNum(absUrl) {
    if (S.revLinks.has(absUrl)) return S.revLinks.get(absUrl);
    const n = S.nextNum++;
    S.links.set(n, absUrl);
    S.revLinks.set(absUrl, n);
    return n;
  }

  function sameDomain(url) {
    try { return new URL(url).hostname === location.hostname; }
    catch { return false; }
  }

  /**
   * Extract text content from a DOM node while ensuring proper spacing
   * between adjacent elements (e.g. "VM<span>Belgisk</span>" -> "VM Belgisk").
   * Respects punctuation rules to avoid adding spaces before periods, commas, etc.
   */
  function getSpacedText(el) {
    function walk(node) {
      if (node.nodeType === 3) {
        return node.textContent;
      }
      if (node.nodeType !== 1) {
        return '';
      }
      if (VOID_TAGS.has(node.tagName)) {
        return '';
      }
      let text = '';
      for (const child of node.childNodes) {
        const childText = walk(child);
        if (!childText) continue;
        if (text && !text.endsWith(' ') && !childText.startsWith(' ')) {
          const noSpaceBefore = /^[.,?!:;)}\]]/;
          const noSpaceAfter = /[({\[]$/;
          if (noSpaceBefore.test(childText) || noSpaceAfter.test(text)) {
            text += childText;
          } else {
            text += ' ' + childText;
          }
        } else {
          text += childText;
        }
      }
      return text;
    }
    return walk(el).replace(/\s+/g, ' ').trim();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SITE-SPECIFIC OVERRIDES & CONFIGURATIONS
  // ─────────────────────────────────────────────────────────────────────────
  const SITE_CONFIGS = {
    'aftonbladet.se': {
      badSelectors: [
        '.abSportWidget',
        '.abCarousel',
        '[class*="malservice"]',
        '[id*="malservice"]'
      ]
    },
    'expressen.se': {
      badSelectors: [
        '.expressen-tv',
        '.most-read',
        '.popular',
        '.live-widget',
        '[class*="fixtures"]',
        '[class*="scoreboard"]'
      ]
    },
    'svt.se': {
      badSelectors: [
        '.play-widget',
        '.svtplay-link'
      ]
    },
    'dn.se': {
      badSelectors: [
        '.paywall',
        '.premium-paywall',
        '.premium-lock',
        '.paywall-container',
        '[class*="paywall"]',
        '[class*="premium-lock"]'
      ]
    },
    'svd.se': {
      badSelectors: [
        '.paywall',
        '.svd-premium',
        '[class*="paywall"]',
        '.premium-lock'
      ]
    },
    'gp.se': {
      badSelectors: [
        '.paywall',
        '.premium',
        '[class*="paywall"]'
      ]
    },
    'omni.se': {
      badSelectors: [
        '.omni-upsell',
        '.premium-block'
      ]
    },
    'tv4.se': {
      badSelectors: [
        '.video-player',
        '.player-container',
        '.tv4-play-link',
        '.tv4-video-widget'
      ]
    },
    'di.se': {
      badSelectors: [
        '.di_ticker',
        '.di_market-ticker',
        '[class*="ticker"]',
        '.di_news-ticker'
      ],
      badNavText: ['logotyper', 'kundservice']
    },
    'sydsvenskan.se': {
      badSelectors: [
        '.paywall',
        '.premium-paywall',
        '.premium-lock',
        '.paywall-container',
        '[class*="paywall"]'
      ]
    }
  };

  /** Get active site configuration matching the current host. */
  let _activeConfig = null;
  function getActiveConfig() {
    if (_activeConfig !== null) return _activeConfig;
    const host = location.hostname;
    for (const [domain, cfg] of Object.entries(SITE_CONFIGS)) {
      if (host === domain || host.endsWith('.' + domain)) {
        _activeConfig = cfg;
        return _activeConfig;
      }
    }
    _activeConfig = false; // none found
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CONTENT EXTRACTION
  // ─────────────────────────────────────────────────────────────────────────

  // (Tag and class constants have been moved to the top of the file)

  function isBad(el) {
    if (!el || el.nodeType !== 1)         return false;

    // Apply site-specific badSelectors check
    const cfg = getActiveConfig();
    if (cfg && cfg.badSelectors) {
      for (const sel of cfg.badSelectors) {
        try {
          if (el.matches(sel)) return true;
        } catch {}
      }
    }

    if (VOID_TAGS.has(el.tagName))        return true;
    if (CHROME_TAGS.has(el.tagName))      return true;
    const role = el.getAttribute('role') || '';
    if (/^(navigation|banner|complementary|search|form|dialog|alertdialog)$/.test(role)) return true;
    const combo = (el.className || '') + ' ' + (el.id || '');
    if (BAD_RE.test(combo))               return true;
    if (el.hidden)                        return true;
    // Use getAttribute('style') — works correctly on both live DOM and
    // DOMParser documents (el.style may not reflect attribute values in the latter)
    const inlineStyle = el.getAttribute('style') || '';
    if (/display\s*:\s*none/i.test(inlineStyle) || /visibility\s*:\s*hidden/i.test(inlineStyle)) return true;
    return false;
  }

  /** Find the best "main content" element in a document. */
  function findMain(doc) {
    const cfg = getActiveConfig();
    if (cfg && cfg.mainSelector) {
      try {
        const el = doc.querySelector(cfg.mainSelector);
        if (el) return el;
      } catch {}
    }

    const tries = [
      'main', '[role="main"]', 'article',
      '#content', '#main', '#main-content',
      '.post-content', '.article-body', '.entry-content',
      '.page-content', '.article', '.post', '.entry', '.content',
    ];
    for (const s of tries) {
      try {
        const el = doc.querySelector(s);
        if (el) return el;
      } catch {}
    }
    return doc.body || doc.documentElement;
  }

  /** Collect inline tokens from an element (text, links, bold, em, code). */
  function collectInline(el, baseUrl, _depth = 0) {
    if (_depth > 20) return []; // Guard against pathological DOM nesting
    const parts = [];
    const noSpaceBefore = /^[.,?!:;)}\]]/;
    const noSpaceAfter = /[({\[]$/;

    for (const node of el.childNodes) {
      const nodeParts = [];
      if (node.nodeType === 3) {                    // text node
        const v = node.textContent.replace(/\s+/g, ' ');
        if (v.trim()) nodeParts.push({ t: 'text', v });
      } else if (node.nodeType === 1) {
        const tag = node.tagName;
        if (!VOID_TAGS.has(tag)) {
          if (tag === 'A') {
            const text = getSpacedText(node);
            if (text) {
              const raw  = node.getAttribute('href');
              const href = resolveURL(raw, baseUrl);
              if (href) {
                nodeParts.push({ t: 'link', v: text, href, num: getLinkNum(href) });
              } else {
                nodeParts.push({ t: 'text', v: text + ' ' });
              }
            }
          } else if (tag === 'STRONG' || tag === 'B') {
            const v = getSpacedText(node);
            if (v) nodeParts.push({ t: 'bold', v });
          } else if (tag === 'EM' || tag === 'I') {
            const v = getSpacedText(node);
            if (v) nodeParts.push({ t: 'em', v });
          } else if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') {
            const v = getSpacedText(node);
            if (v) nodeParts.push({ t: 'code', v });
          } else if (tag === 'BR') {
            nodeParts.push({ t: 'br' });
          } else {
            // Recurse into generic inline containers (span, label, etc.)
            nodeParts.push(...collectInline(node, baseUrl, _depth + 1));
          }
        }
      }

      if (nodeParts.length) {
        if (parts.length) {
          const lastPart = parts[parts.length - 1];
          const firstNew = nodeParts[0];
          const lastVal = lastPart.v || '';
          const newVal = firstNew.v || '';

          if (lastPart.t !== 'br' && firstNew.t !== 'br' && lastVal && newVal) {
            if (!lastVal.endsWith(' ') && !newVal.startsWith(' ') &&
                !noSpaceBefore.test(newVal) && !noSpaceAfter.test(lastVal)) {
              parts.push({ t: 'text', v: ' ' });
            }
          }
        }
        parts.push(...nodeParts);
      }
    }
    return parts;
  }

  /** Walk a DOM element tree and emit structured content items. */
  function walkEl(el, items, baseUrl, depth = 0) {
    if (depth > 35 || !el || el.nodeType !== 1) return;
    if (isBad(el)) return;

    const tag = el.tagName;

    // ── Headings ────────────────────────────────────────────────────────────
    if (/^H([1-6])$/.test(tag)) {
      const level = +tag[1];
      const text  = getSpacedText(el);
      if (text.length > 1) items.push({ t: 'h', level, text });
      return;
    }

    // ── Paragraphs ───────────────────────────────────────────────────────────
    if (tag === 'P') {
      const text  = getSpacedText(el);
      if (text.length < 2) return;
      const parts = collectInline(el, baseUrl);
      if (parts.length) items.push({ t: 'p', parts });
      return;
    }

    // ── Lists ────────────────────────────────────────────────────────────────
    if (tag === 'UL' || tag === 'OL') {
      const liItems = [];
      let idx = 1;
      el.querySelectorAll(':scope > li').forEach(li => {
        const text  = getSpacedText(li);
        if (!text) return;
        const parts = collectInline(li, baseUrl);
        liItems.push({ parts, idx: tag === 'OL' ? idx++ : null });
      });
      if (liItems.length) items.push({ t: 'list', ordered: tag === 'OL', items: liItems });
      return;
    }

    // ── Tables ───────────────────────────────────────────────────────────────
    if (tag === 'TABLE') {
      const rows = [];
      el.querySelectorAll('tr').forEach(tr => {
        const cells = [];
        tr.querySelectorAll('th, td').forEach(td => {
          const text = getSpacedText(td);
          if (text) cells.push({ text, hdr: td.tagName === 'TH' });
        });
        if (cells.length) rows.push(cells);
      });
      if (rows.length) items.push({ t: 'table', rows });
      return;
    }

    // ── Blockquotes ──────────────────────────────────────────────────────────
    if (tag === 'BLOCKQUOTE') {
      const text = getSpacedText(el);
      if (text.length > 1) items.push({ t: 'quote', text });
      return;
    }

    // ── Pre / code blocks ────────────────────────────────────────────────────
    if (tag === 'PRE') {
      const text = getSpacedText(el);
      if (text) items.push({ t: 'pre', text });
      return;
    }

    // ── Horizontal rule ──────────────────────────────────────────────────────
    if (tag === 'HR') {
      items.push({ t: 'hr' });
      return;
    }

    // ── Generic container ────────────────────────────────────────────────────
    // If this element has no block-level children it is a "text-div" —
    // all content is inline (text + spans). Treat it as a paragraph.
    // This covers Substack, Medium, Ghost, Notion and many modern CMS:es.
    const hasBlockChild = [...el.children].some(c => BLOCK_CHILD_TAGS.has(c.tagName));
    if (!hasBlockChild) {
      const text = getSpacedText(el);
      if (text.length > 15) {
        const parts = collectInline(el, baseUrl);
        if (parts.length) { items.push({ t: 'p', parts }); return; }
      }
    }
    for (const child of el.children) {
      walkEl(child, items, baseUrl, depth + 1);
    }
  }

  /** Full content extraction entry point. */
  function extractContent(doc, baseUrl) {
    S.links.clear();
    S.revLinks.clear();
    S.nextNum = 101;

    const title = doc.title || location.hostname;
    const main  = findMain(doc);
    const items = [];
    walkEl(main, items, baseUrl);
    const navLinks = extractNavLinks(doc, baseUrl);

    return { title, items, navLinks };
  }

  /**
   * Extract clickable links from the site’s navigation elements.
   * These are intentionally excluded from main content extraction but are
   * valuable for user navigation in the TextTV overlay.
   */
  function extractNavLinks(doc, baseUrl) {
    const seen  = new Set();
    const links = [];
    const cfg   = getActiveConfig();
    const selectors = [
      'nav a', '[role="navigation"] a',
      'header a', '.site-nav a', '.main-nav a', '.primary-nav a',
    ];
    for (const sel of selectors) {
      try {
        doc.querySelectorAll(sel).forEach(a => {
          const text = a.textContent.replace(/\s+/g, ' ').trim();
          if (!text || text.length < 2 || text.length > 35) return;
          if (NAV_TEXT_SKIP_RE.test(text)) return;
          if (cfg && cfg.badNavText) {
            if (cfg.badNavText.some(term => text.toLowerCase().includes(term.toLowerCase()))) return;
          }
          const href = resolveURL(a.getAttribute('href'), baseUrl);
          if (!href || seen.has(href)) return;
          try {
            const u = new URL(href);
            if (FOOTER_SKIP_RE.test(u.pathname) || NAV_SKIP_RE.test(u.pathname)) return;
          } catch {
            return;
          }
          seen.add(href);
          links.push({ text: text.toUpperCase(), href, num: getLinkNum(href) });
        });
      } catch {}
      if (links.length >= 8) break;
    }
    return links.slice(0, 8);
  }

  /** Build a TextTV-style navigation bar from extracted nav links. */
  function buildNavBar(navLinks) {
    if (!navLinks || !navLinks.length) return null;
    const bar = make('div', '__ttv-navbar');
    navLinks.forEach(({ text, href, num }) => {
      const item = make('span', '__ttv-nav-item', `${text} ►${num}`);
      item.dataset.href = href;
      bar.appendChild(item);
    });
    return bar;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RENDERING
  // ─────────────────────────────────────────────────────────────────────────

  function renderInline(parts) {
    const frag = document.createDocumentFragment();
    for (const p of parts) {
      switch (p.t) {
        case 'text':
          frag.appendChild(document.createTextNode(p.v));
          break;
        case 'link': {
          const wrap = make('span', '__ttv-link');
          wrap.appendChild(document.createTextNode(p.v));
          const badge = make('sup', '__ttv-badge', '►' + p.num);
          wrap.appendChild(badge);
          wrap.dataset.href = p.href;
          frag.appendChild(wrap);
          break;
        }
        case 'bold':
          frag.appendChild(make('span', '__ttv-bold', p.v));
          break;
        case 'em':
          frag.appendChild(make('span', '__ttv-em', p.v));
          break;
        case 'code':
          frag.appendChild(make('span', '__ttv-code', p.v));
          break;
        case 'br':
          frag.appendChild(document.createElement('br'));
          break;
      }
    }
    return frag;
  }

  function renderContentArea(content) {
    const wrap = make('div', '__ttv-content');

    if (!content.items.length) {
      wrap.appendChild(make('div', '__ttv-empty', '*** INGEN TEXT HITTADES PÅ DENNA SIDA ***'));
      return wrap;
    }

    for (const item of content.items) {
      switch (item.t) {

        case 'h': {
          const el = make('div', `__ttv-h __ttv-h${item.level}`);
          el.textContent = item.level === 1 ? item.text.toUpperCase() : item.text;
          wrap.appendChild(el);
          break;
        }

        case 'p': {
          const el = make('div', '__ttv-p');
          el.appendChild(renderInline(item.parts));
          wrap.appendChild(el);
          break;
        }

        case 'list': {
          const el = make('div', '__ttv-list');
          item.items.forEach(li => {
            const row  = make('div', '__ttv-li');
            const pfx  = make('span', '__ttv-li-pfx');
            pfx.textContent = li.idx != null ? li.idx + '.' : '■';
            const body = make('span', '__ttv-li-text');
            body.appendChild(renderInline(li.parts));
            row.appendChild(pfx);
            row.appendChild(body);
            el.appendChild(row);
          });
          wrap.appendChild(el);
          break;
        }

        case 'table': {
          const el = make('div', '__ttv-table');
          item.rows.forEach(row => {
            const rowEl = make('div', '__ttv-tr');
            row.forEach(cell => {
              rowEl.appendChild(make('span', cell.hdr ? '__ttv-th' : '__ttv-td', cell.text));
            });
            el.appendChild(rowEl);
          });
          wrap.appendChild(el);
          break;
        }

        case 'quote': {
          wrap.appendChild(make('div', '__ttv-quote', '» ' + item.text));
          break;
        }

        case 'pre': {
          wrap.appendChild(make('div', '__ttv-pre', item.text));
          break;
        }

        case 'hr': {
          wrap.appendChild(make('div', '__ttv-hr'));
          break;
        }
      }
    }
    return wrap;
  }

  // (FOOTER_SKIP_RE is defined above)

  function buildFooter() {
    const ftr = make('div', '__ttv-ftr');
    const allEntries = [...S.links.entries()];

    // Prefer links that are not navigation/utility pages
    const filtered = allEntries.filter(([, url]) => {
      try {
        const u = new URL(url);
        if (u.pathname.length <= 1 && !u.search) return false; // root "/" links
        if (FOOTER_SKIP_RE.test(u.pathname))     return false;
        return true;
      } catch { return false; }
    });

    const entries = (filtered.length > 0 ? filtered : allEntries).slice(0, 6);

    if (entries.length) {
      entries.forEach(([num, url]) => {
        try {
          const name = new URL(url).hostname
            .replace('www.', '')
            .split('.')[0]
            .toUpperCase()
            .slice(0, 9);
          const span = make('span', '__ttv-ftr-link', `${name} ${num}`);
          span.dataset.href = url;
          ftr.appendChild(span);
        } catch {}
      });
    } else {
      ftr.textContent = location.hostname.replace('www.', '').toUpperCase() + '  ►100';
    }
    return ftr;
  }

  function buildOverlay(content) {
    const ov = document.createElement('div');
    ov.id = '__texttvOv';

    // CRT scanlines
    ov.appendChild(make('div', '__ttv-crt'));

    // Screen
    const screen = make('div', '__ttv-screen');

    // Header
    const hdr = make('div', '__ttv-hdr');
    const numEl  = make('span', '__ttv-hdr-num',  '100');
    const siteEl = make('span', '__ttv-hdr-site', location.hostname.replace('www.', ''));
    const timeEl = make('span', '__ttv-hdr-time', '');
    timeEl.id = '__ttv_clock';
    hdr.appendChild(numEl);
    hdr.appendChild(siteEl);
    hdr.appendChild(timeEl);
    screen.appendChild(hdr);

    // Title bar
    screen.appendChild(make('div', '__ttv-titlebar', content.title));

    // URL breadcrumb
    screen.appendChild(make('div', '__ttv-urlbar', location.href));

    // Site navigation bar (links from <nav>/<header>)
    const navBar = buildNavBar(content.navLinks);
    if (navBar) screen.appendChild(navBar);

    // Content
    screen.appendChild(renderContentArea(content));

    // Loading indicator – shown during AJAX navigation.
    // Must precede the sticky footer so it renders inside the scrollable area.
    const loader = make('div', '__ttv-loader', '*** LADDAR SIDA … ***');
    loader.id = '__ttv_loader';
    screen.appendChild(loader);

    // Footer – sticky bottom, must be the last child in screen for correct positioning.
    screen.appendChild(buildFooter());

    ov.appendChild(screen);

    // Delegated click handler for all [data-href] links
    ov.addEventListener('click', e => {
      const target = e.target.closest('[data-href]');
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      navigate(target.dataset.href);
    });

    return ov;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CLOCK
  // ─────────────────────────────────────────────────────────────────────────
  const DAYS   = ['sön','mån','tis','ons','tor','fre','lör'];
  const MONTHS = ['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'];

  function tickClock() {
    const el = document.getElementById('__ttv_clock');
    if (!el) return;
    const d  = new Date();
    const p  = v => String(v).padStart(2, '0');
    el.textContent =
      `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` +
      `  ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // NAVIGATION – Alt. D (Hybrid)
  // ─────────────────────────────────────────────────────────────────────────

  function showLoader(show) {
    const el = document.getElementById('__ttv_loader');
    if (el) el.style.display = show ? 'block' : 'none';
  }

  async function navigate(url) {
    if (sameDomain(url)) {
      await navigateAjax(url);
    } else {
      navigateExternal(url);
    }
  }

  async function navigateAjax(url) {
    // Cancel any previous in-flight navigation so stale responses are never rendered
    if (S.navAbort) S.navAbort.abort();
    const abort = new AbortController();
    S.navAbort = abort;

    showLoader(true);
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'fetchPage', url });
      if (abort.signal.aborted) return; // superseded by a newer navigation

      if (!resp || !resp.success) throw new Error(resp?.error || 'fetch failed');

      const parser = new DOMParser();
      const doc    = parser.parseFromString(resp.html, 'text/html');
      if (abort.signal.aborted) return; // check again after (potentially slow) parsing

      // Ensure relative URLs resolve against the fetched page's URL
      const base  = doc.createElement('base');
      base.href   = url;
      doc.head.insertBefore(base, doc.head.firstChild);

      // Update browser history so Back/Forward work
      history.pushState({ __ttv: url }, doc.title || '', url);

      redraw(doc, url);
    } catch (err) {
      if (abort.signal.aborted) return;
      console.warn('[TextTV] AJAX nav failed, falling back to normal navigation:', err.message);
      navigateExternal(url);
    } finally {
      showLoader(false);
      if (S.navAbort === abort) S.navAbort = null;
    }
  }

  function navigateExternal(url) {
    // Mark TextTV as still active for the next page load
    chrome.runtime.sendMessage({ action: 'setState', active: true }).catch(() => {});
    location.href = url;
  }

  /**
   * Re-render overlay DOM from already-extracted content.
   * Does NOT call extractContent — caller owns that step.
   */
  function redrawContent(content) {
    const ov = S.overlay;
    if (!ov) return;

    const titleBar = ov.querySelector('.__ttv-titlebar');
    if (titleBar) titleBar.textContent = content.title;

    const urlBar = ov.querySelector('.__ttv-urlbar');
    if (urlBar) urlBar.textContent = location.href;

    // Update site nav bar
    const oldNav = ov.querySelector('.__ttv-navbar');
    const newNav = buildNavBar(content.navLinks);
    if (oldNav && newNav)   oldNav.replaceWith(newNav);
    else if (!oldNav && newNav) { const ub = ov.querySelector('.__ttv-urlbar'); ub?.after(newNav); }
    else if (oldNav && !newNav) oldNav.remove();

    const oldContent = ov.querySelector('.__ttv-content');
    const newContent = renderContentArea(content);
    if (oldContent) oldContent.replaceWith(newContent);
    else ov.querySelector('.__ttv-screen')?.insertBefore(newContent, ov.querySelector('.__ttv-ftr'));

    const oldFtr = ov.querySelector('.__ttv-ftr');
    if (oldFtr) oldFtr.replaceWith(buildFooter());

    ov.scrollTop = 0;
  }

  /** Re-render overlay after AJAX navigation (extracts content from fetched doc). */
  function redraw(doc, baseUrl) {
    redrawContent(extractContent(doc, baseUrl));
  }

  // Handle browser Back/Forward after AJAX navigation
  window.addEventListener('popstate', e => {
    if (S.active && e.state?.__ttv) {
      navigateAjax(e.state.__ttv).catch(() => {});
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ACTIVATE / DEACTIVATE / TOGGLE
  // ─────────────────────────────────────────────────────────────────────────

  function activate() {
    if (S.active) return;
    S.active = true;
    injectFont();

    // Tag the current history entry with __ttv state so Back navigation always
    // has a state object to trigger the popstate handler (including the first page).
    try {
      history.replaceState({ __ttv: location.href }, document.title, location.href);
    } catch {
      // SecurityError on file://, blob:, data: URLs — safe to ignore
    }

    const content = extractContent(document, location.href);
    S.overlay = buildOverlay(content);
    document.documentElement.appendChild(S.overlay);

    const closeBtn = make('button', '__ttv-close', '✕  STÄNG SIDA 100');
    closeBtn.addEventListener('click', deactivate);
    document.documentElement.appendChild(closeBtn);
    S.closeBtn = closeBtn;



    tickClock();
    S.clockTimer = setInterval(tickClock, 1000);

    // SPA: if page rendered no content yet (JS hasn't run), retry after delays
    if (!content.items.length) scheduleSPARetry();

    chrome.runtime.sendMessage({ action: 'setState', active: true }).catch(() => {});
  }

  /**
   * On JS-rendered (SPA) pages the DOM is empty at document_idle.
   * Schedules retries at increasing delays. Uses a `done` flag so only the
   * first successful retry fires; later timers short-circuit.
   * Calls redrawContent() with the already-extracted content to avoid a
   * redundant second extractContent pass.
   */
  function scheduleSPARetry() {
    let done = false;
    [600, 1800, 4500].forEach(delay => {
      setTimeout(() => {
        if (done || !S.active || !S.overlay) return;
        // Short-circuit if content already appeared (retry or link click filled it)
        if (!S.overlay.querySelector('.__ttv-empty')) { done = true; return; }
        const content = extractContent(document, location.href);
        if (content.items.length > 0) {
          done = true;
          redrawContent(content); // no second extractContent pass
        }
      }, delay);
    });
  }

  function deactivate() {
    if (!S.active) return;
    S.active = false;

    S.overlay?.remove();
    S.overlay = null;
    S.closeBtn?.remove();
    S.closeBtn = null;

    clearInterval(S.clockTimer);

    chrome.runtime.sendMessage({ action: 'setState', active: false }).catch(() => {});
  }

  function toggle() {
    if (S.active) deactivate(); else activate();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MESSAGE LISTENER  (from popup and background SW)
  // ─────────────────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.action) {
      case 'toggle':     toggle();                               sendResponse({ ok: true }); break;
      case 'activate':   activate();                             sendResponse({ ok: true }); break;
      case 'deactivate': deactivate();                           sendResponse({ ok: true }); break;
      case 'reactivate': if (!S.active) activate();             sendResponse({ ok: true }); break;
      case 'getStatus':                                          sendResponse({ active: S.active }); break;
      default:           sendResponse({ ok: false });
    }
    return false; // synchronous responses
  });

  // ─────────────────────────────────────────────────────────────────────────
  // KEYBOARD SHORTCUT  Alt+T
  // ─────────────────────────────────────────────────────────────────────────

  document.addEventListener('keydown', e => {
    if (e.altKey && (e.key === 't' || e.key === 'T')) {
      e.preventDefault();
      toggle();
    }
  }, true);

  // ─────────────────────────────────────────────────────────────────────────
  // AUTO-ACTIVATE  (re-activates after external link navigation)
  // ─────────────────────────────────────────────────────────────────────────

  chrome.runtime.sendMessage({ action: 'getState' })
    .then(resp => { if (resp?.active) activate(); })
    .catch(() => {});

})();

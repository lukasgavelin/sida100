# Sida 100

> Förvandla vilken webbsida som helst till klassisk TextTV/Teletext-estetik – direkt i Chrome.

![Sida 100 icon](sida100_icons/sida100_icon128.png)

---

## Vad är det här?

**Sida 100** är ett Chrome-tillägg som omvandlar valfri webbsida till retro-TextTV-format med ett knapptryck. Text, rubriker, listor och tabeller extraheras och presenteras i VT323-typografi med blå headers och gul text – precis som SVT Text TV från 90-talet.

---

## Funktioner

- **Ett klick** för att aktivera/avaktivera på valfri sida
- **Alt+T** som tangentbordsgenväg
- **AJAX-navigering** på samma domän – inga sidomladdningar
- **Automatisk återaktivering** efter externa länkhopp
- **SPA-stöd** (React, Vue, Next.js m.fl.) via MutationObserver
- **Realtidsklocka** i TextTV-stil
- **CRT scanlines-effekt** för äkta retro-känsla
- **Webbplatsspecifika optimeringar** för bl.a. Aftonbladet, DN, SVT, Expressen, DI, Omni

---

## Installation

### Från Chrome Web Store
*(Kommer snart)*

### Manuellt (developer mode)
1. Ladda ner eller klona det här repot
2. Gå till `chrome://extensions` i Chrome
3. Aktivera **Developer mode** (övre högra hörnet)
4. Klicka **Ladda upp packat tillägg** och välj projektmappen

---

## Användning

| Åtgärd | Hur |
|--------|-----|
| Aktivera Sida 100 | Klicka på ikonen i verktygsfältet → **AKTIVERA SIDA 100** |
| Stäng | Klicka på **✕ STÄNG SIDA 100**-knappen (nere till höger på sidan) |
| Tangentbordsgenväg | **Alt+T** |
| Navigera via länk | Klicka på länknumret (t.ex. `►103`) i overlay:n |

---

## Integritet

Sida 100 samlar inte in, skickar inte eller säljer någon data. All bearbetning sker lokalt i webbläsaren.

→ [Fullständig sekretesspolicy](store_assets/privacy_policy.md)

---

## Projektstruktur

```
sida100/
├── manifest.json # Tilläggskonfiguration (Manifest V3)
├── sida100_content.js # Content script – extraherar och renderar TextTV-overlay
├── sida100_content.css # Stilar för overlay:n
├── sida100_background.js # Service worker – hanterar CORS-fetch och tab-state
├── fonts/
│ └── VT323-Regular.ttf # Lokal kopia av VT323-fonten
├── sida100_icons/ # Ikoner i 16, 48 och 128 px
├── sida100_popup/ # Popup-UI (HTML, CSS, JS)
├── _locales/ # Lokalisering (sv, en)
└── store_assets/ # Chrome Web Store-material
 ├── description_sv.txt
 ├── privacy_policy.md
 └── sida100_chrome_extension.zip
```

---

## Licens

MIT

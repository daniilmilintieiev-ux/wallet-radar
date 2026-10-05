# Wallet Radar Brand Guidelines

> **Concept:** *"The gate before the trade"* + continuous radar anomaly detection.  
> Flat, geometric, sharp-cornered terminal aesthetics without shadows, radii, or gradients.

---

## 1. Brand Palette

| Role | Color Name | HEX | RGB | HSL | Contrast vs `#0a0a0b` | Contrast vs `#ffffff` |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Primary Background** | Obsidian Dark | `#0a0a0b` | `rgb(10, 10, 11)` | `hsl(240, 5%, 4%)` | 1.0:1 | 19.8:1 (AAA) |
| **Brand Accent** | Radar Amber | `#ffb000` | `rgb(255, 176, 0)` | `hsl(41, 100%, 50%)` | **10.8:1 (AAA)** | 1.8:1 |
| **Primary Text / Light** | Crisp White | `#f1f1ee` | `rgb(241, 241, 238)` | `hsl(60, 10%, 94%)` | **17.5:1 (AAA)** | 1.1:1 |
| **Muted Text** | Terminal Slate | `#8b949e` | `rgb(139, 148, 158)` | `hsl(212, 9%, 58%)` | **6.4:1 (AA)** | 3.1:1 |
| **Structural Border** | Border Dark | `#21262d` | `rgb(33, 38, 45)` | `hsl(215, 15%, 15%)` | 1.3:1 | 15.2:1 (AAA) |

All primary foreground colors exceed the WCAG AA minimum contrast ratio (4.5:1), with accent and text exceeding the WCAG AAA requirement (7.0:1) on `#0a0a0b`.

---

## 2. Typography

1. **Wordmark & Headlines:**  
   - Font: **Big Shoulders Display 800 (ExtraBold)**  
   - Characteristics: Ultra-condensed, geometric, all uppercase.  
   - Pre-rendered as vector SVG curves in all production brand assets (no `<text>` dependencies).
2. **Tagline & Technical Information:**  
   - Font: **JetBrains Mono 400 (Regular) / 500 (Medium)**  
   - Tagline: `"The gate before you copy"`  
   - Characteristics: Monospaced developer typography.

---

## 3. Mark Geometry & Construction

The brand mark is constructed on a **64x64 pixel grid**:
- **Uniform Stroke:** Exact 4px stroke width across all lines (`stroke-linecap="butt"`, `stroke-linejoin="miter"`).
- **Square Frame:** Outer boundary $[4, 60] \times [4, 60]$ with sharp $90^\circ$ corners.
- **The Gate:** A 16px vertical gap centered on the right edge (from $y=24$ to $y=40$) representing the pre-trade clearance threshold.
- **Radar Sector:** Quarter-circle arc ($R=38$) sweeping from bottom-left frame corner $(6, 58)$ to $(6, 20)$ and $(44, 58)$.
- **Beam Ray:** $45^\circ$ diagonal sweep ray from $(6, 58)$ to $(32.87, 31.13)$.
- **Target Blip:** Sharp 6x6 square blip at $(42, 22)$ positioned directly in front of the gate passage.
- **Zero Radii, Zero Shadows:** Strictly flat, no corner rounding, no drop shadows, no gradients.

---

## 4. Asset Manifest

### Vector SVGs (All `< 8 KB`, Zero `<text>` tags)
- [`mark.svg`](./mark.svg) (490 B) — Primary mark in Radar Amber (`#ffb000`) on transparent background.
- [`mark-mono-dark.svg`](./mark-mono-dark.svg) (490 B) — Monochrome dark mark (`#0a0a0b`) for white/light surfaces.
- [`mark-mono-light.svg`](./mark-mono-light.svg) (490 B) — Monochrome light mark (`#f1f1ee`) for dark surfaces.
- [`lockup-horizontal.svg`](./lockup-horizontal.svg) (2.35 KB) — Mark + `WALLET` (`#f1f1ee`) + `RADAR` (`#ffb000`).
- [`lockup-vertical.svg`](./lockup-vertical.svg) (7.17 KB) — Mark + `WALLET RADAR` + Tagline (`"The gate before you copy"`).

### Favicons & App Icons (Solid `#0a0a0b` background)
- `favicon-16.png` (16x16) — Pixel-aligned crisp icon (1px stroke, 4px gate gap, 2x2 target dot).
- `favicon-32.png` (32x32) — Standard browser tab icon.
- `favicon-48.png` (48x48) — High-DPI browser tab icon.
- `favicon-180.png` (180x180) — Apple Touch icon with 12% padding.
- `favicon-192.png` (192x192) — Android / PWA home screen icon with 12% padding.
- `favicon-512.png` (512x512) — PWA splash screen icon with 12% padding.
- `favicon.ico` — Multi-resolution ICO embedding 16x16, 32x32, and 48x48 layers.

### Social Preview Cards
- [`og-image.png`](./og-image.png) (1200x630) — Open Graph card for Discord, Telegram, LinkedIn, Slack.
- [`social-preview.png`](./social-preview.png) (1280x640) — Twitter / X Summary Large Image card.

### Multi-Scale Audit
- [`contact-sheet.png`](./contact-sheet.png) — Playwright test renders at 16, 32, 64, 256, 512 px on dark and light backgrounds.

---

## 5. Usage & Clear Space Guidelines

1. **Clear Space:** Maintain a clear margin of at least 12% of the mark's width on all sides.
2. **Minimum Sizes:**
   - Mark: 16x16 px minimum.
   - Horizontal Lockup: 120px width minimum.
   - Vertical Lockup: 140px width minimum.
3. **Misuse Rules:**
   - ❌ Do NOT round corners (`rx`, `ry`, or `border-radius`).
   - ❌ Do NOT apply drop shadows, blurs, or outer glows.
   - ❌ Do NOT apply linear or radial gradients.
   - ❌ Do NOT use unapproved colors or distort aspect ratios.

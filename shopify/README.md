# Packsmart Shopify storefront

This directory tracks the cleaned Packsmart Solutions Shopify theme source.

Current working theme: **Packsmart — Premium Final v3**
Shopify theme ID: `202600350030`
Status: **UNPUBLISHED / preview-safe**

Architecture:
- `assets/styles.css` — global design system, header, announcement bar, footer and shared components
- `assets/home-packsmart.css` — homepage-only presentation
- `assets/product-packsmart.css`, `collection-packsmart.css`, `cart-packsmart.css`, `search-packsmart.css` — route-specific cached styles
- `assets/site.js` — shared lightweight interactions
- Liquid templates contain markup/business logic rather than large inline CSS/JS blocks

The live Shopify theme must not be replaced from this branch until the v3 preview is visually checked on desktop and mobile. The website remains the source of truth for the Android mirror app.

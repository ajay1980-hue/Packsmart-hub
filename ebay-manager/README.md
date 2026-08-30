# Packsmart eBay Manager UI

Source-controlled front end for the separate Packsmart eBay Manager.

## Current build
- Imports live products from `https://packsmartsolutions.com/products.json?limit=250`.
- Multi-image picker uses `accept="image/*" multiple`.
- Up to 24 photos per eBay draft.
- Adding more photos keeps the existing selection.
- Previews, remove, reorder and main-image selection.
- Drag-and-drop support on desktop.
- Shopify title, description, first-variant price/SKU and Shopify CDN images can populate the draft.
- Mobile-first layout.
- Draft data is saved locally without exposing API credentials.

## Security / live eBay wiring
The eBay OAuth client secret and refresh token must stay server-side. Never commit them to this public repository or place them in browser JavaScript.

The existing hosted Packsmart eBay Manager remains the live secure backend/deployment until its deployment source is migrated. The backend should accept the ordered photo array from this UI, upload local files server-side, then create/update the eBay listing.

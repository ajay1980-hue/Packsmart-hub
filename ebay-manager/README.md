# Packsmart eBay Manager

Source-controlled front end for the existing hosted Packsmart eBay Manager.

## Finished UI workflow
- Imports Packsmart products from the public Shopify feed with the synced 15-product snapshot as fallback.
- Multi-image picker supports up to 24 photos per listing.
- Adding more photos preserves the existing selection until the 24-photo limit is reached.
- Photo previews support remove, left/right reorder and explicit main-image selection.
- Shopify title, description, first-variant price/SKU and Shopify CDN images populate the draft.
- `Save eBay draft` stores a local recovery copy and sends the ordered draft/photo payload to the hosted backend.
- `Create live eBay listing` sends the same ordered payload with a publish action after an explicit confirmation.
- Mobile-first layout; no Android application changes are required.

## Existing eBay OAuth is preserved
The browser never receives an eBay client secret or refresh token. The production deployment must serve this UI from the existing hosted eBay Manager origin (or configure an approved API base) so requests use the existing server-side OAuth/session.

The front end probes compatible same-origin backend routes and only falls through when a route returns 404/405:

- status: `/api/ebay/status`, `/api/status`, `/api/health`
- draft: `/api/ebay/drafts`, `/api/ebay/draft`, `/api/drafts`, `/api/draft`
- live listing: `/api/ebay/listings`, `/api/ebay/listing`, `/api/create-listing`, `/create-listing`

A host can override those safe route names without exposing credentials by setting `window.PACKSMART_EBAY_CONFIG` before `backend.js`/`app.js` load:

```html
<script>
window.PACKSMART_EBAY_CONFIG = {
  routes: {
    status: ['/existing/status-route'],
    draft: ['/existing/draft-route'],
    listing: ['/existing/listing-route']
  }
};
</script>
```

## Backend payload contract
Draft and live-listing requests are multipart `FormData` so local device photos remain uploadable. The request contains:

- `payload`, `draft`, `listing`: JSON copies of the listing payload for compatibility.
- `title`, `price`, `sku`, `description`.
- `imageUrls`: JSON array of Shopify/CDN image URLs.
- `photoOrder`: ordered JSON array; position 1 has `main: true`.
- repeated `photos` fields: local image files in the same local-file order referenced by `localFileIndex`.

The live-listing payload sets `action: "publish"`; draft creation sets `action: "draft"`.

## Tests
GitHub Actions validates JavaScript syntax, the synced Shopify catalogue, multi-photo markup, backend integration hooks and `tests/ebay-manager.test.js`. The Node test covers the 24-photo cap, additive photo selection, reorder, main-image selection, Shopify normalization, draft creation and multipart backend route fallback.

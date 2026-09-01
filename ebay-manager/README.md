# Packsmart eBay Manager

Source-controlled front end for the existing hosted Packsmart eBay Manager.

## Finished UI workflow
- Imports Packsmart products from the public Shopify feed with the synced 15-product snapshot as fallback.
- Multi-image picker supports up to 24 photos per listing.
- Listing photos are checked before upload against eBay-supported formats and the 12 MB-per-image limit; rejected files produce a visible reason instead of being silently ignored.
- Adding more photos preserves the existing selection until the 24-photo limit is reached.
- Photo previews support remove, left/right reorder and explicit main-image selection.
- Shopify title, description, first-variant price/SKU and Shopify CDN images populate the draft.
- `Save eBay draft` stores a local recovery copy and sends the ordered draft/photo payload to the hosted backend.
- `Create live eBay listing` sends the same ordered payload with a publish action after an explicit confirmation.
- Every payload targets `packsmartsolutions20`; hosted draft and publish writes are blocked unless the status endpoint explicitly reports that username.
- Free postage and buyer-paid flat postage are supported for UK services, with an optional fulfilment-policy ID for Inventory API backends.
- Postage-label PDFs and images can be previewed and opened for printing locally. Label files are deliberately kept out of listing-photo uploads.
- Mobile-first layout; no Android application changes are required.

## Existing eBay OAuth is preserved
The browser never receives an eBay client secret or refresh token. The production deployment must serve this UI from the existing hosted eBay Manager origin (or configure an approved API base) so requests use the existing server-side OAuth/session.

The repository contains the manager front end and its adapter contract, not the hosted OAuth/API implementation. Passing the local and GitHub tests proves the browser payload; a live photo upload or listing still requires one compatible server route below to be deployed and tested with the existing eBay grant.

The front end probes compatible same-origin backend routes and only falls through when a route returns 404/405:

- status: `/api/ebay/status`, `/api/status`, `/api/health`
- draft: `/api/ebay/drafts`, `/api/ebay/draft`, `/api/drafts`, `/api/draft`
- live listing: `/api/ebay/listings`, `/api/ebay/listing`, `/api/create-listing`, `/create-listing`

For the account guard to unlock writes, the status response must include an affirmative connection flag and the eBay username, for example:

```json
{"connected": true, "username": "packsmartsolutions20"}
```

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
- `ebayAccount` (`packsmartsolutions20`) and `marketplaceId` (`EBAY_GB`).
- `imageUrls`: JSON array of Shopify/CDN image URLs.
- `photoOrder`: ordered JSON array; position 1 has `main: true`.
- repeated `photos` fields: local image files in the same local-file order referenced by `localFileIndex`.
- `postage`: normalized JSON with the domestic service, free/paid flags, GBP cost and optional fulfilment-policy ID.
- compatibility fields: `freeShipping`, `shippingCost`, `shippingService` and `fulfillmentPolicyId`.

The live-listing payload sets `action: "publish"`; draft creation sets `action: "draft"`.

## Tests
GitHub Actions validates JavaScript syntax, the synced Shopify catalogue, photo/label/postage markup, backend integration hooks and `tests/ebay-manager.test.js`. The Node test covers the 24-photo cap, file validation, postage-label types, free and paid postage, target-account metadata, Shopify normalization, draft creation and multipart backend route fallback.

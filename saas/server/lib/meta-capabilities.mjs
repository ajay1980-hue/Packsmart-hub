export const META_VERSION = 'v26.0';
export const META_READ_SCOPES = ['pages_show_list', 'pages_read_engagement', 'instagram_basic'];
export const META_CATALOG_SCOPES = ['catalog_management', 'business_management'];
export const META_PUBLISH_SCOPES = ['pages_manage_posts', 'instagram_content_publish'];
export const META_WRITES = ['catalog_product_create', 'catalog_product_update', 'catalog_inventory', 'catalog_visibility', 'facebook_publish', 'facebook_update', 'instagram_publish'];
export const META_ORDER_RESTRICTION = {
  code: 'META_NATIVE_CHECKOUT_RETIRED',
  message: 'Meta retired checkout inside Facebook and Instagram Shops. Native shop-order APIs are blocked on v26.0 from 29 July 2026 and removed from older versions on 27 October 2026, with no replacement. Website-checkout orders are imported through your checkout connection, such as Shopify.',
  source: 'https://developers.facebook.com/docs/graph-api/changelog/version26.0/'
};

FROM node:22-alpine

WORKDIR /app

COPY saas ./saas
COPY ebay-manager/shopify-products.json ./ebay-manager/shopify-products.json

RUN mkdir -p /app/saas/server/data && chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=8787

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8787/api/health >/dev/null || exit 1

CMD ["node", "saas/server/server.mjs"]

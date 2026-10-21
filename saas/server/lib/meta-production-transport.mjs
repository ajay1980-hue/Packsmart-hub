// Node's fetch decodes these HTTP codings but retains their wire headers.
// Adapt only that trusted boundary; the shared bounded reader still enforces
// status, redirects, media type, decoded byte/chunk limits and deadlines.
export function decodedMetaProductionResponse(response, maxBytes) {
  const encoding = response?.headers?.get('content-encoding')?.trim().toLowerCase();
  if (!['gzip', 'deflate', 'br', 'identity'].includes(encoding)) return response;
  const length = response.headers.get('content-length');
  if (length !== null && (!/^(0|[1-9]\d*)$/.test(length) || Number(length) > maxBytes)) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  if (encoding !== 'identity') headers.delete('content-length');
  return {status: response.status, redirected: response.redirected, headers, body: response.body};
}

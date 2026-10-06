import crypto from 'node:crypto';
import { isIP } from 'node:net';

const nowIso = () => new Date().toISOString();
const clean = (value, max = 1000) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const invalid = message => Object.assign(new Error(message), { status: 400, code: 'VALIDATION_FAILED' });
export const WEB_SCAN_BLOCK_REASON = 'WEB_SCAN_ALLOWANCE_REQUIRED';
export const WEB_SCAN_OWNER_ACTION = 'Paid Firecrawl scans are paused until approved per-target request and credit accounting is available. Saved targets and findings remain available.';
export const WEB_SCAN_MAX_MARKDOWN_BYTES = 1024 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Object.getOwnPropertySymbols(value).length === 0
  && Object.values(Object.getOwnPropertyDescriptors(value)).every(field => field.enumerable && Object.hasOwn(field, 'value'));
const responseInvalid = (code = 'WEB_SCAN_RESPONSE_UNVERIFIED') => Object.assign(
  new Error('The Firecrawl response could not be verified. The saved snapshot and findings must be retained.'), { status: 502, code });

// This release intentionally has NO live Firecrawl dispatcher, issuer, or bypass
// flag. A key, owner request, setting, arbitrary callback or allowance-shaped
// JSON cannot authorize a chargeable scrape. Do not reuse operator-brief keys.
function scanEffects(blocked = 0, historicalExposureUnknown = false) {
  return { providerReads: 0, submissionAttempts: 0, confirmedSubmissions: 0,
    uncertainSubmissions: 0, blockedSubmissions: blocked, historicalExposureUnknown,
    externalWrites: false, spend: historicalExposureUnknown ? null : 0,
    costStatus: historicalExposureUnknown ? 'unknown' : 'not_incurred' };
}


function targetId(url) {
  return 'web_' + crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 20);
}

function normalizeHttpsUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); } catch { throw invalid('Enter a valid HTTPS website URL'); }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    parsed.protocol !== 'https:' || parsed.username || parsed.password ||
    isIP(host) || host === 'localhost' || host.endsWith('.localhost') ||
    host.endsWith('.local') || host.endsWith('.internal')
  ) throw invalid('Only public HTTPS website URLs can be monitored');
  parsed.hash = '';
  return parsed.toString();
}

function priceSignals(markdown = '') {
  const matches = [...String(markdown).matchAll(/(?:£|GBP\s*)\s?(\d{1,6}(?:[.,]\d{1,2})?)/gi)]
    .slice(0, 250)
    .map(match => Number(String(match[1]).replace(',', '.')))
    .filter(Number.isFinite);
  return [...new Set(matches.map(value => Number(value.toFixed(2))))].sort((a, b) => a - b).slice(0, 100);
}

function fingerprint(markdown) {
  return crypto.createHash('sha256').update(String(markdown || '')).digest('hex');
}

export function ensureWebIntelligence(state) {
  const previous = state.webIntelligence && typeof state.webIntelligence === 'object' ? state.webIntelligence : {};
  const settings = previous.settings && typeof previous.settings === 'object' ? previous.settings : {};
  state.webIntelligence = {
    // Store.get also normalizes before guarded scans. Keep explicit tenant and
    // workspace markers intact so normalization cannot launder foreign scope.
    ...previous, // Preserve recorded success/provenance metadata, including older fields.
    settings: {
      ...settings,
      enabled: settings.enabled !== false,
      scanIntervalMinutes: Number.isInteger(settings.scanIntervalMinutes) ? Math.max(60, Math.min(10080, settings.scanIntervalMinutes)) : 1440,
      maxTargetsPerRun: Number.isInteger(settings.maxTargetsPerRun) ? Math.max(1, Math.min(10, settings.maxTargetsPerRun)) : 5
    },
    targets: Array.isArray(previous.targets) ? previous.targets : [],
    findings: Array.isArray(previous.findings) ? previous.findings : [],
    scans: Array.isArray(previous.scans) ? previous.scans : [],
    lastRunAt: previous.lastRunAt || null,
    lastError: previous.lastError || null
  };
  return state.webIntelligence;
}

export function webIntelligenceSnapshot(state, env = process.env) {
  const intel = ensureWebIntelligence(state);
  const configured = Boolean(env.FIRECRAWL_API_KEY);
  const activeTargets = intel.targets.filter(item => item.active !== false);
  const recentCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recentFindings = intel.findings.filter(item => Date.parse(item.detectedAt || 0) >= recentCutoff);
  return {
    provider: {
      id: 'firecrawl',
      name: 'Firecrawl',
      configured,
      status: configured ? 'allowance_required' : 'not_configured',
      liveScanningAvailable: false,
      blockedReason: WEB_SCAN_BLOCK_REASON,
      readinessLabel: configured ? 'Configured · paid scans paused' : 'Not configured · paid scans paused',
      detail: WEB_SCAN_OWNER_ACTION
    },
    settings: intel.settings,
    targets: intel.targets.map(item => ({
      id: item.id, kind: item.kind, name: item.name, url: item.url, active: item.active !== false,
      lastScannedAt: item.lastScannedAt || null, lastChangedAt: item.lastChangedAt || null,
      lastSuccessfulScan: item.lastSuccessfulScan ?? null, lastSuccessfulScanAt: item.lastSuccessfulScanAt ?? null,
      lastStatus: item.lastStatus || 'not_scanned', lastError: item.lastError || null
    })),
    radar: {
      monitoredTargets: activeTargets.length,
      changes24h: recentFindings.length,
      priceSignals24h: recentFindings.filter(item => item.type === 'price_change').length,
      competitorChanges24h: recentFindings.filter(item => item.targetKind === 'competitor').length,
      supplierChanges24h: recentFindings.filter(item => item.targetKind === 'supplier').length,
      lastRunAt: intel.lastRunAt
    },
    findings: intel.findings.slice(0, 50),
    recentScans: intel.scans.slice(0, 25)
  };
}

export function updateWebIntelligenceSettings(state, body = {}) {
  const intel = ensureWebIntelligence(state);
  if (Object.hasOwn(body, 'enabled')) {
    if (typeof body.enabled !== 'boolean') throw invalid('Enabled must be a boolean');
    intel.settings.enabled = body.enabled;
  }
  if (Object.hasOwn(body, 'scanIntervalMinutes')) {
    const value = Number(body.scanIntervalMinutes);
    if (!Number.isInteger(value) || value < 60 || value > 10080) throw invalid('Scan interval must be between 60 and 10080 minutes');
    intel.settings.scanIntervalMinutes = value;
  }
  if (Object.hasOwn(body, 'maxTargetsPerRun')) {
    const value = Number(body.maxTargetsPerRun);
    if (!Number.isInteger(value) || value < 1 || value > 10) throw invalid('Max targets per run must be between 1 and 10');
    intel.settings.maxTargetsPerRun = value;
  }
  return intel.settings;
}

export function addWebIntelligenceTarget(state, body = {}) {
  const intel = ensureWebIntelligence(state);
  const url = normalizeHttpsUrl(body.url);
  const kind = ['competitor', 'supplier', 'market'].includes(body.kind) ? body.kind : 'competitor';
  const name = clean(body.name || new URL(url).hostname, 120);
  if (!name) throw invalid('Target name is required');
  const id = targetId(url);
  const existing = intel.targets.find(item => item.id === id);
  if (existing) {
    Object.assign(existing, { name, kind, url, active: true, updatedAt: nowIso() });
    return existing;
  }
  const target = {
    id, kind, name, url, active: true, createdAt: nowIso(), updatedAt: nowIso(),
    lastScannedAt: null, lastChangedAt: null, lastStatus: 'not_scanned', lastError: null,
    snapshot: null
  };
  intel.targets.unshift(target);
  return target;
}

export function setWebIntelligenceTargetActive(state, id, active) {
  const intel = ensureWebIntelligence(state);
  if (typeof active !== 'boolean') throw invalid('Active must be a boolean');
  const target = intel.targets.find(item => item.id === id);
  if (!target) throw Object.assign(new Error('Web intelligence target not found'), { status: 404, code: 'WEB_TARGET_NOT_FOUND' });
  target.active = active;
  target.updatedAt = nowIso();
  return target;
}

/**
 * Pure structural parser for future, separately authorized observations.
 * No network, state mutation, publication, billing settlement or scan authority.
 * Callers must never treat a parsed mock/receipt as permission to publish it.
 * A future transport must also bound raw response bytes BEFORE JSON parsing and
 * use redirect:error; that transport is deliberately absent from this release.
 */
export function parseFirecrawlObservation(payload, { requestedUrl, httpStatus = 200 } = {}) {
  let expected;
  if (typeof requestedUrl !== 'string' || requestedUrl.length > 2048) throw responseInvalid('WEB_SCAN_SOURCE_UNVERIFIED');
  try { expected = normalizeHttpsUrl(requestedUrl); } catch { throw responseInvalid('WEB_SCAN_SOURCE_UNVERIFIED'); }
  if (!Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus >= 300
    || !record(payload) || payload.success !== true || !record(payload.data)
    || typeof payload.data.markdown !== 'string' || !payload.data.markdown.trim()
    || Buffer.byteLength(payload.data.markdown, 'utf8') > WEB_SCAN_MAX_MARKDOWN_BYTES) throw responseInvalid();
  const data = payload.data;
  const metadata = data.metadata === undefined ? {} : data.metadata;
  if (!record(metadata) || (metadata.title !== undefined && typeof metadata.title !== 'string')
    || (metadata.statusCode !== undefined && (!Number.isInteger(metadata.statusCode) || metadata.statusCode < 200 || metadata.statusCode >= 300))) throw responseInvalid();
  // An unexpected/malformed source cannot replace an existing target baseline.
  // Redirected-source support requires an explicit future verified-source contract.
  for (const key of ['sourceURL', 'url']) if (metadata[key] !== undefined) {
    if (typeof metadata[key] !== 'string' || metadata[key].length > 2048) throw responseInvalid('WEB_SCAN_SOURCE_UNVERIFIED');
    let source;
    try { source = normalizeHttpsUrl(metadata[key]); } catch { throw responseInvalid('WEB_SCAN_SOURCE_UNVERIFIED'); }
    if (source !== expected) throw responseInvalid('WEB_SCAN_SOURCE_UNVERIFIED');
  }
  const content = data.markdown.slice(0, 12000);
  if (!content.trim()) throw responseInvalid();
  return { fingerprint: fingerprint(content), title: clean(metadata.title || '', 200),
    sourceUrl: expected, excerpt: clean(content, 6000), prices: priceSignals(content),
    contentTruncated: data.markdown.length > content.length };
}

const scopeInvalid = () => Object.assign(new Error('Web intelligence target does not belong to this workspace'),
  { status: 404, code: 'WEB_TARGET_NOT_FOUND' });
const scopeKeys = ['workspaceId', 'workspace_id', 'tenantId', 'tenant_id'];
function scopeField(value, key) {
  const field = Object.getOwnPropertyDescriptor(value, key);
  // An inherited/accessor marker must never be evaluated or normalized away.
  if ((!field && key in value) || (field && (!field.enumerable || !Object.hasOwn(field, 'value')))) throw scopeInvalid();
  return field;
}
function assertScopeMarkers(value, workspaceId, depth = 0) {
  if (depth > 4) throw scopeInvalid();
  for (const key of scopeKeys) {
    const field = scopeField(value, key);
    if (field && field.value !== workspaceId) throw scopeInvalid();
  }
  for (const key of ['workspace', 'tenant']) {
    const field = scopeField(value, key);
    if (!field) continue;
    const marker = field.value;
    if (typeof marker === 'string') {
      if (marker !== workspaceId) throw scopeInvalid();
    } else {
      if (!record(marker) || !Object.hasOwn(marker, 'id') || marker.id !== workspaceId) throw scopeInvalid();
      // A matching .id does not override a conflicting nested/aliased marker.
      assertScopeMarkers(marker, workspaceId, depth + 1);
    }
  }
}
function assertWebIntelligenceScope(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(state))) throw scopeInvalid();
  const workspace = scopeField(state, 'workspace')?.value;
  if (!record(workspace) || typeof workspace.id !== 'string' || !workspace.id) throw scopeInvalid();
  assertScopeMarkers(state, workspace.id);
  const previous = scopeField(state, 'webIntelligence')?.value;
  if (previous !== undefined && previous !== null) {
    if (!record(previous)) throw scopeInvalid();
    assertScopeMarkers(previous, workspace.id);
  }
}
function assertTargetScope(state, intel, target) {
  if (!record(target) || !intel.targets.includes(target)
    || typeof target.id !== 'string' || intel.targets.filter(row => row?.id === target.id).length !== 1) throw scopeInvalid();
  assertScopeMarkers(target, state.workspace.id);
}
function hasHistoricalExposure(intel, target) {
  return Boolean((target.snapshot !== null && target.snapshot !== undefined) || target.lastScannedAt || target.lastSuccessfulScan || target.lastSuccessfulScanAt
    || intel.scans.some(scan => scan?.targetId === target.id));
}
function blockedScan(intel, target) {
  return { target, changed: false, priceChanged: false, scanned: false, blocked: true,
    reason: WEB_SCAN_BLOCK_REASON, ownerAction: WEB_SCAN_OWNER_ACTION,
    effects: scanEffects(1, hasHistoricalExposure(intel, target)) };
}

export async function scanWebIntelligenceTarget(state, target, _options = {}) {
  assertWebIntelligenceScope(state);
  const intel = ensureWebIntelligence(state);
  assertTargetScope(state, intel, target);
  // No attempt record, success timestamp, snapshot, finding, scan, or credential
  // is rewritten merely because authority is missing. Options cannot bypass it.
  return blockedScan(intel, target);
}

export async function runWebIntelligence(state, { targetId: onlyTargetId = null } = {}) {
  assertWebIntelligenceScope(state);
  const intel = ensureWebIntelligence(state);
  const none = reason => ({ scanned: 0, changed: 0, priceChanged: 0, failed: 0, blocked: 0,
    reason, skipped: reason, effects: scanEffects() });
  if (!intel.settings.enabled) return none('WEB_SCANNING_DISABLED');
  if (onlyTargetId !== null && (typeof onlyTargetId !== 'string' || !onlyTargetId || onlyTargetId.length > 120)) {
    throw Object.assign(new Error('Web intelligence target not found'), { status: 404, code: 'WEB_TARGET_NOT_FOUND' });
  }
  const targets = intel.targets.filter(item => item.active !== false && (onlyTargetId === null || item.id === onlyTargetId))
    .slice(0, intel.settings.maxTargetsPerRun);
  if (onlyTargetId !== null && !targets.length) throw Object.assign(new Error('Web intelligence target not found'), { status: 404, code: 'WEB_TARGET_NOT_FOUND' });
  if (!targets.length) return none('WEB_NO_ACTIVE_TARGETS');
  for (const target of targets) assertTargetScope(state, intel, target);
  return { scanned: 0, changed: 0, priceChanged: 0, failed: 0, blocked: targets.length,
    reason: WEB_SCAN_BLOCK_REASON, ownerAction: WEB_SCAN_OWNER_ACTION,
    effects: scanEffects(targets.length, targets.some(target => hasHistoricalExposure(intel, target))) };
}

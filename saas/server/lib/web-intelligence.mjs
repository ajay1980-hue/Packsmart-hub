import crypto from 'node:crypto';
import { isIP } from 'node:net';

const nowIso = () => new Date().toISOString();
const clean = (value, max = 1000) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const invalid = message => Object.assign(new Error(message), { status: 400, code: 'VALIDATION_FAILED' });

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

function diffPrices(previous = [], current = []) {
  const before = new Set(previous.map(Number));
  const after = new Set(current.map(Number));
  const added = current.filter(value => !before.has(Number(value))).slice(0, 20);
  const removed = previous.filter(value => !after.has(Number(value))).slice(0, 20);
  return { added, removed, changed: Boolean(added.length || removed.length) };
}

export function ensureWebIntelligence(state) {
  const previous = state.webIntelligence && typeof state.webIntelligence === 'object' ? state.webIntelligence : {};
  const settings = previous.settings && typeof previous.settings === 'object' ? previous.settings : {};
  state.webIntelligence = {
    settings: {
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
      status: configured ? 'configured' : 'not_configured',
      detail: configured ? 'Live public-web intelligence is available.' : 'Add FIRECRAWL_API_KEY on the Runvara server to enable live scans.'
    },
    settings: intel.settings,
    targets: intel.targets.map(item => ({
      id: item.id, kind: item.kind, name: item.name, url: item.url, active: item.active !== false,
      lastScannedAt: item.lastScannedAt || null, lastChangedAt: item.lastChangedAt || null,
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

async function firecrawlScrape(url, env, fetchImpl = fetch) {
  if (!env.FIRECRAWL_API_KEY) throw Object.assign(new Error('Firecrawl is not configured'), { status: 503, code: 'FIRECRAWL_NOT_CONFIGURED' });
  const response = await fetchImpl('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.FIRECRAWL_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
      onlyMainContent: true,
      timeout: 30000,
      blockAds: true,
      removeBase64Images: true,
      storeInCache: true
    }),
    signal: AbortSignal.timeout(45000)
  });
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok || payload.success === false) {
    const detail = clean(payload.error || payload.message || ('HTTP ' + response.status), 500);
    throw Object.assign(new Error('Firecrawl scan failed: ' + detail), { status: 502, code: 'FIRECRAWL_REQUEST_FAILED' });
  }
  const data = payload.data || payload;
  return {
    markdown: String(data.markdown || ''),
    title: clean(data.metadata?.title || '', 200),
    sourceUrl: clean(data.metadata?.sourceURL || data.metadata?.url || url, 2048)
  };
}

export async function scanWebIntelligenceTarget(state, target, { env = process.env, fetchImpl = fetch, actor = 'system' } = {}) {
  const intel = ensureWebIntelligence(state);
  const startedAt = nowIso();
  try {
    const result = await firecrawlScrape(target.url, env, fetchImpl);
    const content = result.markdown.slice(0, 12000);
    const prices = priceSignals(content);
    const nextFingerprint = fingerprint(content);
    const previous = target.snapshot;
    const changed = Boolean(previous && previous.fingerprint !== nextFingerprint);
    const priceDiff = diffPrices(previous?.prices || [], prices);
    const snapshot = {
      fingerprint: nextFingerprint,
      title: result.title,
      sourceUrl: result.sourceUrl,
      excerpt: clean(content, 6000),
      prices,
      capturedAt: nowIso()
    };
    target.snapshot = snapshot;
    target.lastScannedAt = snapshot.capturedAt;
    target.lastStatus = 'connected';
    target.lastError = null;
    if (changed) {
      target.lastChangedAt = snapshot.capturedAt;
      const finding = {
        id: 'finding_' + crypto.randomUUID(),
        targetId: target.id,
        targetName: target.name,
        targetKind: target.kind,
        type: priceDiff.changed ? 'price_change' : 'content_change',
        title: priceDiff.changed ? target.name + ' price signals changed' : target.name + ' website changed',
        detail: priceDiff.changed
          ? ('Observed public price signals changed. Added: ' + (priceDiff.added.join(', ') || 'none') + '; removed: ' + (priceDiff.removed.join(', ') || 'none') + '.')
          : 'The monitored public page content changed since the previous successful scan.',
        sourceUrl: target.url,
        detectedAt: snapshot.capturedAt,
        evidence: { previousFingerprint: previous.fingerprint, currentFingerprint: nextFingerprint, priceDiff }
      };
      intel.findings.unshift(finding);
      intel.findings = intel.findings.slice(0, 500);
    }
    intel.scans.unshift({
      id: 'scan_' + crypto.randomUUID(), targetId: target.id, targetName: target.name,
      status: 'completed', changed, priceChanged: priceDiff.changed, startedAt, completedAt: snapshot.capturedAt, actor
    });
    intel.scans = intel.scans.slice(0, 500);
    intel.lastRunAt = snapshot.capturedAt;
    intel.lastError = null;
    return { target, changed, priceChanged: priceDiff.changed };
  } catch (error) {
    const failedAt = nowIso();
    target.lastScannedAt = failedAt;
    target.lastStatus = 'error';
    target.lastError = clean(error.message, 500);
    intel.lastRunAt = failedAt;
    intel.lastError = target.lastError;
    intel.scans.unshift({
      id: 'scan_' + crypto.randomUUID(), targetId: target.id, targetName: target.name,
      status: 'failed', changed: false, priceChanged: false, startedAt, completedAt: failedAt,
      actor, errorCode: error.code || 'WEB_SCAN_FAILED', error: target.lastError
    });
    intel.scans = intel.scans.slice(0, 500);
    throw error;
  }
}

export async function runWebIntelligence(state, { env = process.env, fetchImpl = fetch, actor = 'system', targetId: onlyTargetId = null } = {}) {
  const intel = ensureWebIntelligence(state);
  if (!intel.settings.enabled) return { scanned: 0, changed: 0, priceChanged: 0, skipped: 'disabled' };
  const targets = intel.targets
    .filter(item => item.active !== false && (!onlyTargetId || item.id === onlyTargetId))
    .slice(0, intel.settings.maxTargetsPerRun);
  if (onlyTargetId && !targets.length) throw Object.assign(new Error('Web intelligence target not found'), { status: 404, code: 'WEB_TARGET_NOT_FOUND' });
  const summary = { scanned: 0, changed: 0, priceChanged: 0, failed: 0 };
  for (const target of targets) {
    try {
      const result = await scanWebIntelligenceTarget(state, target, { env, fetchImpl, actor });
      summary.scanned += 1;
      if (result.changed) summary.changed += 1;
      if (result.priceChanged) summary.priceChanged += 1;
    } catch {
      summary.scanned += 1;
      summary.failed += 1;
    }
  }
  return summary;
}

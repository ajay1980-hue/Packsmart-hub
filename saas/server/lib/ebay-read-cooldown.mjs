// eBay read admission only. These fields live in the existing workspace save;
// receipt of a provider response is not atomic with that save.
const MINIMUM_WAIT = 60000;
const LAST_DATE = Date.parse('9999-12-31T23:59:59.999Z');
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const longDays = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

export function validEbayRetryAt(value) {
  if (typeof value !== 'string' || value.length > 24 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const canonical = new Date(time).toISOString();
  return canonical === value || canonical === value.replace('Z', '.000Z') ? canonical : null;
}

function httpDate(value, now) {
  let match, weekday, day, month, year, hour, minute, second, obsoleteYear = false;
  if ((match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (\w{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value))) {
    [,weekday,day,month,year,hour,minute,second] = match;
    weekday = days.indexOf(weekday);
  } else if ((match = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(\w{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value))) {
    [,weekday,day,month,year,hour,minute,second] = match;
    weekday = longDays.indexOf(weekday);
    const currentYear = new Date(now).getUTCFullYear();
    year = Math.floor(currentYear / 100) * 100 + Number(year);
    obsoleteYear = true;
  } else if ((match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (\w{3}) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value))) {
    [,weekday,month,day,hour,minute,second,year] = match;
    weekday = days.indexOf(weekday);
  } else return NaN;
  [day,year,hour,minute,second] = [day,year,hour,minute,second].map(Number);
  month = months.indexOf(month);
  if (month < 0 || day < 1 || hour > 23 || minute > 59 || second > 60) return NaN;
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, Math.min(second,59), 0);
  if (obsoleteYear) {
    const futureLimit = new Date(now); futureLimit.setUTCFullYear(futureLimit.getUTCFullYear() + 50);
    if (date.getTime() > futureLimit.getTime()) { year -= 100; date.setUTCFullYear(year); }
  }
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day || date.getUTCDay() !== weekday) return NaN;
  return date.getTime() + (second === 60 ? 1000 : 0);
}

export function parseEbayRetryAfter(value, now = Date.now(), { fallback = true } = {}) {
  const review = { retryAt: null, retryReviewRequired: true };
  if (!Number.isSafeInteger(now) || now < 0 || now > LAST_DATE - MINIMUM_WAIT) return review;
  if (typeof value === 'string' && value.length > 128) return review;
  const text = typeof value === 'string' ? value.replace(/^[ \t]+|[ \t]+$/g, '') : '';
  let deadline;
  if (/^\d+$/.test(text)) {
    const digits = text.replace(/^0+/, '') || '0';
    // Avoid unbounded integer conversion and never round an oversized wait down.
    if (digits.length > 15) return review;
    const seconds = BigInt(digits), available = BigInt(LAST_DATE - now);
    if (seconds * 1000n > available) return review;
    deadline = now + Number(seconds * 1000n);
  } else deadline = httpDate(text, now);
  if (!Number.isFinite(deadline) && !fallback) return { retryAt: null, retryReviewRequired: false };
  deadline = Math.max(now + MINIMUM_WAIT, Number.isFinite(deadline) ? deadline : 0);
  return deadline > LAST_DATE ? review : { retryAt: new Date(deadline).toISOString(), retryReviewRequired: false };
}

export function mergeEbayReadCooldown(values, now = Date.now()) {
  let latest = now, retryReviewRequired = false;
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const at = validEbayRetryAt(value.retryAt);
    if (at) latest = Math.max(latest, Date.parse(at));
    else if (value.retryAt != null && value.retryAt !== '') retryReviewRequired = true;
    if (value.retryReviewRequired != null && value.retryReviewRequired !== false) retryReviewRequired = true;
  }
  return { retryAt: latest > now ? new Date(latest).toISOString() : null, retryReviewRequired };
}

export function ebayReadCooldown(state, now = Date.now()) {
  return mergeEbayReadCooldown([state.integrationStatus?.ebay, ...Object.values(state.ebay?.coverage?.readDiagnostics || {})], now);
}

export function ebayReadDeferred(state, now = Date.now(), automatic = false) {
  const cooldown = ebayReadCooldown(state, now);
  return Boolean(cooldown.retryAt || cooldown.retryReviewRequired || automatic && Date.parse(validEbayRetryAt(state.connectionDoctor?.ebay?.nextRetryAt)) > now);
}

export function ebayCooldownError(cooldown, { deferred = true } = {}) {
  return Object.assign(new Error(cooldown.retryReviewRequired ? 'The eBay retry deadline needs review before another read.' : 'eBay reads are waiting for the saved retry deadline.'), {
    code: cooldown.retryReviewRequired ? 'EBAY_RETRY_REVIEW_REQUIRED' : 'EBAY_READ_DEFERRED', status: 429,
    ...cooldown, ...(deferred ? { cooldownDeferred: true } : {})
  });
}

export function assertEbayReadAdmission(state, provider = 'ebay', { automatic = false, now = Date.now() } = {}) {
  if (provider !== 'ebay') return;
  const cooldown = ebayReadCooldown(state, now);
  if (cooldown.retryAt || cooldown.retryReviewRequired) throw ebayCooldownError(cooldown);
  const retryAt = validEbayRetryAt(state.connectionDoctor?.ebay?.nextRetryAt);
  if (automatic && retryAt && Date.parse(retryAt) > now) throw Object.assign(new Error('Automatic eBay reads are waiting for the saved retry deadline.'), { code: 'CONNECTION_RETRY_DEFERRED', status: 409, cooldownDeferred: true, retryAt });
}

export function ebayErrorCooldown(error, now = Date.now()) {
  const saved = mergeEbayReadCooldown([error], now);
  if (saved.retryAt || saved.retryReviewRequired) return saved;
  // An already-normalized (possibly expired) deadline is evidence, not a new
  // duration to anchor at the time a slower sibling finally settles.
  if (error && (Object.hasOwn(error, 'retryAt') || error.cooldownDeferred)) return saved;
  // Compatibility for existing in-process adapters supplying a duration only.
  const delay = error?.retryAfterMs;
  if (typeof delay === 'number' && Number.isFinite(delay) && delay >= 0) {
    if (delay > LAST_DATE - now) return { retryAt: null, retryReviewRequired: true };
    return parseEbayRetryAfter(String(Math.ceil(delay / 1000)), now);
  }
  if (error?.upstreamStatus !== 429 && !/RATE_LIMIT/.test(error?.code || '')) return saved;
  return parseEbayRetryAfter(null, now);
}

export function createEbayReadContext() {
  let cooldown = { retryAt: null, retryReviewRequired: false }, stopped = false;
  return {
    observe(error) {
      const next = ebayErrorCooldown(error);
      if (error?.upstreamStatus === 429 || /RATE_LIMIT/.test(error?.code || '') || validEbayRetryAt(error?.retryAt) || next.retryReviewRequired) stopped = true;
      if (next.retryAt || next.retryReviewRequired) {
        cooldown = mergeEbayReadCooldown([cooldown, next]); stopped = true;
      }
    },
    assertAllowed() { if (stopped) throw ebayCooldownError(cooldown); },
    get stopped() { return stopped; },
    get cooldown() { return cooldown; }
  };
}

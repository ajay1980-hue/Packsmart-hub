// Server-only, bounded reporting DTO. It can never carry a workspace snapshot.
export const REPORTING_STATUS_MAX_BYTES = 8192;
export const REPORTING_REQUEST_MAX_BYTES = 16384;
export const REPORTING_RESPONSE_MAX_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[A-Z0-9_]{1,80}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const timestamp = value => value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const invalid = () => Object.assign(new Error('Reporting status input is invalid'), { code: 'REPORTING_STATUS_INPUT_INVALID', status: 503 });

export function reportingStatusRequest(workspaceId, expectedRevision, nextRevision, report, updatedAt) {
  if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 256 || workspaceId.trim() !== workspaceId || /[\u0000-\u001f\u007f]/.test(workspaceId)
    || typeof expectedRevision !== 'string' || !UUID.test(expectedRevision) || typeof nextRevision !== 'string' || !UUID.test(nextRevision) || expectedRevision === nextRevision
    || !exactKeys(report, ['status', 'detail', 'lastSyncAt', 'lastFailureAt', 'lastError', 'failures'])
    || !['connected', 'degraded'].includes(report.status) || typeof report.detail !== 'string' || report.detail.length > 320
    || !timestamp(report.lastSyncAt) || !timestamp(report.lastFailureAt) || !(report.lastError === null || typeof report.lastError === 'string' && CODE.test(report.lastError))
    || !Array.isArray(report.failures) || report.failures.length > 32 || !timestamp(updatedAt) || updatedAt === null) throw invalid();
  for (const failure of report.failures) {
    if (!exactKeys(failure, ['table', 'code', 'httpStatus', 'databaseCode'])
      || typeof failure.table !== 'string' || !/^[a-z_]{1,80}$/.test(failure.table)
      || typeof failure.code !== 'string' || !CODE.test(failure.code)
      || !(failure.httpStatus === null || Number.isInteger(failure.httpStatus) && failure.httpStatus >= 100 && failure.httpStatus <= 599)
      || !(failure.databaseCode === null || typeof failure.databaseCode === 'string' && /^(?:[0-9A-Z]{5}|PGRST\d{1,5})$/.test(failure.databaseCode))) throw invalid();
  }
  if (report.status === 'connected' ? report.failures.length !== 0 || report.lastError !== null
    : !report.failures.length || report.lastError !== (report.failures[0].databaseCode || report.failures[0].code)) throw invalid();
  if (Buffer.byteLength(JSON.stringify(report)) > REPORTING_STATUS_MAX_BYTES) throw invalid();
  const body = JSON.stringify({ p_workspace_id: workspaceId, p_expected_revision: expectedRevision, p_next_revision: nextRevision,
    p_report: report, p_updated_at: updatedAt });
  if (Buffer.byteLength(body) > REPORTING_REQUEST_MAX_BYTES) throw invalid();
  return body;
}

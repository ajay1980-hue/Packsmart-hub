import crypto from 'node:crypto';

export function addAudit(state, event) {
  const entry = {
    id: `audit_${crypto.randomUUID()}`,
    type: String(event.type || 'event').slice(0, 100),
    actor: String(event.actor || 'system').slice(0, 160),
    detail: event.detail && typeof event.detail === 'object' ? event.detail : {},
    createdAt: event.createdAt || new Date().toISOString()
  };
  // Keep only a bounded in-state working set. The durable audit history lives in audit_events.
  state.audit = [entry, ...(state.audit || [])].slice(0, 500);
  return entry;
}

export const WORK_STATUSES = Object.freeze(['PLANNED', 'IN PROGRESS', 'COMPLETED', 'FAILED', 'BLOCKED', 'REQUIRES APPROVAL']);

export function recordWork(state, { id = `work_${crypto.randomUUID()}`, status = 'PLANNED', ...details }) {
  if (!WORK_STATUSES.includes(status)) throw new Error('Invalid work status');
  if (status === 'COMPLETED' && !details.evidence?.length) throw new Error('Completed work requires evidence');
  const record = { id, ...details, status, updatedAt: new Date().toISOString() };
  const previous = (state.workRecords || []).find(item => item.id === id);
  record.history = [...(previous?.history || []), { status, at: record.updatedAt }];
  state.workRecords = [record, ...(state.workRecords || []).filter(item => item.id !== id)];
  return record;
}

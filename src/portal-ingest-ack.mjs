export const PORTAL_INGEST_ACK_SCHEMA = 'idleproof.portal-ingest-ack.v1';
const ALLOWED_STATUSES = new Set(['accepted', 'duplicate']);
const ACK_KEYS = new Set(['schema', 'status', 'snapshotId']);

function ackError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function validatePortalIngestAck(value, expectedSnapshotId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ackError('IDLEPROOF_PORTAL_ACK_INVALID', 'Portal ingestion acknowledgement must be a JSON object.');
  }
  const unknown = Object.keys(value).filter((key) => !ACK_KEYS.has(key));
  if (unknown.length) {
    throw ackError('IDLEPROOF_PORTAL_ACK_INVALID', `Portal ingestion acknowledgement contains unknown field(s): ${unknown.sort().join(', ')}.`);
  }
  if (value.schema !== PORTAL_INGEST_ACK_SCHEMA) {
    throw ackError('IDLEPROOF_PORTAL_ACK_INVALID', `Portal ingestion acknowledgement must use ${PORTAL_INGEST_ACK_SCHEMA}.`);
  }
  if (!ALLOWED_STATUSES.has(value.status)) {
    throw ackError('IDLEPROOF_PORTAL_ACK_INVALID', 'Portal ingestion acknowledgement status must be accepted or duplicate.');
  }
  if (typeof value.snapshotId !== 'string' || !/^ipsnap_[a-f0-9]{24}$/.test(value.snapshotId)) {
    throw ackError('IDLEPROOF_PORTAL_ACK_INVALID', 'Portal ingestion acknowledgement snapshotId is invalid.');
  }
  if (value.snapshotId !== expectedSnapshotId) {
    throw ackError('IDLEPROOF_PORTAL_ACK_MISMATCH', 'Portal acknowledged a different snapshotId; queued evidence was retained.');
  }
  return {
    schema: PORTAL_INGEST_ACK_SCHEMA,
    status: value.status,
    snapshotId: value.snapshotId
  };
}

export function syntheticEvent(sequence = '1', objects = ['artifact']) {
  return { schema_version: '1', tenant_id: 'synthetic-tenant', workflow_id: 'synthetic-workflow', task_id: 'synthetic-task', event_id: 'event-' + sequence,
    attempt_id: 'attempt-1', event_type: 'action_observed', source_id: 'independent-monitor', source_sequence: sequence,
    occurred_at: '2026-10-23T00:00:00Z', captured_at: '2026-10-23T00:00:01Z', received_at: '2026-10-23T00:00:02Z',
    previous_digest: null, payload_refs: objects, approval_ref: null, business_transaction_id: null, version_refs: { collector: 'v1' } };
}

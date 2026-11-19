/** Chain-independent v1 contract. null means unknown, never zero or verified. */
export const INCIDENT_SCHEMA_VERSION = 1 as const;
export type Scope = { schemaVersion: 1; tenantId: string; projectId: string; createdAt: string };
export type Role = 'enterprise_admin' | 'collector' | 'investigator' | 'reviewer' | 'viewer' | 'fde';
export type Grant = { projectId: string; role: Role };
export type Actor = { actorId: string; tenantId: string };
export type WorkflowInput = { schemaVersion: 1; projectId: string; enterpriseId: string; fdePartyId: string | null; repoRef: string; allowedActions: string[]; approvalPolicyVersion: string; dataAuthorizationRef: string };
export type Workflow = Scope & WorkflowInput & { workflowId: string; version: 1; status: 'registered' };
export type RunInput = { schemaVersion: 1; projectId: string; workflowId: string; taskRef: string; agentProvider: string | null; modelVersion: string | null; toolVersions: Record<string,string>; baseRevision: string | null; resultRevision: string | null; startedAt: string | null; endedAt: string | null; captureCoverage: { collected: string[]; missing: string[] }; environment: 'synthetic' | 'isolated_test' | 'approved_redacted' };
export type AgentRun = Scope & RunInput & { runId: string; version: 1 };
export type IncidentInput = { schemaVersion: 1; projectId: string; workflowId: string; runIds: string[]; detectedAt: string | null; severity: 'unknown' | 'low' | 'medium' | 'high'; affectedAssets: string[]; statement: string; groupingReason: string | null; linkedIncidentIds: string[] };
export type Incident = Scope & IncidentInput & { incidentId: string; version: 1; declaredAt: string; status: 'declared' };
export type SourceRegistration = Scope & { sourceId: string; controllerPartyId: string; kind: string; allowedScope: string[]; keyId: string | null; publicKey: string | null; validFrom: string; validUntil: string | null; revokedAt: string | null; captureMethod: 'source_export' | 'gateway_receipt' | 'attested' | 'synthetic' };
export type EvidenceEvent = Scope & { eventId: string; runId: string; sourceId: string; sourceSequence: string | null; attemptId: string; eventType: string; occurredAt: string | null; capturedAt: string | null; receivedAt: string; clockStatus: 'unknown' | 'consistent' | 'conflict'; previousDigest: string | null; payloadRefs: string[]; approvalRef: string | null; versionRefs: string[]; trust: 'unverified' | 'source_signed' | 'gateway_received' | 'attested' | 'synthetic'; importId: string; supersedes: string | null };
export type ApprovalRecord = Scope & { approvalId: string; actorId: string; role: string; kind: 'execution' | 'investigation_review' | 'insurance_decision'; actionDigest: string; displayedPayloadRef: string; targetRevision: string; decision: 'approved' | 'rejected' | 'taken_over'; scope: string[]; expiresAt: string | null; recordingMode: 'observed' | 'attested' | 'synthetic'; sourceRef: string };
export type EvidenceObject = Scope & { objectId: string; rawDigest: string; mediaType: string; byteLength: string; storageRef: string; sourceSignature: string | null; receiptSignature: string | null; redactedFrom: string | null; retentionUntil: string | null; legalHold: boolean; accessPolicy: string; keyId: string | null };
export type Finding = Scope & { findingId: string; type: 'fact' | 'hypothesis' | 'conflict' | 'unknown'; statement: string; evidenceRefs: { objectId: string; locator: string }[]; counterEvidenceRefs: string[]; validatorVersion: string; reviewStatus: 'pending' | 'accepted' | 'rejected' };
export type ExpenseLine = Scope & { expenseId: string; category: string; currency: string; scale: number; gross: string | null; paid: string | null; duplicate: string | null; compensation: string | null; recovery: string | null; netVerified: string | null; evidenceRefs: string[]; verificationStatus: 'unknown' | 'pending' | 'verified' };
export type InvestigationReport = Scope & { reportId: string; incidentId: string; version: number; evidenceManifestDigest: string; timelineVersion: number; findings: Finding[]; expenseSnapshot: ExpenseLine[]; modelVersion: string | null; promptVersion: string; toolVersions: Record<string,string>; limitations: string[]; status: 'draft' | 'pending_review' | 'reviewed' | 'changes_requested' };
export type HumanReview = Scope & { reviewId: string; reportId: string; reportVersion: number; manifestDigest: string; actorId: string; independenceCheck: boolean; decision: 'accepted' | 'changes_requested'; reason: string; reviewedAt: string };
export type CoverageReference = Scope & { mode: 'none' | 'proposed' | 'confirmed_external' | 'local_test'; insurerParty: string | null; policyRef: string | null; termsVersion: string | null; currency: string | null; scale: number | null; deductible: string | null; share: { numerator: string; denominator: string } | null; incidentLimit: string | null; annualLimit: string | null; exclusionsRef: string | null; confirmationEvidence: string[] };
export type ClaimBridge = Scope & { incidentId: string; reportVersion: number; localDeploymentId: string; policyId: string; noticeId: string; claimIncidentId: string; mappingVersion: number; idempotencyKey: string; state: 'requested' | 'signed' | 'broadcast' | 'confirmed' | 'unknown' | 'failed' };
export type RoiPeriod = Scope & { period: string; currency: string; scale: number; qualityDefinition: string; qualifiedOutputs: string | null; humanBaseline: string | null; aiCost: string | null; assuranceCost: string | null; supervisionMaintenance: string | null; uninsuredLoss: string | null; transitionCost: string | null; amortizationPeriods: number | null; basis: 'actual' | 'estimated' | 'mixed'; sourceRefs: string[] };

export class IncidentFault extends Error { constructor(public statusCode: number, message: string) { super(message); } }
export function requireIncident(ok: unknown, message = 'INVALID_INPUT', code = 400): asserts ok { if (!ok) throw new IncidentFault(code, message); }
export const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
export const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 4096;
const nullableText = (v: unknown) => v === null || text(v);
export const timestamp = (v: unknown) => v === null || (typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
export function exactObject(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  requireIncident(v !== null && typeof v === 'object' && !Array.isArray(v));
  requireIncident(Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k)), 'INVALID_FIELDS');
}
function strings(v: unknown, ids = false): boolean { return Array.isArray(v) && v.length <= 100 && v.every(ids ? identifier : text) && new Set(v).size === v.length; }
function base(v: Record<string,unknown>) { requireIncident(v.schemaVersion === 1, 'UNSUPPORTED_SCHEMA'); requireIncident(identifier(v.projectId)); }
export function parseWorkflow(v: unknown): WorkflowInput {
  exactObject(v, ['schemaVersion','projectId','enterpriseId','fdePartyId','repoRef','allowedActions','approvalPolicyVersion','dataAuthorizationRef']); base(v);
  requireIncident(identifier(v.enterpriseId) && (v.fdePartyId === null || identifier(v.fdePartyId)) && text(v.repoRef) && strings(v.allowedActions) && (v.allowedActions as string[]).length > 0 && text(v.approvalPolicyVersion) && text(v.dataAuthorizationRef));
  return v as WorkflowInput;
}
export function parseRun(v: unknown): RunInput {
  exactObject(v, ['schemaVersion','projectId','workflowId','taskRef','agentProvider','modelVersion','toolVersions','baseRevision','resultRevision','startedAt','endedAt','captureCoverage','environment']); base(v);
  exactObject(v.captureCoverage, ['collected','missing']);
  requireIncident(strings(v.captureCoverage.collected) && strings(v.captureCoverage.missing));
  requireIncident(!(v.captureCoverage.collected as string[]).some(x => (v.captureCoverage as RunInput['captureCoverage']).missing.includes(x)));
  requireIncident(identifier(v.workflowId) && text(v.taskRef) && nullableText(v.agentProvider) && nullableText(v.modelVersion) && nullableText(v.baseRevision) && nullableText(v.resultRevision) && timestamp(v.startedAt) && timestamp(v.endedAt));
  requireIncident(v.startedAt === null || v.endedAt === null || String(v.startedAt) <= String(v.endedAt), 'INVALID_TIME_RANGE');
  requireIncident(v.toolVersions !== null && typeof v.toolVersions === 'object' && !Array.isArray(v.toolVersions) && Object.entries(v.toolVersions).length <= 100 && Object.entries(v.toolVersions).every(([k,val]) => identifier(k) && text(val)));
  requireIncident((typeof v.environment === 'string' && ['synthetic','isolated_test','approved_redacted'].includes(v.environment)));
  return v as RunInput;
}
export function parseIncident(v: unknown): IncidentInput {
  exactObject(v, ['schemaVersion','projectId','workflowId','runIds','detectedAt','severity','affectedAssets','statement','groupingReason','linkedIncidentIds']); base(v);
  requireIncident(identifier(v.workflowId) && strings(v.runIds, true) && timestamp(v.detectedAt) && (typeof v.severity === 'string' && ['unknown','low','medium','high'].includes(v.severity)) && strings(v.affectedAssets) && text(v.statement) && nullableText(v.groupingReason) && strings(v.linkedIncidentIds, true));
  requireIncident(!(v.linkedIncidentIds as string[]).length || text(v.groupingReason), 'GROUPING_REASON_REQUIRED');
  return v as IncidentInput;
}
/** Monetary contract validation; no arithmetic, FX or coverage inference here. */
export function validateExpense(v: ExpenseLine): ExpenseLine {
  requireIncident(v.schemaVersion === 1 && identifier(v.tenantId) && identifier(v.projectId) && identifier(v.expenseId));
  requireIncident(/^[A-Z][A-Z0-9]{2,11}$/.test(v.currency) && Number.isInteger(v.scale) && v.scale >= 0 && v.scale <= 18);
  for (const k of ['gross','paid','duplicate','compensation','recovery','netVerified'] as const) requireIncident(v[k] === null || (typeof v[k] === 'string' && /^(0|[1-9]\d{0,77})$/.test(v[k])), 'INVALID_AMOUNT');
  requireIncident(v.verificationStatus !== 'verified' || (v.netVerified !== null && v.paid !== null && v.evidenceRefs.length > 0), 'VERIFICATION_EVIDENCE_REQUIRED');
  return v;
}

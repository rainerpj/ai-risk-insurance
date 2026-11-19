export const roles = ['GOVERNOR', 'UNDERWRITER', 'ASSESSOR', 'CLAIM_APPROVER', 'SUPERVISOR', 'AUTO_REVIEWER', 'AUTO_AUTHORIZER', 'TREASURER', 'ANCHOR_OPERATOR'] as const;
export type Role = typeof roles[number];
const incompatible: readonly (readonly [Role, Role])[] = [
  ['ASSESSOR', 'CLAIM_APPROVER'], ['ASSESSOR', 'SUPERVISOR'], ['CLAIM_APPROVER', 'SUPERVISOR'],
  ['AUTO_REVIEWER', 'AUTO_AUTHORIZER'],
];
export function validateRoles(assigned: readonly Role[]) {
  if (assigned.some(r => !roles.includes(r))) throw new Error('UNKNOWN_ROLE');
  if (incompatible.some(([a, b]) => assigned.includes(a) && assigned.includes(b))) throw new Error('ROLE_CONFLICT');
}
export function validateParticipants(reviewers: readonly string[], insured: string, fde: string, executor?: string) {
  const ids = reviewers.map(s => s.toLowerCase());
  if (new Set(ids).size !== ids.length || ids.includes(insured.toLowerCase()) || ids.includes(fde.toLowerCase())
      || (executor && ids.includes(executor.toLowerCase()))) throw new Error('PARTICIPANT_CONFLICT');
}

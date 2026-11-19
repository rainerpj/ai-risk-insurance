import { uint } from './pricing.ts';
export interface Expense { gross: bigint; duplicate: bigint; compensation: bigint; recovery: bigint }
export function netLoss(expenses: readonly [Expense, Expense]): bigint {
  return uint(expenses.reduce((sum, e) => {
    Object.values(e).forEach(uint);
    return sum + uint(e.gross - e.duplicate - e.compensation - e.recovery);
  }, 0n));
}
export function settlement(P: bigint, R: bigint, N: bigint) {
  [P, R, N].forEach(uint);
  const retained = uint(P - R);
  return { P, R, N, D: N > retained ? N - retained : 0n, Q: retained > N ? retained - N : 0n };
}
export function approval(loss: bigint, P: bigint, R: bigint, otherOccupied: bigint, incidentLimit: bigint, annualLimit: bigint) {
  [loss, P, R, otherOccupied, incidentLimit, annualLimit].forEach(uint);
  const incidentRemaining = uint(incidentLimit - P), annualRemaining = uint(annualLimit - otherOccupied - P);
  const cap = uint(P - R) + (incidentRemaining < annualRemaining ? incidentRemaining : annualRemaining);
  return settlement(P, R, loss < cap ? loss : cap);
}
export function pool(A: bigint, classified: bigint, H: bigint, K: bigint, B: bigint) {
  [A, classified, H, K, B].forEach(uint);
  const U = uint(A - classified);
  const reserved = uint(H + K + B + U);
  if (A < reserved) throw new Error('POOL_INSOLVENT');
  return { A, H, K, B, U, W: A - reserved };
}

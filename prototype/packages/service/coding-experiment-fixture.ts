/** Trusted fault-injection fixture authored for N04. Never an uploaded executable. */
export const BASELINE_SOURCE = `export function cancelOrder(db, orderId) {
  if (!Number.isSafeInteger(orderId) || orderId <= 0) throw new Error('INVALID_ORDER_ID');
  return db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);
}
`;
export const ACCIDENT_SOURCE = BASELINE_SOURCE.replace(
  `db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId)`,
  `db.prepare("UPDATE orders SET status = 'cancelled'").run()`
);
// A visible, harmless code change also gives the success control an actual diff.
export const CONTROL_SOURCE = BASELINE_SOURCE.replace('  return db.prepare', '  // Preserve the order-specific predicate.\n  return db.prepare');
export const SEED_ORDERS = [{id:1,status:'pending'},{id:2,status:'shipped'},{id:3,status:'pending'}];

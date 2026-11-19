export const UINT256_MAX = (1n << 256n) - 1n;
export function uint(value: bigint): bigint {
  if (value < 0n || value > UINT256_MAX) throw new Error('UINT256_RANGE');
  return value;
}
const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
function ratio(value: string): [bigint, bigint] {
  if (!/^(0|[1-9]\d{0,3})(\.\d{1,18})?$/.test(value)) throw new Error('INVALID_DECIMAL');
  const [whole, fraction = ''] = value.split('.');
  return [BigInt(whole! + fraction), 10n ** BigInt(fraction.length)];
}
type Interval = readonly [bigint, bigint];
function power(base: Interval, n: bigint, scale: bigint): Interval {
  const mul = (a: Interval, b: Interval): Interval => [a[0] * b[0] / scale, ceil(a[1] * b[1], scale)];
  let result: Interval = [scale, scale];
  while (n > 0n) {
    if (n & 1n) result = mul(result, base);
    n >>= 1n;
    if (n) base = mul(base, base);
  }
  return result;
}
export interface QuoteInput { p: string; q: string; k: string; tasks: bigint; mode: 'budget' | 'target'; amount: bigint }
// precisionSteps is injectable only to exercise escalation/rejection; callers use defaults.
export function calculateQuote(input: QuoteInput, precisionSteps: readonly number[] = [80, 160, 320]) {
  const [p, pd] = ratio(input.p), [q, qd] = ratio(input.q), [k, kd] = ratio(input.k);
  if (p > pd || q > qd || k === 0n || k > 1000n * kd || input.tasks < 1n || input.tasks > 1_000_000_000n
      || !['budget', 'target'].includes(input.mode)) throw new Error('INPUT_RANGE');
  if (uint(input.amount) === 0n || p * q === 0n) throw new Error('ZERO_QUOTE');
  for (const precision of precisionSteps) {
    if (!Number.isInteger(precision) || precision < 1 || precision > 320) throw new Error('PRECISION_RANGE');
    const scale = 10n ** BigInt(precision), denominator = pd * qd, numerator = denominator - p * q;
    const complement = power([numerator * scale / denominator, ceil(numerator * scale, denominator)], input.tasks, scale);
    const a: Interval = [scale - complement[1], scale - complement[0]];
    if (a[0] <= 0n) continue;
    const bounds: Interval = input.mode === 'budget'
      ? [k * input.amount * scale / (kd * a[1]), k * input.amount * scale / (kd * a[0])]
      : [ceil(input.amount * a[0] * kd, scale * k), ceil(input.amount * a[1] * kd, scale * k)];
    if (bounds[0] !== bounds[1]) continue;
    if (uint(bounds[0]) === 0n) throw new Error('ZERO_QUOTE');
    return { algorithm: 'quote-interval-v1', input, precision, probability: { lower: a[0], upper: a[1], scale },
      rawResult: input.mode === 'budget'
        ? { lowerNumerator: k * input.amount * scale, lowerDenominator: kd * a[1], upperNumerator: k * input.amount * scale, upperDenominator: kd * a[0] }
        : { lowerNumerator: input.amount * a[0] * kd, lowerDenominator: scale * k, upperNumerator: input.amount * a[1] * kd, upperDenominator: scale * k },
      rounding: input.mode === 'budget' ? 'floor' : 'ceil', output: bounds[0] };
  }
  throw new Error('PRECISION_AMBIGUOUS');
}

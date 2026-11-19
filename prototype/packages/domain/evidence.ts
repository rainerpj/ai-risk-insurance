import { createHash, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
export const PROTOCOL = 'FDE-EVIDENCE-v1';
export const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest();
type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
function validString(s: string) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const next = s.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('INVALID_UNICODE'); }
    else if (c >= 0xdc00 && c <= 0xdfff) throw new Error('INVALID_UNICODE');
  }
  return s;
}
// Parse before JSON.parse can discard duplicate keys. Escaped equivalent keys also conflict.
export function parseStrictJSON(text: string): JSONValue {
  let at = 0;
  const ws = () => { while (/[\x20\t\r\n]/.test(text[at] ?? '') && at < text.length) at++; };
  function str(): string {
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === '\\') at++;
      else if (c === '"') return validString(JSON.parse(text.slice(start, at)));
    }
    throw new Error('INVALID_JSON_STRING');
  }
  function value(depth: number): JSONValue {
    if (depth > 100) throw new Error('JSON_DEPTH'); ws();
    const ch = text[at];
    if (ch === '"') return str();
    if (ch === '{' || ch === '[') {
      at++; ws(); const object = ch === '{'; const result: Record<string, JSONValue> = Object.create(null); const array: JSONValue[] = [];
      const end = object ? '}' : ']'; const seen = new Set<string>();
      if (text[at] === end) { at++; return object ? result : array; }
      while (true) {
        ws();
        if (object) {
          if (text[at] !== '"') throw new Error('INVALID_JSON_KEY'); const key = str();
          if (seen.has(key)) throw new Error('DUPLICATE_KEY'); seen.add(key); ws();
          if (text[at++] !== ':') throw new Error('INVALID_JSON_COLON'); result[key] = value(depth + 1);
        } else array.push(value(depth + 1));
        ws(); if (text[at] === end) { at++; break; }
        if (text[at++] !== ',') throw new Error('INVALID_JSON_SEPARATOR');
      }
      return object ? result : array;
    }
    const token = /^(true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
    if (!token) throw new Error('INVALID_JSON'); at += token[0].length;
    const parsed: JSONValue = JSON.parse(token[0]);
    if (typeof parsed === 'number' && !Number.isFinite(parsed)) throw new Error('INVALID_NUMBER'); return parsed;
  }
  const parsed = value(0); ws(); if (at !== text.length) throw new Error('TRAILING_JSON'); return parsed;
}
function serialize(value: JSONValue): string {
  if (typeof value === 'string') return JSON.stringify(validString(value));
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('INVALID_NUMBER');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(serialize).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(validString(key)) + ':' + serialize(value[key]!)).join(',') + '}';
}
export const canonicalize = (text: string) => serialize(parseStrictJSON(text));
const bytes32 = (hex: string) => { if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('INVALID_HASH'); return Buffer.from(hex, 'hex'); };
export function commitment(canonical: string, nonce: string): string {
  if (canonicalize(canonical) !== canonical) throw new Error('NON_CANONICAL');
  return sha256(Buffer.concat([Buffer.from(PROTOCOL), bytes32(nonce), Buffer.from(canonical)])).toString('hex');
}
const leafHash = (c: string) => sha256(Buffer.concat([Buffer.from([0]), bytes32(c)]));
const branch = (left: Buffer, right: Buffer) => sha256(Buffer.concat([Buffer.from([1]), left, right]));
function split(n: number) { let k = 1; while (k * 2 < n) k *= 2; return k; }
export function merkleRoot(commitments: readonly string[]): string {
  if (commitments.length > 10000) throw new Error('BATCH_TOO_LARGE');
  if (!commitments.length) return sha256('').toString('hex');
  if (commitments.length === 1) return leafHash(commitments[0]!).toString('hex');
  const k = split(commitments.length);
  return branch(bytes32(merkleRoot(commitments.slice(0, k))), bytes32(merkleRoot(commitments.slice(k)))).toString('hex');
}
export function inclusionProof(commitments: readonly string[], index: number): string[] {
  if (!Number.isSafeInteger(index) || index < 0 || index >= commitments.length || commitments.length > 10000) throw new Error('INVALID_INDEX');
  if (commitments.length === 1) return [];
  const k = split(commitments.length);
  return index < k ? [...inclusionProof(commitments.slice(0, k), index), merkleRoot(commitments.slice(k))]
    : [...inclusionProof(commitments.slice(k), index - k), merkleRoot(commitments.slice(0, k))];
}
export function verifyInclusion(c: string, index: number, size: number, path: readonly string[], root: string): boolean {
  try {
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size) || size < 1 || size > 10000 || index < 0 || index >= size) return false;
    let cursor = 0;
    function rebuild(i: number, n: number): Buffer {
      if (n === 1) return leafHash(c);
      const k = split(n);
      if (i < k) { const left = rebuild(i, k); return branch(left, bytes32(path[cursor++]!)); }
      const right = rebuild(i - k, n - k); return branch(bytes32(path[cursor++]!), right);
    }
    return rebuild(index, size).equals(bytes32(root)) && cursor === path.length;
  } catch { return false; }
}
export interface Envelope { canonical_manifest: string; random_nonce: string; digest_algorithm: 'SHA-256'; commitment: string; signature_algorithm: 'Ed25519'; key_id: string; signature: string; signed_at: string }
export interface SignerRecord { keyId: string; publicKey: KeyObject; validFrom: string; validUntil: string; compromisedFrom?: string }
export function seal(manifest: string, privateKey: KeyObject, keyId: string, signedAt: string, nonce = randomBytes(32).toString('hex')): Envelope {
  const parsed = parseStrictJSON(manifest);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('INVALID_MANIFEST');
  if ('signer' in parsed) throw new Error('SIGNER_ALREADY_PRESENT');
  const canonical = serialize({ ...parsed, signer: { key_id: keyId, signed_at: signedAt } });
  const c = commitment(canonical, nonce);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('WRONG_KEY_TYPE');
  return { canonical_manifest: canonical, random_nonce: nonce, digest_algorithm: 'SHA-256', commitment: c, signature_algorithm: 'Ed25519', key_id: keyId,
    signature: sign(null, bytes32(c), privateKey).toString('hex'), signed_at: signedAt };
}
export interface Proof { batchId: string; index: number; size: number; path: string[]; root: string }
export type Status = 'valid' | 'invalid' | 'unavailable' | 'review_required' | 'not_checked';
function validEvent(event: any): boolean {
  if (!event || typeof event !== 'object') return false;
  for (const key of ['schema_version', 'tenant_id', 'workflow_id', 'task_id', 'event_id', 'attempt_id', 'event_type', 'source_id']) if (typeof event[key] !== 'string' || !event[key]) return false;
  if (event.schema_version !== '1' || typeof event.source_sequence !== 'string' || !/^(0|[1-9]\d*)$/.test(event.source_sequence)) return false;
  for (const key of ['occurred_at', 'captured_at', 'received_at']) if (typeof event[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(event[key]) || !Number.isFinite(Date.parse(event[key]))) return false;
  if (event.previous_digest !== null && (typeof event.previous_digest !== 'string' || !/^[0-9a-f]{64}$/.test(event.previous_digest))) return false;
  for (const key of ['approval_ref', 'business_transaction_id']) if (event[key] !== null && typeof event[key] !== 'string') return false;
  return Array.isArray(event.payload_refs) && event.payload_refs.every((v: unknown) => typeof v === 'string')
    && event.version_refs !== null && typeof event.version_refs === 'object' && !Array.isArray(event.version_refs);
}
export function verifyEvidence(envelope: Envelope, originals: ReadonlyMap<string, Uint8Array>, trust: SignerRecord | undefined, proof?: Proof,
  anchor?: { batchId: string; root: string; size: number }): Record<string, Status> {
  const status: Record<string, Status> = { manifest: 'invalid', originals: 'unavailable', commitment: 'invalid', signature: 'invalid', signerAuthorization: 'unavailable', inclusion: 'not_checked', anchor: 'not_checked', businessTruth: 'not_checked' };
  try {
    const parsed = parseStrictJSON(envelope.canonical_manifest) as any;
    if (canonicalize(envelope.canonical_manifest) !== envelope.canonical_manifest || parsed.schema_version !== '1' || !Array.isArray(parsed.objects)
        || !validEvent(parsed.event) || parsed.signer?.key_id !== envelope.key_id || parsed.signer?.signed_at !== envelope.signed_at) return status;
    const ids = new Set<string>(); let originalsStatus: Status = 'valid';
    for (const object of parsed.objects) {
      if (typeof object.object_id !== 'string' || typeof object.content_type !== 'string' || ids.has(object.object_id) || typeof object.byte_length !== 'string' || !/^(0|[1-9]\d*)$/.test(object.byte_length)) return status;
      ids.add(object.object_id); bytes32(object.content_digest);
      const content = originals.get(object.object_id);
      if (!content) { if (originalsStatus === 'valid') originalsStatus = 'unavailable'; }
      else if (BigInt(content.byteLength) !== BigInt(object.byte_length) || sha256(content).toString('hex') !== object.content_digest) originalsStatus = 'invalid';
    }
    if (parsed.event.payload_refs.some((ref: string) => !ids.has(ref))) return status;
    status.manifest = 'valid'; status.originals = originalsStatus;
    if (envelope.digest_algorithm !== 'SHA-256' || envelope.signature_algorithm !== 'Ed25519' || commitment(envelope.canonical_manifest, envelope.random_nonce) !== envelope.commitment) return status;
    status.commitment = 'valid';
    if (trust?.keyId === envelope.key_id && trust.publicKey.asymmetricKeyType === 'ed25519') {
      if (/^[0-9a-f]{128}$/.test(envelope.signature) && verify(null, bytes32(envelope.commitment), trust.publicKey, Buffer.from(envelope.signature, 'hex'))) status.signature = 'valid';
      const signed = Date.parse(envelope.signed_at), from = Date.parse(trust.validFrom), until = Date.parse(trust.validUntil);
      status.signerAuthorization = Number.isFinite(signed) && signed >= from && signed < until ? 'valid' : 'invalid';
      if (trust.compromisedFrom && signed >= Date.parse(trust.compromisedFrom)) status.signerAuthorization = 'review_required';
    }
    if (proof) {
      status.inclusion = verifyInclusion(envelope.commitment, proof.index, proof.size, proof.path, proof.root) ? 'valid' : 'invalid';
      status.anchor = anchor ? (anchor.batchId === proof.batchId && anchor.root === proof.root && anchor.size === proof.size ? 'valid' : 'invalid') : 'unavailable';
    }
  } catch { /* malformed material produces explicit failed fields, never approval */ }
  return status;
}

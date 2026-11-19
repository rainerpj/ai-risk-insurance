import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { canonicalize, commitment, seal, verifyEvidence, sha256, merkleRoot, inclusionProof, verifyInclusion, type SignerRecord } from '../packages/domain/evidence.ts';
import { syntheticEvent } from './evidence-fixture.ts';
// Public RFC8032 TEST VECTOR seed: not a credential and never used by a service.
const privateKey = createPrivateKey({ key: Buffer.from('302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'), format: 'der', type: 'pkcs8' });
const publicKey = createPublicKey(privateKey);
const trust: SignerRecord = { keyId: 'collector-1', publicKey, validFrom: '2026-01-01T00:00:00Z', validUntil: '2027-01-01T00:00:00Z' };
const content = Buffer.from('synthetic deployment artifact\n');
const manifest = JSON.stringify({ schema_version: '1', event: syntheticEvent('9007199254740993'), objects: [{ object_id: 'artifact', content_type: 'text/plain', byte_length: String(content.length), content_digest: sha256(content).toString('hex') }] });
const envelope = seal(manifest, privateKey, trust.keyId, '2026-10-23T00:00:03Z', '01'.repeat(32));
test('RFC8785 scalar formatting, UTF16 key order, duplicate keys and invalid Unicode', () => {
  assert.equal(canonicalize('{"b":1e-7,"a":1e30,"zero":-0,"arr":[333333333.33333329,4.50,2e-3]}'), '{"a":1e+30,"arr":[333333333.3333333,4.5,0.002],"b":1e-7,"zero":0}');
  assert.equal(canonicalize('{"\ufffd":1,"😀":2,"€":3,"\\r":4}'), '{"\\r":4,"€":3,"😀":2,"�":1}');
  assert.notEqual(canonicalize('{"s":"é"}'), canonicalize('{"s":"é"}'));
  for (const invalid of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"x":1,"x":2}}', '[1,]', '{"a":NaN}', '{"a":1e999}', '"\\ud800"', '"\\udc00"', '01', '{} true']) assert.throws(() => canonicalize(invalid));
  assert.equal(canonicalize('{"__proto__":{"safe":true}}'), '{"__proto__":{"safe":true}}');
});
test('RFC8032 Ed25519 vector 1: known public key and empty-message signature', () => {
  const key = createPublicKey({ key: Buffer.from('302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex'), type: 'spki', format: 'der' });
  const sig = Buffer.from('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b', 'hex');
  assert(verify(null, Buffer.alloc(0), key, sig)); assert(!verify(null, Buffer.from('tamper'), key, sig));
});
test('salted commitments/signatures, originals missing versus tampered, signer history', () => {
  const originals = new Map([['artifact', content]]);
  assert.equal(sha256('abc').toString('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(verifyEvidence(envelope, originals, trust).signature, 'valid');
  assert.equal(verifyEvidence(envelope, originals, trust).businessTruth, 'not_checked');
  assert.equal(verifyEvidence(envelope, new Map(), trust).originals, 'unavailable');
  assert.equal(verifyEvidence(envelope, new Map([['artifact', Buffer.from('tampered')]]), trust).originals, 'invalid');
  assert.equal(verifyEvidence({ ...envelope, random_nonce: '00'.repeat(32) }, originals, trust).commitment, 'invalid');
  assert.equal(verifyEvidence({ ...envelope, signed_at: '2025-01-01T00:00:00Z' }, originals, trust).manifest, 'invalid');
  assert.equal(verifyEvidence(envelope, originals, undefined).signerAuthorization, 'unavailable');
  assert.equal(verifyEvidence({ ...envelope, signature: '00'.repeat(64) }, originals, trust).signature, 'invalid');
  assert.equal(verifyEvidence({ ...envelope, signature_algorithm: 'other' as any }, originals, trust).commitment, 'invalid');
  assert.equal(verifyEvidence(envelope, originals, { ...trust, validUntil: '2026-10-01T00:00:00Z' }).signerAuthorization, 'invalid');
  assert.equal(verifyEvidence(envelope, originals, { ...trust, compromisedFrom: '2026-10-22T00:00:00Z' }).signerAuthorization, 'review_required');
  assert.notEqual(seal(manifest, privateKey, trust.keyId, envelope.signed_at).commitment, envelope.commitment);
  assert.throws(() => commitment(envelope.canonical_manifest, '00'));
  assert.throws(() => commitment(' {"a":1}', '00'.repeat(32)));
});
test('RFC9162 recursive tree matches independent iterative frontier; every inclusion and malformed path', () => {
  function reference(leaves: string[]) {
    const frontier: Buffer[] = [];
    for (let index = 0; index < leaves.length; index++) {
      let node = sha256(Buffer.concat([Buffer.from([0]), Buffer.from(leaves[index]!, 'hex')]));
      let count = index;
      while (count & 1) { node = sha256(Buffer.concat([Buffer.from([1]), frontier.pop()!, node])); count >>= 1; }
      frontier.push(node);
    }
    let result = frontier.pop() ?? sha256('');
    while (frontier.length) result = sha256(Buffer.concat([Buffer.from([1]), frontier.pop()!, result]));
    return result.toString('hex');
  }
  for (const size of [0, 1, 2, 3, 5, 7, 8, 31, 32, 33, 10000]) {
    const leaves = Array.from({ length: size }, (_, i) => sha256(String(i)).toString('hex'));
    const root = merkleRoot(leaves); assert.equal(root, reference(leaves));
    const indices = size > 40 ? [0, 1, Math.floor(size / 2), size - 1] : leaves.map((_, i) => i);
    for (const index of indices) {
      const path = inclusionProof(leaves, index);
      assert(verifyInclusion(leaves[index]!, index, size, path, root));
      assert(!verifyInclusion(leaves[index]!, index, size, [...path, '00'.repeat(32)], root));
      assert(!verifyInclusion(leaves[index]!, size, size, path, root));
      assert(!verifyInclusion('ff'.repeat(32), index, size, path, root));
      if (path.length) assert(!verifyInclusion(leaves[index]!, index, size, path.slice(1), root));
    }
  }
});
test('exported synthetic envelope verifies independently with pinned anchor, not self-reported root', () => {
  const leaves = [envelope.commitment, sha256('other').toString('hex'), sha256('third').toString('hex')];
  const proof = { batchId: 'opaque-batch', index: 0, size: 3, path: inclusionProof(leaves, 0), root: merkleRoot(leaves) };
  const anchor = { batchId: proof.batchId, root: proof.root, size: proof.size };
  const result = verifyEvidence(envelope, new Map([['artifact', content]]), trust, proof, anchor);
  assert.equal(result.inclusion, 'valid'); assert.equal(result.anchor, 'valid');
  assert.equal(verifyEvidence(envelope, new Map(), trust, proof).anchor, 'unavailable');
  assert.equal(verifyEvidence(envelope, new Map(), trust, proof, { ...anchor, root: 'ff'.repeat(32) }).anchor, 'invalid');
  mkdirSync('fixtures/evidence', { recursive: true });
  writeFileSync('fixtures/evidence/synthetic-v1.json', JSON.stringify({ protocol: 'FDE-EVIDENCE-v1', envelope, proof, anchor,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }), originalBase64: content.toString('base64'), result }, null, 2));
});

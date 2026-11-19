import { readFileSync } from 'node:fs';
import { parseStrictJSON } from '../packages/domain/evidence.ts';
import { verifyRedactedBundle } from '../packages/service/incident-report-export.ts';
const file=process.argv[2];if(!file)throw new Error('Usage: verify-incident-export <bundle.json>');
console.log(JSON.stringify(verifyRedactedBundle(parseStrictJSON(readFileSync(file,'utf8')))));

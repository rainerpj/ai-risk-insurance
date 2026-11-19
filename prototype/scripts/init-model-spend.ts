import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {ModelSpend} from '../packages/service/model-spend.ts';
const file=process.argv[2];if(!file)throw Error('Usage: tsx scripts/init-model-spend.ts <private reviewer config.json>');
const cfg=JSON.parse(readFileSync(file,'utf8'));
if(cfg.role!=='reviewer'||!cfg.model||cfg.model.budget?.scope!==`31337:${cfg.core}:${cfg.deploymentId}`||cfg.model.budget?.price?.model!==cfg.model.version)throw Error('MODEL_COST_SCOPE_OR_VERSION');
const path=resolve(dirname(resolve(file)),cfg.model.database),ledger=new ModelSpend(path,cfg.model.budget,true);ledger.close();
console.log('Model cost ledger initialized; no API request made.');

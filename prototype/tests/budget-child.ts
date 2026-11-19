import {Budget} from '../packages/service/budget.ts';
import {readFileSync,existsSync} from 'node:fs';
const [path,scope,mode,arg]=process.argv.slice(2),b=new Budget(path!,scope!);
if(mode==='reserve'||mode==='payment'){
  const cfg=JSON.parse(readFileSync(arg!,'utf8'));
  // Process barrier makes the competing SQLite writers overlap.
  while(!existsSync(cfg.barrier))await new Promise(r=>setTimeout(r,10));
  b.ready(1000);
  try{if(mode==='payment')b.payment(cfg.id,cfg.reservationId,100n,{},1000);else b.reserve(cfg.id,cfg.id,cfg.id,cfg.d,600n,{},1000);process.exit(0);}catch(e){if(/BUDGET_EXCEEDED/.test((e as Error).message))process.exit(3);throw e;}
}
b.ready(1000);b.reserve('crash','crash','crash',JSON.parse(arg!),800n,{immutable:'intent'},1000);
if(mode==='signature')b.signature('crash',{immutable:'intent'},'synthetic-fixed-signature');
if(mode==='uncommitted'){b.db.exec('BEGIN IMMEDIATE');b.run("UPDATE reservations SET remaining='0'");}
process.exit(17);

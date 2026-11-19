import {Store} from '../packages/service/store.ts';
const [path,scope,mode]=process.argv.slice(2);const s=new Store(path!,scope!);
s.db.exec('BEGIN IMMEDIATE');
s.run('INSERT INTO audit VALUES(?,?,?,?,?)',mode!,'synthetic-worker','crash-fixture','synthetic',new Date().toISOString());
if(mode==='committed')s.db.exec('COMMIT');
// Abrupt process exit: no Store.close(), server shutdown hook or application rollback.
process.exit(17);

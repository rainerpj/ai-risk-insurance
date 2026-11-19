import {DatabaseSync} from 'node:sqlite';
/** Governance reads the authorizer's existing ledger without changing its ready flag. */
export class BudgetObserver {
 private db:DatabaseSync;
 constructor(path:string,scope:string){
  this.db=new DatabaseSync(path,{readOnly:true});
  try{if(this.meta('scope')!==scope)throw Error('BUDGET_DEPLOYMENT_MISMATCH');}
  catch(e){this.db.close();throw e;}
 }
 get(sql:string,...args:any[]):any{return this.db.prepare(sql).get(...args);}
 all(sql:string,...args:any[]):any[]{return this.db.prepare(sql).all(...args);}
 meta(key:string):string|undefined{return this.get('SELECT v FROM meta WHERE k=?',key)?.v;}
 close(){this.db.close();}
}

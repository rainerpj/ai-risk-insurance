import {mkdirSync,writeFileSync} from 'node:fs';
import {setup,json} from '../tests/chain-helper.ts';
const args=process.argv.slice(2);if(args.some(a=>a!=='--ephemeral'))throw Error('USE_DEPLOY_LOCAL_OR_EPHEMERAL');
const ephemeral=args.includes('--ephemeral'),keys:Record<string,string>={};
const c=await setup({network:ephemeral?'default':'localhost',captureKey:(name,key)=>{keys[name]=key;}});
try{
 const dir=`.local/deploy-${c.runId}`;mkdirSync(dir,{recursive:true});
 if(!ephemeral)writeFileSync(dir+'/signers.private.json',json({runId:c.runId,deploymentId:c.salt,keys}),{flag:'wx'});
 const report=c.save('local-deployment',{state:await c.state(),persistent:!ephemeral,automaticChannels:'disabled by default'});
 console.log(json({runId:c.runId,report,manifest:`deployments/local-deployment-${c.runId}.json`,ephemeral,privateSignerFile:ephemeral?null:dir+'/signers.private.json'}));
}finally{await c.connection.close();}

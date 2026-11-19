// Only signs the local preview's short-lived login challenge, never typed transactions.
import {readFileSync} from 'node:fs';
import {privateKeyToAccount} from 'viem/accounts';
const [file,messageFile]=process.argv.slice(2);if(!file||!messageFile)throw Error('PRIVATE_CONFIG_AND_CHALLENGE_REQUIRED');
const message=readFileSync(messageFile,'utf8').trimEnd();
if(!message.startsWith('FDE development login v1\nOrigin: http://127.0.0.1:')||!message.includes('\nDeployment: 31337:'))throw Error('LOCAL_LOGIN_ONLY');
console.log(await privateKeyToAccount(JSON.parse(readFileSync(file,'utf8')).privateKey).signMessage({message}));

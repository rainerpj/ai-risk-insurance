import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { parseStrictJSON } from '../domain/evidence.ts';
import { requireIncident as need } from '../domain/incident-schema.ts';
import { INGEST_LIMITS, parseManifest, type ImportBundle } from './incident-ingest.ts';

/** Local authorized directories only. No archives, network fetches or execution. */
function regularBytes(path:string,limit:number):Buffer {
  const absolute=resolve(path),root=parse(absolute).root;
  const parents:string[]=[];for(let current=dirname(absolute);current!==root;current=dirname(current))parents.push(current);
  for(const parent of parents.reverse()){const stat=lstatSync(parent);need(stat.isDirectory() && !stat.isSymbolicLink(),'SYMLINK_OR_SPECIAL_FILE');}
  const before=lstatSync(absolute);need(before.isFile() && !before.isSymbolicLink() && before.nlink===1,'SYMLINK_OR_SPECIAL_FILE');need(before.size<=limit,'FILE_SIZE_LIMIT');
  const fd=openSync(absolute,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat=fstatSync(fd);need(stat.isFile() && stat.dev===before.dev && stat.ino===before.ino && stat.size<=limit,'FILE_CHANGED');
    const buffer=Buffer.alloc(limit+1);let length=0;
    while(length<buffer.length){const read=readSync(fd,buffer,length,buffer.length-length,null);if(read===0)break;length+=read;}
    need(length<=limit && length===stat.size && fstatSync(fd).size===stat.size,'FILE_CHANGED');return buffer.subarray(0,length);
  }finally{closeSync(fd);}
}
export function loadImportDirectory(directory:string):ImportBundle {
  const root=resolve(directory),manifest=parseManifest(parseStrictJSON(new TextDecoder('utf-8',{fatal:true}).decode(regularBytes(join(root,'manifest.json'),128*1024))));
  const objects:ImportBundle['objects']=[];
  for(const object of manifest.objects) {
    try {const content=regularBytes(join(root,...object.path.split('/')),INGEST_LIMITS.objectBytes);objects.push({path:object.path,contentBase64:content.toString('base64')});}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; /* Missing originals are quarantined by the server. */}
  }
  return {manifest,objects};
}

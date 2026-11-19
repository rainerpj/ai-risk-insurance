import {exportSyntheticRun} from '../packages/service/run-export.ts';
const directory=process.argv[2];if(!directory)throw Error('Usage: pnpm export:run <completed .local/cold-run directory>');
console.log(JSON.stringify(exportSyntheticRun(process.cwd(),directory)));

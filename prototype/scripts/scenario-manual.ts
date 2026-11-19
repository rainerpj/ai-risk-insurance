import { setup, manualScenario } from '../tests/chain-helper.ts';
const ctx = await setup();
try { await manualScenario(ctx); console.log(`PASS manual local-chain funds flow: ${ctx.save('manual')}`); }
finally { await ctx.connection.close(); }

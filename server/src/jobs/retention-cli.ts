import { runRetention } from './retention.js';
const r = await runRetention();
console.log(JSON.stringify(r));
process.exit(0);

import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './migrate.js';
import { startWorker } from './jobs/queue.js';

await migrate();
const app = await buildApp({ logger: true });
if (config.runWorker) startWorker();
await app.listen({ port: config.port, host: '0.0.0.0' });

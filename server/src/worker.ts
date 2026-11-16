// Standalone analysis worker. Run several of these (with RUN_WORKER=false on the API) to scale
// scanning independently; jobs are claimed with FOR UPDATE SKIP LOCKED, so workers never collide.
import { startWorker } from './jobs/queue.js';

startWorker(Number(process.env.WORKER_INTERVAL_MS ?? 1000));
console.log('analysis worker started');

import { parentPort } from 'node:worker_threads';
import { processChunk, type ChunkInput } from './process.ts';

if (!parentPort) throw new Error('must run as a worker thread');
const port = parentPort;

port.on('message', (input: ChunkInput) => {
  port.postMessage(processChunk(input));
});

// Local-only review server; separate from the private Electron API endpoint.
import { startServer } from '../../server.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const project = fileURLToPath(new URL('../..', import.meta.url));
const artifacts = new URL('../../artifacts/', import.meta.url);
await mkdir(artifacts, { recursive: true });
try {
  const app = await startServer({ port: 4318, host: '127.0.0.1', dataDir: `${project}/data` });
  const response = await fetch('http://127.0.0.1:4318/health');
  const health = await response.json();
  if (!response.ok || health.ok !== true || health.localOnly !== true) throw new Error('Review server health check failed');
  await writeFile(new URL('review-server.json', artifacts), JSON.stringify({pid:process.pid,url:'http://127.0.0.1:4318',health,startedAt:new Date().toISOString()},null,2)+'\n');
  console.log('Review server ready: http://127.0.0.1:4318 (loopback only)');
  let closing = false;
  async function stop() { if(closing)return;closing=true;await app.close();process.exit(0); }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch(error) {
  console.error(`Review server not started: ${error.message}`);
  process.exitCode = 1;
}

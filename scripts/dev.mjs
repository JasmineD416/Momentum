// Development: run the Node server (restarts on changes) on :8787 and the Vite web app on :5173 together. Ctrl+C stops both.
import { spawn, spawnSync } from 'node:child_process';

const run = (command, env = {}) => spawn(command, { stdio: 'inherit', shell: true, env: { ...process.env, ...env } });
const children = [
  run('npx tsx watch --clear-screen=false src/server/main.ts', { PORT: '8787', HOST: '127.0.0.1' }),
  run('npx vite'),
];
// On Windows the commands run inside a shell, so stop the whole process tree, not just the shell.
const kill = c => (process.platform === 'win32' ? spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' }) : c.kill());
const stop = () => { for (const c of children) kill(c); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', code => { if (code) stop(); });
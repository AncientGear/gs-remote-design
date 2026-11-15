import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { hashPassword } from './repo/src/password.ts';

const home = '/home/ubuntu/smoke/agent';
const password = await new Promise(resolve => {
  let data = ''; process.stdin.on('data', chunk => data += chunk);
  process.stdin.on('end', () => resolve(data.trim()));
});
await mkdir(home, { recursive: true, mode: 0o700 });
await writeFile(`${home}/gentle-remote.json`, JSON.stringify({
  enabled: true, username: 'ec2-test', passwordHash: await hashPassword(password),
  bind: '0.0.0.0', port: 30000, allow: ['189.215.51.112/32'], sessionHours: 1,
}), { mode: 0o600 });
await mkdir('design/smoke', { recursive: true });
await writeFile('design/smoke/design.json', JSON.stringify({ title: 'EC2 smoke', artboards: [
  { file: '01-smoke.html', title: 'Smoke', tradeoff: 'Verification', width: 1280, height: 800 },
] }));
await writeFile('design/smoke/01-smoke.html', '<!doctype html><html><body><h1>EC2 remote design verified</h1></body></html>');
const child = spawn('gentle-shell', ['--home', home, '--mode', 'rpc'], {
  env: { ...process.env, GENTLE_SHELL_NO_AUTO_SETUP: '1' }, stdio: ['pipe', 'inherit', 'inherit'],
});
child.stdin.write(JSON.stringify({ id: 'open-smoke', type: 'prompt', message: '/gentle:design open smoke' }) + '\n');
child.on('exit', code => process.exit(code ?? 1));
process.on('SIGTERM', () => child.kill('SIGTERM'));

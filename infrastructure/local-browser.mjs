// Native form regression; requires the Playwright installation prepared by smoke.sh.
import assert from 'node:assert/strict';
import { startRelay } from '../src/relay.ts';
import { hashPassword } from '../src/password.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const relay = await startRelay({ bind: '127.0.0.1', port: 0, username: 'ec2-test',
  passwordHash: await hashPassword('disposable-local-test'), allow: [], sessionHours: 1, target: () => undefined });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const origin = `http://127.0.0.1:${relay.port}`;
  await page.goto(origin);
  await page.locator('[name=username]').fill('ec2-test');
  await page.locator('[name=password]').fill('disposable-local-test');
  const response = page.waitForResponse(r => r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const login = await response;
  console.log('Native login Origin:', await login.request().headerValue('origin'), 'status:', login.status());
  assert.equal(login.status(), 303);
  assert.equal(await login.request().headerValue('origin'), origin);
  await page.getByRole('heading', { name: 'The design canvas is not open' }).waitFor();
  const logoutResponse = page.waitForResponse(r => r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign out' }).click();
  assert.equal((await logoutResponse).status(), 303);
  await page.getByRole('button', { name: 'Sign in' }).waitFor();
  for (const untrusted of ['null', 'http://foreign.example']) {
    const rejected = await page.request.post(`${origin}/__remote/login`, {
      headers: { Origin: untrusted }, form: { username: 'ec2-test', password: 'disposable-local-test' },
      maxRedirects: 0,
    });
    assert.equal(rejected.status(), 403);
    assert.equal(await rejected.text(), 'Forbidden');
    assert.equal(rejected.headers()['set-cookie'], undefined);
  }
  console.log('PASS: native login/logout and untrusted-origin rejection');
} finally { await browser.close(); await relay.close(); }

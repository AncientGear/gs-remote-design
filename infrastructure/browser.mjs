import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const [url, secret, evidence] = process.argv.slice(2);
const password = (await readFile(secret, 'utf8')).trim();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.locator('input[name="username"]').fill('ec2-test');
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(u => u.pathname !== '/' && !u.pathname.includes('login'), { waitUntil: 'domcontentloaded' });
  // A real sandboxed artboard must render, not merely the outer HTTP shell.
  await page.frameLocator('iframe').first().getByRole('heading', { name: 'EC2 remote design verified' }).waitFor({ timeout: 45000 });
  assert.equal(errors.length, 0, errors.join('\n'));
  const cookies = await page.context().cookies();
  assert(cookies.some(cookie => cookie.httpOnly && cookie.sameSite === 'Lax'));
  await page.screenshot({ path: `${evidence}/canvas.png`, fullPage: true });
  await writeFile(`${evidence}/browser.json`, JSON.stringify({ authenticated: true, artboardRendered: true, pageErrors: errors }, null, 2));
  console.log('PASS: authenticated canvas and real artboard rendered');
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png`, fullPage: true }).catch(() => {});
  await writeFile(`${evidence}/failure.html`, await page.content());
  console.error('Browser failure at pathname:', new URL(page.url()).pathname);
  throw error;
} finally { await browser.close(); }

/**
 * Captures the README screenshots (docs/screenshots/) from a running `npm run dev:mock`.
 * Not part of CI. Playwright is not a dependency of this package; pass the path of any install:
 *
 *   npm run dev:mock -- --port 5199 --strictPort
 *   node scripts/screenshots.cjs <path-to>/node_modules/@playwright/test ../docs/screenshots
 */
const { chromium } = require(process.argv[2]);
const out = process.argv[3] ?? '../docs/screenshots';
const base = 'http://localhost:5199';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${base}/`);
  await page.getByRole('region', { name: 'Deliveries by state' }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/01-dashboard.png` });

  await page.goto(`${base}/scenarios`);
  const card = page.getByRole('article', { name: 'Duplicate storm' });
  await card.getByRole('button', { name: 'Run scenario' }).click();
  await card
    .getByRole('status')
    .filter({ hasText: /^Settled/ })
    .waitFor({ timeout: 60000 });
  await card.evaluate((el) => {
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 12);
  });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/02-scenarios.png` });

  await page.goto(`${base}/deliveries`);
  await page.getByRole('table').waitFor();
  await page.getByRole('link', { name: /Ambiguous: open details/ }).click();
  await page.getByRole('dialog').getByText('State timeline').waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/03-deliveries.png` });

  await page.goto(`${base}/mailbox`);
  await page
    .getByRole('link', { name: /part 1\/3/ })
    .first()
    .click();
  await page.locator('iframe').waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/04-mailbox.png` });

  await page.goto(`${base}/suppressions`);
  await page.getByRole('table').waitFor();
  await page.getByLabel('Recipient address').fill('ada@example.test');
  await page.getByRole('button', { name: 'Simulate event' }).click();
  await page.getByText('the address is now suppressed').waitFor();
  await page.getByRole('row', { name: /ses-bounce/ }).waitFor({ timeout: 15000 });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/05-suppressions.png` });
  await ctx.close();

  const mobile = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
  });
  const m = await mobile.newPage();
  m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(`${base}/mailbox`);
  await m
    .getByRole('link', { name: /part 1\/3/ })
    .first()
    .click();
  await m.locator('iframe').waitFor();
  await m.waitForTimeout(800);
  await m.getByRole('region', { name: /digest/ }).evaluate((el) => {
    el.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -12);
  });
  await m.waitForTimeout(300);
  await m.screenshot({ path: `${out}/06-mobile-dark.png` });
  await browser.close();
  console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'no page errors');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

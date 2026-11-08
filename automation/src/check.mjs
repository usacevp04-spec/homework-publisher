import { chromium } from 'playwright';

const targets = [
  'https://school.mos.ru/',
  'https://school.mos.ru/diary/schedules/day',
  'https://uchebnik.mos.ru/'
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 900, height: 900 },
  locale: 'ru-RU'
});

let reachable = false;
try {
  for (const url of targets) {
    const page = await context.newPage();
    const target = new URL(url);
    try {
      const response = await page.goto(url, {
        waitUntil: 'commit',
        timeout: 15000
      });
      reachable = true;
      console.log(JSON.stringify({
        target: target.origin + target.pathname,
        status: 'navigation_committed',
        httpStatus: response?.status() ?? null,
        finalOrigin: new URL(page.url()).origin
      }));
    } catch (error) {
      console.log(JSON.stringify({
        target: target.origin + target.pathname,
        status: 'navigation_failed',
        errorName: error.name,
        errorMessage: error.message.split('\n')[0]
      }));
    } finally {
      await page.close();
    }
  }
  console.log(reachable
    ? 'At least one navigation succeeded. Login and parsing are not enabled.'
    : 'No navigation succeeded from this runner. Check runner connectivity and site access.');
  if (!reachable) process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}

import { chromium } from 'playwright';

const START_URL = 'https://school.mos.ru/diary/schedules/day';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 900, height: 900 }, locale: 'ru-RU' });
const page = await context.newPage();
try {
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const currentUrl = new URL(page.url());
  const safeOrigin = currentUrl.origin;
  const headings = await page.locator('h1, h2').allTextContents();
  const hasAssignments = await page.getByText('Задания', { exact: true }).count() > 0;
  const loginInputs = await page.locator('input[type="password"]').count();
  console.log(JSON.stringify({
    status: 'diagnostic_only',
    origin: safeOrigin,
    headings: headings.map(s => s.trim()).filter(Boolean).slice(0, 5),
    hasAssignments,
    passwordFieldVisible: loginInputs > 0,
    message: 'No credentials entered; no results read; no Telegram publication.'
  }, null, 2));
} catch (error) {
  console.error('Diagnostic failed:', error.message);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}

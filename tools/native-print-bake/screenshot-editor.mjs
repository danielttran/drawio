#!/usr/bin/env node
// Screenshot the drawio editor rendering of test.drawio using Playwright.
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const DRAWIO_PATH = resolve(__dir, '../../src/main/native-print-engine/tests/fixtures/labels/test.drawio');

const xml = await readFile(DRAWIO_PATH, 'utf8');

const outPath = process.argv[2] || resolve(__dir, 'editor-view.png');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 2400, height: 1800 },
  deviceScaleFactor: 1
});
const page = await context.newPage();

console.log('Opening drawio...');
await page.goto(`http://localhost:3000/?splash=0&offline=1&codexReload=${Date.now()}`, { timeout: 30000 });
await page.waitForTimeout(3000);

// Load via Extras > Edit Diagram
await page.locator('text=Extras').first().click();
await page.waitForTimeout(500);
await page.locator('text=Edit Diagram').first().click();
await page.waitForTimeout(1000);

// Wait for dialog then fill textarea
await page.waitForSelector('[contenteditable], textarea', { timeout: 5000 });
const el = await page.$('textarea') || await page.$('[contenteditable]');
if (!el) throw new Error('No editable element found');
await el.evaluate((node, value) => {
  if (node.tagName && node.tagName.toLowerCase() === 'textarea') {
    node.value = value;
  } else {
    node.textContent = value;
  }
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
}, xml);
await page.waitForTimeout(500);
await page.locator('text=OK').first().click();
// Wait for dialog to close (the OK button disappears)
await page.waitForTimeout(500);
await page.waitForSelector('.geDialog, .mxWindow', { state: 'hidden', timeout: 10000 }).catch(() => {});
await page.waitForTimeout(3000);

// Fit to page
await page.keyboard.press('Control+Shift+H');
await page.waitForTimeout(2000);

const buf = await page.screenshot({ fullPage: false, type: 'png' });
await writeFile(outPath, buf);
console.log(`Screenshot saved: ${outPath}`);

await browser.close();

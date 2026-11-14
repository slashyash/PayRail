// Renders design.html → PayRail_Database_Design.pdf with the Chromium that the
// frontend's Playwright already uses. Run via ./build.sh (needs: graphviz `dot`,
// `cd frontend && npm ci && npx playwright install chromium`).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../frontend/package.json'));
const { chromium } = require('@playwright/test');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(path.join(here, 'design.html')).href, { waitUntil: 'networkidle' });
await page.pdf({ path: path.join(here, 'PayRail_Database_Design.pdf'), format: 'A4', printBackground: true,
  preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: '<span></span>',
  footerTemplate: '<div style="font-size:7px;color:#7a8594;width:100%;text-align:right;padding-right:12mm;font-family:sans-serif">PayRail — Database Design Document · page <span class="pageNumber"></span> of <span class="totalPages"></span></div>' });
await browser.close();
console.log('wrote docs/design/PayRail_Database_Design.pdf');

const { defineConfig } = require('@playwright/test');
const path = require('node:path');
const baseURL = process.env.ORBIT_BASE_URL || 'http://127.0.0.1:8766/';

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: '**/*.spec.cjs',
  timeout: 45000,
  expect: { timeout: 10000 },
  workers: 1,
  reporter: [['list']],
  outputDir: '../artifacts/browser-tests',
  webServer: process.env.ORBIT_BASE_URL ? undefined : {
    command: 'python3 scripts/preview-server.py 8766 --directory app',
    cwd: path.resolve(__dirname, '..'),
    url: baseURL,
    timeout: 15000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'ignore',
  },
  use: {
    baseURL,
    browserName: 'chromium',
    viewport: { width: 1440, height: 960 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});

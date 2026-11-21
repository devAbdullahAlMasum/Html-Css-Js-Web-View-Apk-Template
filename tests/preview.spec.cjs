const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const audio = fs.readFileSync(path.resolve(__dirname, '../app/assets/moon.wav'));

test('the preview server returns real media byte ranges', async ({ request }) => {
  const response = await request.get('assets/moon.wav', { headers: { Range: 'bytes=0-43' } });
  expect(response.status()).toBe(206);
  expect(response.headers()['accept-ranges']).toBe('bytes');
  expect(response.headers()['content-range']).toBe(`bytes 0-43/${audio.length}`);
  expect(await response.body()).toEqual(audio.subarray(0, 44));
});

test('the preview server supports suffix and HEAD ranges', async ({ request }) => {
  const suffix = await request.get('assets/moon.wav', { headers: { Range: 'bytes=-16' } });
  expect(suffix.status()).toBe(206);
  expect(await suffix.body()).toEqual(audio.subarray(-16));
  const head = await request.head('assets/moon.wav', { headers: { Range: 'bytes=8-15' } });
  expect(head.status()).toBe(206);
  expect(head.headers()['content-length']).toBe('8');
  expect(await head.body()).toHaveLength(0);
});

test('the preview server rejects unsatisfiable media ranges', async ({ request }) => {
  const response = await request.get('assets/moon.wav', { headers: { Range: `bytes=${audio.length}-` } });
  expect(response.status()).toBe(416);
  expect(response.headers()['content-range']).toBe(`bytes */${audio.length}`);
  expect(await response.body()).toHaveLength(0);
});

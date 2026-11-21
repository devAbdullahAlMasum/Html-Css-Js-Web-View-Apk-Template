const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = path.join(root, 'app');

test('every HTML page loads the requested build-free ui-sdk entries once', () => {
  const pages = fs.readdirSync(app).filter(name => name.endsWith('.html'));
  assert.ok(pages.includes('index.html'));
  for (const name of pages) {
    const html = fs.readFileSync(path.join(app, name), 'utf8');
    const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] || '';
    assert.equal((head.match(/src="https:\/\/ui-sdk\.dev\/web\.js"/g) || []).length, 1, name);
    assert.equal((head.match(/href="https:\/\/ui-sdk\.dev\/web\.css"/g) || []).length, 1, name);
    assert.match(head, /<script\b[^>]*type="module"[^>]*src="https:\/\/ui-sdk\.dev\/web\.js"/);
    assert.doesNotMatch(html, /serviceWorker\s*\.\s*register\s*\(/);
  }
});

test('the custom stylesheet declares the SDK cascade layer', () => {
  const css = fs.readFileSync(path.join(app, 'styles.css'), 'utf8');
  assert.match(css, /^\s*@layer ui-sdk;/);
  assert.match(css, /prefers-reduced-motion/);
});

test('SDK components and the agent entry use one packaged browser runtime', () => {
  const html = fs.readFileSync(path.join(app, 'index.html'), 'utf8');
  const map = JSON.parse(html.match(/<script\s+type="importmap">([\s\S]*?)<\/script>/)?.[1] || '{}');
  assert.equal(map.imports['https://ui-sdk.dev/web/'], './ui-sdk/web/');
  for (const entry of ['agent', 'button', 'input', 'slider', 'menu', 'dialog', 'alert-dialog', 'toast']) {
    assert.ok(fs.existsSync(path.join(app, 'ui-sdk/web', entry + '.js')), entry);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(app, 'ui-sdk/version.json'), 'utf8')).agentEntry, true);
});

test('bundled original loops contain real 24-second audio and matching covers', () => {
  for (const name of ['moon', 'peach', 'cloud', 'after']) {
    const wav = fs.readFileSync(path.join(app, 'assets', name + '.wav'));
    assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
    assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt32LE(40) / wav.readUInt32LE(28), 24);
    const values = new Set();
    for (let i = 44; i < Math.min(wav.length, 32044); i += 2) values.add(wav.readInt16LE(i));
    assert.ok(values.size > 100, `${name} must not be silence`);
    assert.match(fs.readFileSync(path.join(app, 'assets', name + '.svg'), 'utf8'), /<svg/);
  }
});

test('all five legacy icon densities are branded PNGs', () => {
  for (const [density, size] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]) {
    const png = fs.readFileSync(path.join(root, 'res', 'mipmap-' + density, 'ic_launcher.png'));
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const AxeBuilder = require('@axe-core/playwright').default;
const pageErrors = new WeakMap();

async function ready(page) {
  await page.goto('');
  await page.waitForFunction(() => !!window.OrbitAgent && !!customElements.get('ui-menu') && !!customElements.get('ui-slider'));
}

async function newPlaylist(page, name) {
  await page.locator('[data-action="new-playlist"]').first().click();
  await page.getByLabel('Playlist name', { exact: true }).fill(name);
  await page.locator('#promptForm [data-action="submit-prompt"]').click();
  await page.locator('[data-action="nav"][data-view="library"]').first().click();
  await expect(page.locator('#playlistGrid .playlist-open').filter({ hasText: name })).toBeVisible();
}

async function trackMenu(page, id, name, root = '#homeRows') {
  await page.locator(`${root} .song-row[data-id="${id}"] ui-menu-trigger button`).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}

async function mockNative(page) {
  await page.addInitScript(() => {
    window.__nativeCalls = [];
    window.__holdNativeMethods = [];
    window.__heldNativeResults = [];
    window.__releaseNativeResponses = () => {
      const held = window.__heldNativeResults.splice(0);
      window.__holdNativeMethods = [];
      held.forEach(item => item.deliver());
    };
    let state = { type: 'playback', track: null, queue: [], index: -1, playing: false, loading: false, position: 0, duration: 0, shuffle: false, repeat: 'off', sleepEndsAt: 0 };
    let downloads = [];
    window.Native = {
      orbitRequest(method, raw, id) {
        const payload = JSON.parse(raw);
        window.__nativeCalls.push({ method, payload });
        let result = { ok: true };
        let event = null;
        if (method === 'state') result = { ...state };
        if (method === 'downloads') result = { downloads };
        if (method === 'search') result = { tracks: [{ id: 'youtube:abcdefghijk', videoId: 'abcdefghijk', title: 'Pixel horizon', artist: 'Orbit test artist', source: 'youtube', duration: 180 }] };
        if (method === 'play') {
          state = { ...state, queue: payload.queue, index: payload.index, track: payload.queue[payload.index], playing: true, duration: payload.queue[payload.index].duration, position: 0, shuffle: payload.shuffle, repeat: payload.repeat };
          event = state;
        }
        if (method === 'queue') {
          const oldId = state.track?.id;
          const match = payload.queue.findIndex(track => track.id === oldId);
          state = { ...state, queue: payload.queue, index: match >= 0 ? match : payload.index };
          state.track = state.queue[state.index] || null;
          if (!state.track) state.playing = false;
          event = state;
        }
        if (method === 'control') {
          if (payload.action === 'seek') state.position = payload.value;
          if (payload.action === 'pause') state.playing = false;
          if (payload.action === 'resume') state.playing = true;
          if (payload.action === 'shuffle') state.shuffle = payload.value;
          if (payload.action === 'repeat') state.repeat = payload.value;
          if (payload.action === 'sleep') state.sleepEndsAt = payload.value ? Date.now() + payload.value * 60000 : 0;
          if (payload.action === 'next' || payload.action === 'previous') {
            const next = state.index + (payload.action === 'next' ? 1 : -1);
            state.index = Math.max(0, Math.min(state.queue.length - 1, next));
            state.track = state.queue[state.index];
            state.duration = state.track?.duration || 0;
            state.position = 0;
          }
          event = state;
        }
        if (method === 'import') result = { tracks: [{ id: 'local:document', title: 'Imported sunset', artist: 'Local artist', source: 'local', localUri: 'content://test/audio/1', duration: 24 }] };
        if (method === 'rename') {
          state.queue = state.queue.map(track => track.id === payload.id ? { ...track, title: payload.title } : track);
          state.track = state.queue[state.index] || null;
          event = state;
        }
        if (method === 'download') {
          result = { id: payload.track.id, track: payload.track, status: 'queued' };
          const completed = { ...result, status: 'complete', localUri: 'file:///test/music.m4a' };
          setTimeout(() => {
            downloads = [completed];
            window.OrbitNative.onEvent({ type: 'download', ...completed });
          }, 10);
        }
        if (method === 'removeDownload') {
          downloads = downloads.filter(track => track.id !== payload.id);
          event = { type: 'download', id: payload.id, status: 'failed', error: 'Removed' };
        }
        const response = JSON.parse(JSON.stringify(result));
        const snapshot = event ? JSON.parse(JSON.stringify(event)) : null;
        setTimeout(() => {
          const deliver = () => {
            window.OrbitNative.onResult(id, response);
            if (snapshot) window.OrbitNative.onEvent(snapshot);
          };
          if (window.__holdNativeMethods.includes(method)) window.__heldNativeResults.push({ method, deliver });
          else deliver();
        }, 0);
      },
      shareText(text) { window.__sharedText = text; },
      copyText(text) { window.__copiedText = text; },
      openUrl(url) { window.__openedUrl = url; },
    };
  });
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  pageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://ui-sdk.dev/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const file = path.resolve(__dirname, '../app/ui-sdk', '.' + pathname);
    await route.fulfill({ path: file, contentType: pathname.endsWith('.css') ? 'text/css' : 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
  });
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      window.__lastPlayedAudio = this;
      return original.call(this);
    };
    window.__mcpTools = {};
    Object.defineProperty(document, 'modelContext', { configurable: true, value: {
      async registerTool(tool) { window.__mcpTools[tool.name] = tool; },
      unregisterTool(name) { delete window.__mcpTools[name]; },
    } });
  });
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

test('desktop home loads artwork and lazy SDK components without a build step', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('');
  await expect(page.getByText('Moonlit arcade', { exact: true }).first()).toBeVisible();
  await page.waitForFunction(() => !!customElements.get('ui-button'));
  await page.waitForFunction(() => !!window.OrbitAgent);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const broken = await page.locator('img').evaluateAll(images => images.filter(image => !image.complete || image.naturalWidth === 0).map(image => image.src));
  expect(broken).toEqual([]);
  expect(errors).toEqual([]);
  fs.mkdirSync(path.resolve(__dirname, '../artifacts'), { recursive: true });
  await page.screenshot({ path: path.resolve(__dirname, '../artifacts/desktop.png'), fullPage: true, animations: 'disabled' });
});

test('an agent can find named controls and change a search field through its API', async ({ page }) => {
  await page.goto('');
  await page.waitForFunction(() => !!window.OrbitAgent && !!customElements.get('ui-input'));
  const result = await page.evaluate(async () => {
    const entries = window.OrbitAgent.snapshot().filter(entry => !entry.offPage && entry.component !== 'more');
    const unnamed = entries.filter(entry => !entry.label);
    const input = entries.find(entry => /search/i.test(entry.label || '') && entry.actions.includes('setValue'));
    if (!input) return { unnamed, labels: entries.map(entry => entry.label), error: 'No agent-visible search input' };
    const act = await window.OrbitAgent.act({ steps: [{ ref: input.ref, action: 'setValue', args: ['pixel sunsets'] }] });
    return { unnamed, labels: entries.map(entry => entry.label), ok: act.ok, error: act.error?.message,
      reflected: Array.from(document.querySelectorAll('input')).some(element => element.value === 'pixel sunsets') };
  });
  expect(result.unnamed).toEqual([]);
  expect(result.error, JSON.stringify(result.labels)).toBeUndefined();
  expect(result.ok).toBe(true);
  expect(result.reflected).toBe(true);
});

test('demo playback uses real audio and advances time', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: /play moonlit arcade/i }).first().click();
  await page.waitForFunction(() => window.__lastPlayedAudio && !window.__lastPlayedAudio.paused && window.__lastPlayedAudio.currentTime > 0.2);
  const audio = await page.evaluate(() => ({ duration: window.__lastPlayedAudio.duration, currentTime: window.__lastPlayedAudio.currentTime, src: window.__lastPlayedAudio.currentSrc }));
  expect(audio.duration).toBeCloseTo(24, 1);
  expect(audio.currentTime).toBeGreaterThan(0);
  expect(audio.src).toContain('moon.wav');
});

test('a stale browser play rejection cannot pause the newer track', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const original = HTMLMediaElement.prototype.play;
    let first = true;
    HTMLMediaElement.prototype.play = function () {
      if (!first) return original.call(this);
      first = false;
      window.__lastPlayedAudio = this;
      return new Promise((resolve, reject) => {
        window.__rejectOldPlay = () => reject(new DOMException('Playback replaced', 'AbortError'));
      });
    };
  });
  await page.locator('#homeRows [data-id="demo:moon"] [data-action="play-track"]').click();
  await page.waitForFunction(() => typeof window.__rejectOldPlay === 'function');
  await page.locator('#homeRows [data-id="demo:peach"] [data-action="play-track"]').click();
  await page.waitForFunction(() => window.__lastPlayedAudio.currentSrc.endsWith('peach.wav') && !window.__lastPlayedAudio.paused);
  await page.evaluate(() => window.__rejectOldPlay());
  await expect(page.locator('.now-room [data-action="toggle-play"]')).toHaveAttribute('aria-label', 'Pause');
});

test('shuffled browser playback stops when every queued track has played', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => { Math.random = () => 0; });
  await page.locator('#homeRows [data-id="demo:moon"] [data-action="play-track"]').click();
  await page.waitForFunction(() => window.__lastPlayedAudio && !window.__lastPlayedAudio.paused);
  await page.locator('.now-room [data-action="shuffle"]').click();
  for (const name of ['peach', 'cloud', 'after']) {
    await page.locator('.now-room [data-action="next"]').click();
    await page.waitForFunction(file => window.__lastPlayedAudio.currentSrc.endsWith(file + '.wav') && !window.__lastPlayedAudio.paused, name);
  }
  await page.locator('.now-room [data-action="next"]').click();
  await expect.poll(() => page.evaluate(() => window.__lastPlayedAudio.paused)).toBe(true);
  await expect(page.locator('.now-room [data-action="toggle-play"]')).toHaveAttribute('aria-label', 'Play');
});

test('removing the last browser queue item clears audio and player metadata', async ({ page }) => {
  await ready(page);
  await page.locator('#homeRows [data-id="demo:moon"] [data-action="play-track"]').click();
  await page.locator('[data-action="open-queue"]').first().click();
  for (let count = 4; count > 0; count--) {
    await expect(page.locator('#queueList .queue-item')).toHaveCount(count);
    await page.locator('#queueList [data-action="queue-remove"]').first().click();
  }
  await expect(page.locator('#queueList .queue-item')).toHaveCount(0);
  await expect(page.locator('#playerTitle')).toHaveText('Nothing playing');
  await expect(page.locator('#playerDuration')).toHaveText('0:00');
  expect(await page.evaluate(() => document.getElementById('audio').paused && !document.getElementById('audio').getAttribute('src'))).toBe(true);
  expect(await page.evaluate(() => document.getElementById('playerSeek').disabled)).toBe(true);
  await page.reload();
  await expect(page.locator('#playerTitle')).toHaveText('Nothing playing');
});

test('keyboard settings update SDK state and persist after reload', async ({ page }) => {
  await ready(page);
  const settings = page.locator('[data-action="open-settings"]').first();
  await settings.click();
  const motion = page.getByRole('switch', { name: 'Motion', exact: true });
  await motion.focus();
  await motion.press('Space');
  await expect(motion).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'off');
  await page.getByRole('button', { name: 'Daylight', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'daylight');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(settings).toBeFocused();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'daylight');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'off');
});

test('mood groups report arrays and keep the active choice selected', async ({ page }) => {
  await ready(page);
  const chill = page.locator('#moodRail [data-mood="Chill"]');
  await chill.click();
  await expect(page.locator('#coverRail .rail-card')).toHaveCount(2);
  await chill.click();
  await expect(chill).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#coverRail .rail-card')).toHaveCount(2);
});

test('likes change once per SDK press and survive refresh', async ({ page }) => {
  await ready(page);
  const heart = page.locator('#homeRows .song-row[data-id="demo:moon"] [data-action="toggle-like"]');
  await heart.click();
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('orbit.state.v1')).likes)).toEqual(['demo:moon']);
  await page.reload();
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  await heart.focus();
  await heart.press('Space');
  await expect(heart).toHaveAttribute('aria-pressed', 'false');
});

test('playlist creation validates empty names and track menus use their own IDs', async ({ page }) => {
  await ready(page);
  await page.locator('[data-action="new-playlist"]').first().click();
  await page.locator('#promptForm [data-action="submit-prompt"]').click();
  await expect(page.locator('#promptError')).toHaveText('Enter a name first.');
  await page.getByLabel('Playlist name', { exact: true }).fill('Night flight');
  await page.locator('#promptForm [data-action="submit-prompt"]').click();
  await page.locator('[data-action="nav"][data-view="home"]').first().click();
  await trackMenu(page, 'demo:moon', 'Add to playlist');
  await page.locator('#playlistPickerList [data-action="picker-add"]').click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await trackMenu(page, 'demo:peach', 'Rename track');
  await page.getByLabel('Track name', { exact: true }).fill('Peach after midnight');
  await page.locator('#promptForm [data-action="submit-prompt"]').click();
  await expect(page.locator('#homeRows .song-row[data-id="demo:peach"]')).toContainText('Peach after midnight');
  await expect(page.locator('#homeRows .song-row[data-id="demo:moon"]')).toContainText('Moonlit arcade');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.state.v1')));
  expect(saved.playlists).toHaveLength(1);
  expect(saved.playlists[0].trackIds).toEqual(['demo:moon']);
  expect(saved.customTitles['demo:peach']).toBe('Peach after midnight');
});

test('confirmation cancel is safe and agents cannot delete without a person', async ({ page }) => {
  await ready(page);
  await newPlaylist(page, 'Keep this orbit');
  await page.locator('#playlistGrid [data-action="delete-playlist"]').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#playlistGrid .playlist-card')).toHaveCount(1);
  await page.locator('#playlistGrid [data-action="delete-playlist"]').click();
  const denied = await page.evaluate(async () => {
    const entry = window.OrbitAgent.snapshot().find(item => item.confirm && item.actions.includes('press'));
    if (!entry) return { ok: true, error: 'No confirmation-marked control' };
    const result = await window.OrbitAgent.act({ steps: [{ ref: entry.ref, action: 'press', args: [] }] });
    return { ok: result.ok, error: result.error?.message };
  });
  expect(denied.ok, denied.error).toBe(false);
  await expect(page.locator('#playlistGrid .playlist-card')).toHaveCount(1);
});

test('SDK slider seeking changes real audio in seconds', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: /play moonlit arcade/i }).first().click();
  await page.waitForFunction(() => window.__lastPlayedAudio && !window.__lastPlayedAudio.paused);
  await page.locator('.now-room [data-action="toggle-play"]').click();
  const seek = page.locator('#playerSeek').getByRole('slider');
  await seek.focus();
  await seek.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => window.__lastPlayedAudio.currentTime)).toBeGreaterThan(0);
  await page.evaluate(() => document.getElementById('playerSeek').api.setValue(12));
  await expect.poll(() => page.evaluate(() => window.__lastPlayedAudio.currentTime)).toBeCloseTo(12, 1);
  await expect(page.locator('#playerCurrent')).toHaveText('0:12');
});

test('browser imports use object URLs and stay session-only', async ({ page }) => {
  await ready(page);
  await page.locator('#fileInput').setInputFiles({ name: 'study-loop.wav', mimeType: 'audio/wav', buffer: fs.readFileSync(path.resolve(__dirname, '../app/assets/moon.wav')) });
  await expect(page.locator('#libraryRows')).toContainText('study-loop');
  await page.locator('#libraryRows [data-action="play-track"]').click();
  await page.waitForFunction(() => window.__lastPlayedAudio && window.__lastPlayedAudio.currentSrc.startsWith('blob:'));
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.state.v1')).extraTracks.some(track => track.title === 'study-loop'))).toBe(false);
  await page.reload();
  await page.locator('[data-action="nav"][data-view="library"]').first().click();
  await expect(page.locator('#libraryRows')).not.toContainText('study-loop');
});

test('browser source settings reject HTTP and expose real missing-source errors', async ({ page }) => {
  await ready(page);
  await page.locator('[data-action="open-settings"]').first().click();
  await page.getByLabel('Piped API endpoint', { exact: true }).fill('http://unsafe.example');
  await page.getByRole('button', { name: 'Save endpoint', exact: true }).click();
  await expect(page.locator('#pipedError')).toContainText('HTTPS');
  await page.getByLabel('Piped API endpoint', { exact: true }).fill('https://music.example/api/');
  await page.getByRole('button', { name: 'Save endpoint', exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.state.v1')).pipedUrl)).toBe('https://music.example/api');
  await page.getByLabel('Piped API endpoint', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Save endpoint', exact: true }).click();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.locator('#topSearchInput').fill('pixel horizons');
  await page.locator('#topSearchForm [data-action="submit-search"]').click();
  await expect(page.locator('#searchResults')).toContainText('No search source');
});

test('agent settings and WebMCP use SDK callbacks, not synthetic clicks', async ({ page }) => {
  await ready(page);
  await page.locator('[data-action="open-settings"]').first().click();
  const results = await page.evaluate(async () => {
    const settings = window.OrbitAgent.snapshot();
    const motion = settings.find(item => item.label === 'Motion' && item.actions.includes('setChecked'));
    const theme = settings.find(item => item.label === 'Theme' && item.actions.includes('setValue'));
    const actions = await window.OrbitAgent.act({ steps: [
      { ref: motion?.ref || 'Motion', action: 'setChecked', args: [false] },
      { ref: theme?.ref || 'Theme', action: 'setValue', args: [['daylight']] },
    ] });
    return { ok: actions.ok, error: actions.error?.message, tools: Object.keys(window.__mcpTools) };
  });
  expect(results.ok, results.error).toBe(true);
  expect(results.tools.length).toBeGreaterThan(0);
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'off');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'daylight');
});

test('native imports persist document URIs without sending audio over the bridge', async ({ page }) => {
  await mockNative(page);
  await ready(page);
  await page.locator('[data-action="nav"][data-view="library"]').first().click();
  await page.locator('[data-action="import"]').first().click();
  await expect(page.locator('#libraryRows')).toContainText('Imported sunset');
  const result = await page.evaluate(() => ({ calls: window.__nativeCalls, saved: JSON.parse(localStorage.getItem('orbit.state.v1')) }));
  expect(result.calls.find(call => call.method === 'import').payload).toEqual({});
  expect(result.saved.extraTracks.find(track => track.id === 'local:document').localUri).toBe('content://test/audio/1');
});

test('native controls synchronize queues, repeat, shuffle, seeking, and resume', async ({ page }) => {
  await mockNative(page);
  await ready(page);
  await page.getByRole('button', { name: /play moonlit arcade/i }).first().click();
  await page.waitForFunction(() => window.__nativeCalls.some(call => call.method === 'play'));
  await page.locator('.now-room [data-action="shuffle"]').click();
  await page.locator('.now-room [data-action="repeat"]').click();
  await page.evaluate(() => document.getElementById('playerSeek').api.setValue(9));
  await page.locator('.now-room [data-action="toggle-play"]').click();
  await page.locator('.now-room [data-action="toggle-play"]').click();
  await page.locator('[data-action="open-queue"]').first().click();
  await page.locator('#queueList [data-action="queue-down"]').first().click();
  const calls = await page.evaluate(() => window.__nativeCalls);
  expect(calls.find(call => call.method === 'control' && call.payload.action === 'shuffle').payload.value).toBe(true);
  expect(calls.find(call => call.method === 'control' && call.payload.action === 'repeat').payload.value).toBe('all');
  expect(calls.find(call => call.method === 'control' && call.payload.action === 'seek').payload.value).toBe(9);
  expect(calls.some(call => call.method === 'control' && call.payload.action === 'resume')).toBe(true);
  const queue = calls.find(call => call.method === 'queue').payload;
  expect(queue.queue[queue.index].id).toBe('demo:moon');
  expect(queue.queue).toHaveLength(4);
  expect(await page.evaluate(() => !!window.__lastPlayedAudio)).toBe(false);
});

test('native media events outrank an older playback poll', async ({ page }) => {
  await mockNative(page);
  await ready(page);
  await page.locator('#homeRows [data-id="demo:moon"] [data-action="play-track"]').click();
  await expect(page.locator('.now-room [data-action="toggle-play"]')).toHaveAttribute('aria-label', 'Pause');
  await page.evaluate(() => {
    window.__holdNativeMethods = ['state'];
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => window.__heldNativeResults.some(item => item.method === 'state'));
  await page.evaluate(() => window.Native.orbitRequest('control', JSON.stringify({ action: 'pause' }), 'headset-pause'));
  await expect(page.locator('.now-room [data-action="toggle-play"]')).toHaveAttribute('aria-label', 'Play');
  await page.evaluate(() => window.__releaseNativeResponses());
  await expect(page.locator('.now-room [data-action="toggle-play"]')).toHaveAttribute('aria-label', 'Play');
});

test('YouTube IDs and nested download records stay canonical across the bridge', async ({ page }) => {
  await mockNative(page);
  await ready(page);
  await page.locator('#topSearchInput').fill('pixel horizon');
  await page.locator('#topSearchForm [data-action="submit-search"]').click();
  await expect(page.locator('#searchResults')).toContainText('Pixel horizon');
  await trackMenu(page, 'yt:abcdefghijk', 'Download', '#searchResults');
  await page.locator('[data-action="nav"][data-view="downloads"]').first().click();
  await expect(page.locator('#downloadsList')).toContainText('Pixel horizon');
  await expect(page.locator('#downloadsList .download-status')).toHaveText('complete');
  await page.locator('#downloadsList [data-action="play-track"]').click();
  await page.waitForFunction(() => window.__nativeCalls.some(call => call.method === 'play'));
  const calls = await page.evaluate(() => window.__nativeCalls);
  expect(calls.find(call => call.method === 'download').payload.track.id).toBe('youtube:abcdefghijk');
  const play = calls.find(call => call.method === 'play').payload;
  expect(play.queue[play.index]).toMatchObject({ id: 'youtube:abcdefghijk', videoId: 'abcdefghijk', source: 'youtube' });
  await page.evaluate(() => {
    window.__holdNativeMethods = ['downloads'];
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => window.__heldNativeResults.some(item => item.method === 'downloads'));
  await page.locator('#downloadsList [data-action="remove-download"]').click();
  await page.locator('#confirmButton').click();
  await expect(page.locator('#downloadsList')).not.toContainText('Pixel horizon');
  await page.evaluate(() => window.__releaseNativeResponses());
  await expect(page.locator('#downloadsList')).not.toContainText('Pixel horizon');
  expect(await page.evaluate(() => window.__nativeCalls.find(call => call.method === 'removeDownload').payload.id)).toBe('youtube:abcdefghijk');
});

for (const theme of ['midnight', 'daylight']) {
  test(`${theme} home has accessible names, contrast, and valid ARIA`, async ({ page }) => {
    await ready(page);
    if (theme === 'daylight') {
      await page.locator('[data-action="open-settings"]').first().click();
      await page.getByRole('button', { name: 'Daylight', exact: true }).click();
      await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    }
    const report = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(report.violations.map(violation => ({ id: violation.id, targets: violation.nodes.map(node => node.target) }))).toEqual([]);
  });
}

for (const width of [360, 390, 768]) {
  test(`mobile layout fits ${width}px without horizontal scrolling`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('');
    await expect(page.getByText('Moonlit arcade', { exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (width === 390) await page.screenshot({ path: path.resolve(__dirname, '../artifacts/mobile.png'), fullPage: true, animations: 'disabled' });
  });
}

test('offline bundled SDK routing preserves the native playback contract', async ({ page, baseURL }) => {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'ui-sdk.dev') {
      const response = await page.request.get(baseURL + 'ui-sdk' + url.pathname);
      await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
    } else if (url.origin === new URL(baseURL).origin) {
      await route.continue();
    } else {
      await route.abort();
    }
  });
  await page.addInitScript(() => {
    window.__nativeCalls = [];
    let state = { type: 'playback', track: null, queue: [], index: -1, playing: false, loading: false, position: 0, duration: 0, shuffle: false, repeat: 'off' };
    window.Native = {
      orbitRequest(method, raw, id) {
        const payload = JSON.parse(raw);
        window.__nativeCalls.push({ method, payload });
        let result = { ok: true };
        if (method === 'state') result = state;
        if (method === 'downloads') result = { tracks: [] };
        if (method === 'play') state = { ...state, queue: payload.queue, index: payload.index, track: payload.queue[payload.index], playing: true, duration: 24 };
        setTimeout(() => {
          window.OrbitNative.onResult(id, result);
          if (method === 'play') window.OrbitNative.onEvent(state);
        }, 0);
      },
      shareText() {}, copyText() {}, openUrl() {},
    };
  });
  await page.goto('');
  await page.waitForFunction(() => !!customElements.get('ui-button') && !!window.OrbitAgent);
  await page.getByRole('button', { name: /play moonlit arcade/i }).first().click();
  await page.waitForFunction(() => window.__nativeCalls.some(call => call.method === 'play'));
  const calls = await page.evaluate(() => window.__nativeCalls);
  const play = calls.find(call => call.method === 'play');
  expect(play.payload.queue[play.payload.index].id).toBe('demo:moon');
  expect(calls.some(call => call.method === 'state')).toBe(true);
  expect(await page.evaluate(() => !!window.__lastPlayedAudio)).toBe(false);
});

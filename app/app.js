/* ============================================================
   ORBIT — app logic
   Classic script, no build step. Browser + Android native shell.
   ============================================================ */
(function () {
  "use strict";

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const DEMOS = [
    {
      id: "demo:moon",
      title: "Moonlit arcade",
      artist: "Orbit originals",
      source: "demo",
      audioUrl: "assets/moon.wav",
      artworkUrl: "assets/moon.svg",
      duration: 24,
      moods: ["Chill"],
      addedAt: 1
    },
    {
      id: "demo:peach",
      title: "Peach skies",
      artist: "Orbit originals",
      source: "demo",
      audioUrl: "assets/peach.wav",
      artworkUrl: "assets/peach.svg",
      duration: 24,
      moods: ["Chill"],
      addedAt: 2
    },
    {
      id: "demo:cloud",
      title: "Cloud save",
      artist: "Orbit originals",
      source: "demo",
      audioUrl: "assets/cloud.wav",
      artworkUrl: "assets/cloud.svg",
      duration: 24,
      moods: ["Focus"],
      addedAt: 3
    },
    {
      id: "demo:after",
      title: "After hours",
      artist: "Orbit originals",
      source: "demo",
      audioUrl: "assets/after.wav",
      artworkUrl: "assets/after.svg",
      duration: 24,
      moods: ["Dream"],
      addedAt: 4
    }
  ];

  const STORE_KEY = "orbit.state.v1";
  const MOODS = ["All", "Chill", "Focus", "Energy", "Dream"];
  const isNative = () => !!(window.Native && typeof window.Native.orbitRequest === "function");

  const demoMap = new Map(DEMOS.map((track) => [track.id, { ...track }]));
  const runtimeTracks = new Map();
  let extraTracks = [];

  let saved = {};
  let storageOk = true;
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {};
  } catch (error) {
    saved = {};
    storageOk = false;
  }

  const state = {
    view: "home",
    mood: "All",
    filter: "",
    likes: Array.isArray(saved.likes) ? saved.likes.filter((id) => typeof id === "string").map(uiTrackId) : [],
    playlists: Array.isArray(saved.playlists)
      ? saved.playlists
          .filter((pl) => pl && typeof pl.id === "string" && typeof pl.name === "string")
          .map((pl) => ({
            id: pl.id,
            name: pl.name.slice(0, 80),
            trackIds: Array.isArray(pl.trackIds) ? pl.trackIds.filter((id) => typeof id === "string").map(uiTrackId) : [],
            createdAt: Number(pl.createdAt) || Date.now()
          }))
      : [],
    customTitles: saved.customTitles && typeof saved.customTitles === "object" && !Array.isArray(saved.customTitles)
      ? Object.fromEntries(Object.entries(saved.customTitles).filter(([, title]) => typeof title === "string").map(([id, title]) => [uiTrackId(id), title.slice(0, 140)]))
      : {},
    queue: Array.isArray(saved.queue) ? saved.queue.filter((id) => typeof id === "string").map(uiTrackId) : DEMOS.map((track) => track.id),
    currentId: typeof saved.currentId === "string" ? uiTrackId(saved.currentId) : DEMOS[0].id,
    currentTime: 0,
    duration: 24,
    isPlaying: false,
    shuffle: !!saved.shuffle,
    repeat: ["off", "all", "one"].includes(saved.repeat) ? saved.repeat : "off",
    pipedUrl: typeof saved.pipedUrl === "string" ? saved.pipedUrl : "",
    theme: saved.theme === "daylight" ? "daylight" : "midnight",
    motion: saved.motion !== false,
    activePlaylistId: null,
    searchResults: [],
    searchLoading: false,
    searchError: "",
    searchQuery: "",
    downloads: {},
    sleepMinutes: 0,
    sleepEndsAt: 0,
    loading: false,
    playbackError: ""
  };

  if (Array.isArray(saved.extraTracks)) {
    extraTracks = saved.extraTracks
      .filter((track) => track && typeof track.id === "string" && typeof track.title === "string")
      .map((track) => ({
        id: uiTrackId(track.id),
        title: track.title,
        originalTitle: track.originalTitle || track.title,
        artist: track.artist || "Unknown artist",
        source: trackSource(track.source),
        audioUrl: typeof track.audioUrl === "string" ? track.audioUrl : "",
        localUri: typeof track.localUri === "string" ? track.localUri : "",
        artworkUrl: typeof track.artworkUrl === "string" ? track.artworkUrl : "",
        videoId: typeof track.videoId === "string" ? track.videoId : "",
        duration: Number(track.duration) || 0,
        moods: Array.isArray(track.moods) ? track.moods : [],
        addedAt: Number(track.addedAt) || Date.now()
      }));
  }

  const audio = $("#audio");
  const fallbackSheet = $("#fallbackSheet");
  const fileInput = $("#fileInput");
  const promptDialog = $("#promptDialog");
  const confirmDialog = $("#confirmDialog");
  const settingsDialog = $("#settingsDialog");
  const queueDrawer = $("#queueDrawer");
  const expandedDialog = $("#expandedDialog");
  const playlistPickerDialog = $("#playlistPickerDialog");

  let pickerTrackId = null;
  let fallbackTrackId = null;
  let fallbackPlaylistId = null;
  let playToken = 0;
  let searchGen = 0;
  let searchAbort = null;
  let promptResolve = null;
  let confirmResolve = null;
  let sleepTimer = null;
  let toastSeq = 0;
  let modalZ = 120;
  let nativeHasQueue = false;
  let nativeChangeToken = 0;
  let downloadChangeToken = 0;
  const browserShufflePlayed = new Set();
  let nativePolling = false;
  let downloadPolling = false;
  let seekPreview = null;

  /* ---------------- utilities ---------------- */

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => {
      if (ch === "&") return "&amp;";
      if (ch === "<") return "&lt;";
      if (ch === ">") return "&gt;";
      if (ch === '"') return "&quot;";
      return "&#39;";
    });
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatTime(seconds) {
    const total = Number(seconds);
    if (!isFinite(total) || total <= 0) return "0:00";
    const whole = Math.floor(total);
    return Math.floor(whole / 60) + ":" + twoDigits(whole % 60);
  }

  function twoDigits(value) {
    const number = Math.floor(Number(value) || 0);
    return (number < 10 ? "0" : "") + number;
  }

  function initial(title) {
    const match = String(title || "").match(/[a-z0-9]/i);
    return match ? match[0].toUpperCase() : "?";
  }

  function unique(list) {
    return Array.from(new Set(list));
  }

  function stripExtension(name) {
    return String(name || "Untitled").replace(/\.[a-z0-9]{1,6}$/i, "").slice(0, 90);
  }

  function safeFilename(name) {
    return String(name || "orbit-track")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "orbit-track";
  }

  function errorMessage(error, fallback) {
    if (!error) return fallback || "Something went wrong.";
    if (typeof error === "string") return error;
    return error.message || fallback || "Something went wrong.";
  }

  function uiTrackId(id) {
    const value = String(id || "");
    return value.startsWith("youtube:") ? "yt:" + value.slice(8) : value;
  }

  function nativeTrackId(id) {
    const value = String(id || "");
    return value.startsWith("yt:") ? "youtube:" + value.slice(3) : value;
  }

  function trackSource(source) {
    if (source === "import") return "local";
    return ["youtube", "demo", "local", "direct"].includes(source) ? source : "youtube";
  }

  function nativeTrackPayload(track) {
    const payload = {
      id: nativeTrackId(track.id),
      source: trackSource(track.source),
      title: track.title,
      originalTitle: track.originalTitle || track.title,
      artist: track.artist,
      duration: Number(track.duration) || 0,
      artworkUrl: track.artworkUrl || ""
    };
    if (payload.source === "youtube") payload.videoId = track.videoId || track.id.slice(3);
    else if (payload.source === "local") payload.localUri = track.localUri || "";
    else payload.audioUrl = track.audioUrl || "";
    return payload;
  }

  function nativeQueuePayload() {
    const tracks = state.queue.map(getTrack).filter(Boolean);
    const queue = tracks.map(nativeTrackPayload);
    return {
      queue,
      index: Math.max(0, tracks.findIndex((track) => track.id === state.currentId)),
      shuffle: state.shuffle,
      repeat: state.repeat
    };
  }

  function setSdkState(element, property, value) {
    if (!element) return;
    if (sdkHas(element.localName)) {
      element[property] = value;
      return;
    }
    const attribute = property.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
    if (value == null) element.removeAttribute(attribute);
    else if (typeof value === "boolean" && ["pressed", "checked", "open"].includes(property)) element.setAttribute(attribute, String(value));
    else if (typeof value === "boolean") element.toggleAttribute(attribute, value);
    else element.setAttribute(attribute, Array.isArray(value) ? value.join(",") : String(value));
  }

  function setFieldError(field, errorId, message) {
    if (!field) return;
    const previous = $("#" + errorId);
    if (previous) previous.remove();
    if (message) {
      const error = document.createElement("ui-field-error");
      error.id = errorId;
      error.setAttribute("match", "true");
      error.textContent = message;
      field.appendChild(error);
    }
    setSdkState(field, "invalid", message ? true : undefined);
  }

  function setInputValue(input, value) {
    if (!input) return;
    const wrapper = input.closest("ui-input");
    if (wrapper && sdkHas("ui-input")) wrapper.value = value;
    else input.value = value;
  }

  function extractYouTubeId(input) {
    const value = String(input || "").trim();
    if (!value) return null;
    if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;
    let url;
    try {
      url = new URL(/^[a-z]+:\/\//i.test(value) ? value : "https://" + value);
    } catch (error) {
      return null;
    }
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com" || host === "youtube-nocookie.com") {
      const fromQuery = url.searchParams.get("v");
      if (fromQuery && /^[a-zA-Z0-9_-]{11}$/.test(fromQuery)) return fromQuery;
      const match = url.pathname.match(/\/(?:shorts|embed|live|v)\/([a-zA-Z0-9_-]{11})/);
      return match ? match[1] : null;
    }
    return null;
  }

  function saveState() {
    if (!storageOk) return;
    try {
      const referenced = new Set();
      [state.currentId].concat(state.likes, state.queue).forEach((id) => {
        if (id) referenced.add(id);
      });
      state.playlists.forEach((playlist) => {
        playlist.trackIds.forEach((id) => {
          if (id) referenced.add(id);
        });
      });
      Object.keys(state.downloads).forEach((id) => referenced.add(id));
      const canPersist = (id) => !!getTrack(id) && !getTrack(id).sessionOnly;
      const persistTracks = extraTracks
        .filter((track) => !track.sessionOnly && (referenced.has(track.id) || track.source === "local"))
        .map((track) => ({
          id: track.id,
          title: track.title,
          originalTitle: track.originalTitle || track.title,
          artist: track.artist,
          source: track.source,
          audioUrl: track.source === "youtube" ? "" : track.audioUrl || "",
          localUri: track.localUri || "",
          artworkUrl: track.artworkUrl || "",
          videoId: track.videoId || "",
          duration: track.duration || 0,
          moods: track.moods || [],
          addedAt: track.addedAt || Date.now()
        }));
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          likes: state.likes.filter(canPersist),
          playlists: state.playlists.map((playlist) => ({ ...playlist, trackIds: playlist.trackIds.filter(canPersist) })),
          customTitles: Object.fromEntries(Object.entries(state.customTitles).filter(([id]) => canPersist(id))),
          queue: state.queue.filter(canPersist),
          currentId: canPersist(state.currentId) ? state.currentId : "",
          shuffle: state.shuffle,
          repeat: state.repeat,
          pipedUrl: state.pipedUrl,
          theme: state.theme,
          motion: state.motion,
          extraTracks: persistTracks
        })
      );
    } catch (error) {
      storageOk = false;
    }
  }

  /* ---------------- track registry ---------------- */

  function getTrack(id) {
    if (!id) return null;
    id = uiTrackId(id);
    if (demoMap.has(id)) return demoMap.get(id);
    if (runtimeTracks.has(id)) return runtimeTracks.get(id);
    return extraTracks.find((track) => track.id === id) || null;
  }

  function registerTrack(track) {
    if (!track || !track.id) return null;
    const id = uiTrackId(track.id);
    const existing = getTrack(id);
    if (existing) {
      if (track.audioUrl) existing.audioUrl = track.audioUrl;
      if (track.localUri) existing.localUri = track.localUri;
      if (track.artworkUrl) existing.artworkUrl = track.artworkUrl;
      if (track.duration) existing.duration = Number(track.duration);
      if (!existing.videoId && track.videoId) existing.videoId = track.videoId;
      if (track.originalTitle) existing.originalTitle = track.originalTitle;
      if (track.title && !state.customTitles[id]) existing.title = String(track.title).slice(0, 140);
      if (track.artist) existing.artist = String(track.artist).slice(0, 120);
      if (state.customTitles[id]) existing.title = state.customTitles[id];
      return existing;
    }
    const clean = {
      id,
      title: String(state.customTitles[id] || track.title || "Untitled").slice(0, 140),
      originalTitle: String(track.originalTitle || track.title || "Untitled").slice(0, 140),
      artist: String(track.artist || "Unknown artist").slice(0, 120),
      source: trackSource(track.source),
      audioUrl: typeof track.audioUrl === "string" ? track.audioUrl : "",
      localUri: typeof track.localUri === "string" ? track.localUri : "",
      artworkUrl: typeof track.artworkUrl === "string" ? track.artworkUrl : "",
      videoId: typeof track.videoId === "string" ? track.videoId : "",
      duration: Number(track.duration) || 0,
      moods: Array.isArray(track.moods) ? track.moods : [],
      sessionOnly: !!track.sessionOnly,
      addedAt: Number(track.addedAt) || Date.now()
    };
    runtimeTracks.set(clean.id, clean);
    return clean;
  }

  function promoteTrack(id) {
    const track = getTrack(id);
    if (!track || demoMap.has(track.id) || track.sessionOnly) return;
    if (extraTracks.some((item) => item.id === track.id)) return;
    extraTracks.push(track);
  }

  function applyCustomTitles() {
    const all = [...demoMap.values(), ...extraTracks, ...runtimeTracks.values()];
    all.forEach((track) => {
      const custom = state.customTitles[track.id];
      if (typeof custom === "string" && custom.trim()) {
        track.originalTitle = track.originalTitle || track.title;
        track.title = custom.trim();
      }
    });
  }

  function libraryTracks() {
    const ids = [];
    state.likes.forEach((id) => ids.push(id));
    state.playlists.forEach((pl) => pl.trackIds.forEach((id) => ids.push(id)));
    extraTracks.filter((track) => track.source === "local").forEach((track) => ids.push(track.id));
    Object.values(state.downloads).filter((item) => item.status === "complete").forEach((item) => ids.push(item.id));
    return unique(ids)
      .map(getTrack)
      .filter(Boolean)
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  }

  function likedTracks() {
    return state.likes.map(getTrack).filter(Boolean);
  }

  function filteredDemos() {
    return DEMOS.map((track) => demoMap.get(track.id)).filter((track) => state.mood === "All" || track.moods.includes(state.mood));
  }

  function matchesFilter(track) {
    const query = state.filter.trim().toLowerCase();
    if (!query) return true;
    return (track.title + " " + track.artist).toLowerCase().includes(query);
  }

  function contextTrackIds(context) {
    if (!context) return null;
    if (context === "home") return filteredDemos().map((track) => track.id);
    if (context === "search") return state.searchResults.map((track) => track.id);
    if (context === "library") return libraryTracks().map((track) => track.id);
    if (context === "downloads") return Object.values(state.downloads).filter((item) => item.status === "complete").map((item) => item.id);
    if (context.indexOf("playlist:") === 0) {
      const playlist = state.playlists.find((pl) => pl.id === context.slice(9));
      return playlist ? playlist.trackIds.slice() : null;
    }
    return null;
  }

  function ensureQueue() {
    const valid = state.queue.map(getTrack).filter(Boolean);
    state.queue = valid.map((track) => track.id);
  }

  /* ---------------- native bridge ---------------- */

  const pendingNative = new Map();
  let nativeSeq = 0;

  function installNativeBridge() {
    window.OrbitNative = {
      onResult(id, result) {
        const pending = pendingNative.get(id);
        if (!pending) return;
        pendingNative.delete(id);
        clearTimeout(pending.timer);
        let parsed = result;
        if (typeof result === "string") {
          try {
            parsed = JSON.parse(result);
          } catch (error) {
            parsed = { error: result };
          }
        }
        if (parsed && parsed.error && parsed.type !== "playback") pending.reject(new Error(String(parsed.error)));
        else pending.resolve(parsed);
      },
      onEvent(payload) {
        let event = payload;
        if (typeof payload === "string") {
          try {
            event = JSON.parse(payload);
          } catch (error) {
            return;
          }
        }
        handleNativeEvent(event);
      }
    };
  }

  function nativeRequest(method, payload, timeout) {
    if (["play", "control", "queue", "enqueue", "rename"].includes(method)) nativeChangeToken += 1;
    if (["download", "removeDownload"].includes(method)) downloadChangeToken += 1;
    return new Promise((resolve, reject) => {
      if (!isNative()) {
        reject(new Error("Native bridge is unavailable."));
        return;
      }
      const id = "orbit-" + Date.now().toString(36) + "-" + (++nativeSeq).toString(36);
      const timer = setTimeout(() => {
        pendingNative.delete(id);
        reject(new Error("The native app did not answer in time."));
      }, timeout || 15000);
      pendingNative.set(id, { resolve, reject, timer });
      try {
        window.Native.orbitRequest(method, JSON.stringify(payload || {}), id);
      } catch (error) {
        clearTimeout(timer);
        pendingNative.delete(id);
        reject(new Error("Could not reach the native app."));
      }
    });
  }

  function unwrap(response) {
    if (response && typeof response === "object" && response.data && typeof response.data === "object") return response.data;
    return response;
  }

  function handleNativeEvent(event) {
    if (!event || typeof event !== "object") return;
    const type = String(event.type || event.event || event.kind || "").toLowerCase();
    if (type.indexOf("download") >= 0 || event.download) {
      const data = event.download || event.data || event;
      if (data && (data.trackId || data.id)) {
        downloadChangeToken += 1;
        const item = normalizeDownload(data);
        if (item.id && (item.status === "removed" || item.error === "Removed")) delete state.downloads[item.id];
        else if (item.id) {
          if (JSON.stringify(state.downloads[item.id]) === JSON.stringify(item)) return;
          state.downloads[item.id] = item;
        }
        renderDownloads();
        if (state.view === "library") renderLibrary();
        saveState();
      }
      return;
    }
    if (type.indexOf("play") >= 0 || type.indexOf("state") >= 0 || event.playback) {
      nativeChangeToken += 1;
      applyNativeState(event.playback || event.state || event.data || event);
      return;
    }
    if (event.state) {
      nativeChangeToken += 1;
      applyNativeState(event.state);
    }
  }

  function normalizeNativeTrack(item) {
    if (!item || typeof item !== "object") return null;
    const rawId = item.videoId || item.trackId || item.id || item.url || "";
    let videoId = extractYouTubeId(item.videoId || "") || "";
    if (!videoId) videoId = extractYouTubeId(String(rawId)) || "";
    let id = typeof item.id === "string" && item.id ? item.id : videoId ? "yt:" + videoId : "";
    if (!id && rawId) id = "yt:" + String(rawId);
    if (!id) return null;
    id = uiTrackId(id);
    if (!videoId && id.indexOf("yt:") === 0) videoId = id.slice(3);
    if (videoId && id.indexOf(":") < 0) id = "yt:" + videoId;
    if (!videoId && id.indexOf("yt:") === 0) videoId = id.slice(3);
    const source = id.startsWith("demo:") ? "demo" : id.startsWith("local:") ? "local" : id.startsWith("direct:") ? "direct" : trackSource(item.source);
    if (source === "youtube" && !extractYouTubeId(videoId)) return null;
    const track = registerTrack({
      id,
      title: item.title || item.name || "Untitled",
      originalTitle: item.originalTitle || item.title || item.name || "Untitled",
      artist: item.artist || item.uploader || item.channel || item.author || "YouTube",
      source,
      audioUrl: item.audioUrl || item.streamUrl || "",
      localUri: item.localUri || "",
      artworkUrl: item.artworkUrl || item.thumbnail || item.thumbnailUrl || "",
      videoId,
      duration: Number(item.duration) || 0,
      moods: []
    });
    return track;
  }

  function normalizeNativeResults(response) {
    const data = unwrap(response);
    let list = [];
    if (Array.isArray(data)) list = data;
    else if (data && Array.isArray(data.results)) list = data.results;
    else if (data && Array.isArray(data.items)) list = data.items;
    else if (data && Array.isArray(data.tracks)) list = data.tracks;
    return list.map(normalizeNativeTrack).filter(Boolean);
  }

  function normalizeDownload(item) {
    const raw = item || {};
    const track = normalizeNativeTrack(raw.track) || getTrack(raw.trackId || raw.id) || null;
    if (track) promoteTrack(track.id);
    const id = uiTrackId(raw.trackId || raw.id || (track && track.id) || "");
    const status = String(raw.status || raw.state || "queued").toLowerCase();
    return {
      id,
      title: (track && track.title) || raw.title || "Untitled",
      artist: raw.artist || (track && track.artist) || "",
      artworkUrl: raw.artworkUrl || (track && track.artworkUrl) || "",
      localUri: raw.localUri || "",
      status: status === "completed" ? "complete" : status === "error" ? "failed" : status,
      progress: Number(raw.progress) || 0,
      error: raw.error ? String(raw.error) : ""
    };
  }

  function applyDownloads(response) {
    const data = unwrap(response);
    const previous = JSON.stringify(state.downloads);
    let list = [];
    if (Array.isArray(data)) list = data;
    else if (data && Array.isArray(data.downloads)) list = data.downloads;
    else if (data && Array.isArray(data.items)) list = data.items;
    else if (data && Array.isArray(data.tracks)) list = data.tracks;
    state.downloads = {};
    list.forEach((item) => {
      const normalized = normalizeDownload(item);
      if (normalized.id) state.downloads[normalized.id] = normalized;
    });
    if (previous !== JSON.stringify(state.downloads)) {
      renderDownloads();
      if (state.view === "library") renderLibrary();
      saveState();
    }
  }

  function applyNativeState(response) {
    const data = unwrap(response);
    if (!data || typeof data !== "object") return;
    const oldTrack = getTrack(state.currentId);
    const previousTrack = oldTrack ? JSON.stringify([oldTrack.id, oldTrack.title, oldTrack.artist, oldTrack.artworkUrl, oldTrack.duration]) : "";
    const previousQueue = state.queue.join("|");
    const previousId = state.currentId;
    const previousShuffle = state.shuffle;
    const previousRepeat = state.repeat;
    const previousSleep = state.sleepEndsAt;
    const hadNativeQueue = nativeHasQueue;
    const current = normalizeNativeTrack(data.currentTrack || data.track || null);
    const currentId = uiTrackId(data.currentId || data.trackId || (current && current.id) || "");
    if (currentId && getTrack(currentId)) state.currentId = currentId;
    else if (hadNativeQueue && data.track === null) state.currentId = "";
    if (typeof data.isPlaying === "boolean") state.isPlaying = data.isPlaying;
    if (typeof data.playing === "boolean") state.isPlaying = data.playing;
    state.loading = !!data.loading;
    if (typeof data.shuffle === "boolean") state.shuffle = data.shuffle;
    if (["off", "all", "one"].includes(data.repeat)) state.repeat = data.repeat;
    const position = Number(data.position != null ? data.position : data.currentTime);
    if (isFinite(position) && position >= 0) state.currentTime = position;
    const duration = Number(data.duration);
    if (isFinite(duration) && duration >= 0) state.duration = duration;
    if (Array.isArray(data.queue)) {
      const ids = data.queue
        .map((entry) => {
          if (typeof entry === "string") return getTrack(entry) ? uiTrackId(entry) : null;
          const normalized = normalizeNativeTrack(entry);
          return normalized ? normalized.id : null;
        })
        .filter(Boolean);
      if (ids.length || nativeHasQueue) state.queue = unique(ids);
      nativeHasQueue = ids.length > 0;
    }
    if (Number.isFinite(Number(data.sleepEndsAt))) {
      state.sleepEndsAt = Math.max(0, Number(data.sleepEndsAt));
      state.sleepMinutes = state.sleepEndsAt > Date.now()
        ? Number(data.sleepMinutes) || state.sleepMinutes || Math.ceil((state.sleepEndsAt - Date.now()) / 60000)
        : 0;
      if (previousSleep !== state.sleepEndsAt) startSleepTicker();
      renderSleep();
    }
    const error = data.error ? String(data.error) : "";
    if (error && error !== state.playbackError) toast("Playback failed", error);
    state.playbackError = error;
    const track = getTrack(state.currentId);
    const nextTrack = track ? JSON.stringify([track.id, track.title, track.artist, track.artworkUrl, track.duration]) : "";
    const queueChanged = previousQueue !== state.queue.join("|") || previousId !== state.currentId;
    const controlsChanged = previousShuffle !== state.shuffle || previousRepeat !== state.repeat;
    if (nextTrack !== previousTrack || controlsChanged || queueChanged) renderPlayer();
    else {
      updateProgressUI();
      renderPlayState();
    }
    if (queueChanged || controlsChanged) {
      state.queue.forEach(promoteTrack);
      renderQueue();
      renderUpNext();
    }
    if (queueChanged || controlsChanged || nextTrack !== previousTrack) saveState();
  }

  /* ---------------- SDK detection, toasts, modals ---------------- */

  function sdkHas(name) {
    return !!(window.customElements && window.customElements.get(name));
  }

  function isDialogSdk() {
    return sdkHas("ui-dialog") && sdkHas("ui-button");
  }

  function detectSdk() {
    if (sdkHas("ui-dialog")) {
      document.documentElement.classList.remove("no-sdk");
      return;
    }
    document.documentElement.classList.add("no-sdk");
  }

  if (window.customElements && window.customElements.whenDefined) {
    window.customElements
      .whenDefined("ui-dialog")
      .then(() => {
        document.documentElement.classList.remove("no-sdk");
        $$(".fallback-open").forEach((root) => {
          root.classList.remove("fallback-open");
          root.style.zIndex = "";
          const content = root.querySelector("ui-dialog-content, ui-alert-dialog-content, ui-drawer-content");
          if (content) content.hidden = true;
          try {
            root.open = true;
          } catch (error) {
            /* ignore */
          }
        });
      })
      .catch(() => {});
    setTimeout(detectSdk, 1800);
  } else {
    setTimeout(detectSdk, 300);
  }

  function toast(title, description) {
    const toaster = window.OrbitToast;
    if (typeof toaster === "function") {
      try {
        toaster(title, description ? { description: description } : undefined);
        return;
      } catch (error) {
        /* fall through */
      }
    }
    const region = $("#toastFallback");
    if (!region) return;
    const line = document.createElement("div");
    line.className = "toast-line";
    line.textContent = description ? title + " — " + description : title;
    region.appendChild(line);
    const id = ++toastSeq;
    line.dataset.toastId = String(id);
    setTimeout(() => {
      line.remove();
    }, 4200);
  }

  function modalOpen(root) {
    if (!root) return;
    if (sdkHas(root.localName)) {
      try {
        root.open = true;
        return;
      } catch (error) {
        /* fall through */
      }
    }
    root.classList.add("fallback-open");
    document.documentElement.classList.add("no-sdk");
    root.style.zIndex = String(++modalZ);
    const content = root.querySelector("ui-dialog-content, ui-alert-dialog-content, ui-drawer-content");
    if (content) content.hidden = false;
    const first = root.querySelector("input, button, [tabindex]");
    if (first) setTimeout(() => first.focus(), 60);
  }

  function modalClose(root) {
    if (!root) return;
    if (sdkHas(root.localName)) {
      try {
        root.open = false;
        return;
      } catch (error) {
        /* fall through */
      }
    }
    root.classList.remove("fallback-open");
    root.style.zIndex = "";
    const content = root.querySelector("ui-dialog-content, ui-alert-dialog-content, ui-drawer-content");
    if (content) content.hidden = true;
  }

  function closeAllModals() {
    [settingsDialog, queueDrawer, expandedDialog, promptDialog, confirmDialog, playlistPickerDialog].forEach((root) => {
      if (root && (root.classList.contains("fallback-open") || root.open)) modalClose(root);
    });
    if (fallbackSheet && fallbackSheet.open) fallbackSheet.close();
  }

  /* ---------------- prompts and confirms ---------------- */

  function askText(options) {
    return new Promise((resolve) => {
      if (promptResolve) {
        const previous = promptResolve;
        promptResolve = null;
        previous(null);
      }
      promptResolve = resolve;
      $("#promptTitle").textContent = options.title || "Name it";
      $("#promptDescription").textContent = options.description || "";
      $("#promptLabel").textContent = options.label || "Name";
      setFieldError($("#promptField"), "promptError", "");
      const input = $("#promptInput");
      setInputValue(input, options.value || "");
      input.placeholder = options.placeholder || "";
      input.maxLength = options.maxLength || 80;
      setSdkState($("#promptField"), "invalid", false);
      const save = $("#promptForm [data-action='submit-prompt']");
      if (save) save.textContent = options.confirmLabel || "Save";
      modalOpen(promptDialog);
      setTimeout(() => {
        input.focus();
        input.select();
      }, 80);
    });
  }

  function settlePrompt(value) {
    const resolve = promptResolve;
    promptResolve = null;
    if (resolve) resolve(value);
  }

  function submitPrompt() {
    if (!promptResolve) return;
    const input = $("#promptInput");
    const value = input ? input.value.trim() : "";
    if (!value) {
      setFieldError($("#promptField"), "promptError", "Enter a name first.");
      if (input) input.focus();
      return;
    }
    setFieldError($("#promptField"), "promptError", "");
    settlePrompt(value);
    modalClose(promptDialog);
  }

  function askConfirm(options) {
    return new Promise((resolve) => {
      if (confirmResolve) {
        const previous = confirmResolve;
        confirmResolve = null;
        previous(false);
      }
      confirmResolve = resolve;
      $("#confirmTitle").textContent = options.title || "Are you sure?";
      $("#confirmDescription").textContent = options.description || "";
      const button = $("#confirmButton");
      button.textContent = options.confirmLabel || "Delete";
      if (options.deletion) button.setAttribute("data-agent-confirm", options.description || "Deletes this item from your device");
      else button.removeAttribute("data-agent-confirm");
      modalOpen(confirmDialog);
    });
  }

  function settleConfirm(value) {
    const resolve = confirmResolve;
    confirmResolve = null;
    if (resolve) resolve(value);
  }

  /* ---------------- shared markup ---------------- */

  function coverMarkup(track, className) {
    return (
      '<div class="cover ' +
      (className || "") +
      '" data-art="' +
      esc(track.artworkUrl || "") +
      '" data-fallback="' +
      esc(initial(track.title)) +
      '"></div>'
    );
  }

  function applyArt(root) {
    $$("[data-art]", root || document).forEach((node) => {
      const url = node.getAttribute("data-art");
      if (!url) return;
      node.style.backgroundImage = 'url("' + url.replace(/"/g, "%22") + '")';
      node.classList.add("has-art");
    });
  }

  function playIcon() {
    return '<svg class="icon"><use href="#i-play"/></svg>';
  }

  function badgesMarkup(track) {
    const badges = [];
    if (track.source === "demo") badges.push('<span class="badge is-demo">Original demo</span>');
    if (track.source === "youtube") badges.push('<span class="badge is-youtube">YouTube</span>');
    if (track.source === "local") badges.push('<span class="badge is-local">Local file</span>');
    if (track.sessionOnly) badges.push('<span class="badge is-session">Session only</span>');
    if (track.originalTitle && track.originalTitle !== track.title) {
      badges.push('<span class="badge">Renamed</span>');
    }
    return badges.join("");
  }

  function trackDuration(track) {
    return track.duration > 0 ? formatTime(track.duration) : "—";
  }

  function isLiked(id) {
    return state.likes.indexOf(id) >= 0;
  }

  function trackMenuMarkup(track, playlistId) {
    return '<ui-menu data-track-id="' + esc(track.id) + '" data-playlist="' + esc(playlistId || "") + '">' +
      '<ui-menu-trigger><button class="icon-btn" type="button" data-action="track-menu" data-id="' + esc(track.id) +
      '" data-playlist="' + esc(playlistId || "") + '" aria-label="More options for ' + esc(track.title) +
      '"><svg class="icon"><use href="#i-more"/></svg></button></ui-menu-trigger>' +
      '<ui-menu-content side="bottom" align="end" side-offset="6" hidden>' +
      menuItems(playlistId).map((item) => '<ui-menu-item value="' + esc(item.value) + '">' + esc(item.label) + '</ui-menu-item>').join("") +
      '</ui-menu-content></ui-menu>';
  }

  function rowMarkup(track, options) {
    const opts = options || {};
    const current = state.currentId === track.id;
    const liked = isLiked(track.id);
    const context = opts.context || "home";
    const remove =
      opts.playlistId
        ? '<ui-button><button class="icon-btn" type="button" data-action="remove-from-playlist" data-playlist="' +
          esc(opts.playlistId) +
          '" data-id="' +
          esc(track.id) +
          '" aria-label="Remove ' +
          esc(track.title) +
          ' from this playlist"><svg class="icon"><use href="#i-x"/></svg></button></ui-button>'
        : "";
    return (
      '<div class="song-row' +
      (current ? " is-current" : "") +
      '" data-id="' +
      esc(track.id) +
      '" data-context="' +
      esc(context) +
      '">' +
      '<span class="row-index">' +
      (current ? "▶" : "") +
      "</span>" +
      '<div class="row-art">' +
      coverMarkup(track, "") +
      '<ui-button><button class="row-play" type="button" data-action="play-track" data-id="' +
      esc(track.id) +
      '" data-context="' +
      esc(context) +
      '" aria-label="Play ' +
      esc(track.title) +
      '">' +
      playIcon() +
      "</button></ui-button></div>" +
      '<div class="row-main"><strong class="row-title js-title">' +
      esc(track.title) +
      '</strong><small class="row-artist js-artist">' +
      esc(track.artist) +
      (track.source === "demo" ? ' <span class="row-original">· original</span>' : "") +
      "</small></div>" +
      '<div class="row-badges">' +
      badgesMarkup(track) +
      "</div>" +
      '<span class="row-duration">' +
      trackDuration(track) +
      "</span>" +
      '<div class="row-actions">' +
      '<ui-toggle data-like-id="' +
      esc(track.id) +
      '"><button class="icon-btn like-btn row-like' +
      (liked ? " is-liked" : "") +
      '" type="button" data-action="toggle-like" data-id="' +
      esc(track.id) +
      '" aria-pressed="' +
      String(liked) +
      '" aria-label="' +
      "Like " +
      esc(track.title) +
      '"><svg class="icon"><use href="#i-heart"/></svg></button></ui-toggle>' +
      remove +
      trackMenuMarkup(track, opts.playlistId) +
      "</div></div>"
    );
  }

  function railCardMarkup(track, context) {
    const current = state.currentId === track.id;
    return (
      '<article class="rail-card' +
      (current ? " is-current" : "") +
      '" data-id="' + esc(track.id) + '">' +
      '<div class="rail-art">' +
      coverMarkup(track, "") +
      '<div class="rail-overlay">' +
      '<ui-button><button class="rail-play" type="button" data-action="play-track" data-id="' +
      esc(track.id) +
      '" data-context="' +
      esc(context) +
      '" aria-label="Play ' +
      esc(track.title) +
      '">' +
      playIcon() +
      "</button></ui-button>" +
      '<span class="rail-badge">' +
      trackDuration(track) +
      "</span>" +
      "</div></div>" +
      '<div class="rail-meta"><div><strong class="rail-title js-title">' +
      esc(track.title) +
      '</strong><span class="rail-artist js-artist">' +
      esc(track.artist) +
      " · " +
      esc((track.moods && track.moods[0]) || (track.source === "demo" ? "Chill" : "Saved")) +
      "</span></div>" +
      trackMenuMarkup(track) +
      "</div></article>"
    );
  }

  function emptyState(icon, title, text) {
    return (
      '<div class="empty-state"><svg class="icon"><use href="#i-' +
      icon +
      '"/></svg><strong>' +
      esc(title) +
      "</strong><p>" +
      esc(text) +
      "</p></div>"
    );
  }

  function bindSdkEvents(root) {
    const scope = root || document;
    $$("ui-button", scope).forEach((wrapper) => {
      if (wrapper.dataset.sdkBound) return;
      if (!wrapper.querySelector("[data-action]")) return;
      wrapper.dataset.sdkBound = "1";
      wrapper.addEventListener("action", (event) => {
        const button = wrapper.querySelector("[data-action]");
        if (!button) return;
        const result = runAction(button, event);
        if (result && typeof result.then === "function" && event.detail && event.detail.waitUntil) event.detail.waitUntil(result);
      });
    });
    $$("ui-toggle", scope).forEach((wrapper) => {
      if (wrapper.closest("ui-toggle-group")) return;
      if (wrapper.dataset.sdkBound) return;
      const button = wrapper.querySelector("[data-action]");
      if (!button) return;
      wrapper.dataset.sdkBound = "1";
      if (wrapper.dataset.likeId) {
        try {
          setSdkState(wrapper, "pressed", isLiked(wrapper.dataset.likeId));
        } catch (error) {
          /* ignore */
        }
      }
      wrapper.addEventListener("pressedchange", (event) => {
        if (!event.detail) return;
        if (button.dataset.action === "toggle-like") setLiked(button.dataset.id || state.currentId, !!event.detail.value);
        else runAction(button, event);
      });
    });
    $$("ui-menu[data-track-id]", scope).forEach((menu) => {
      if (menu.dataset.sdkBound) return;
      menu.dataset.sdkBound = "1";
      menu.addEventListener("action", (event) => {
        const result = handleTrackMenuValue(event.detail && event.detail.value, menu.dataset.trackId, menu.dataset.playlist);
        if (result && typeof result.then === "function" && event.detail && event.detail.waitUntil) event.detail.waitUntil(result);
      });
    });
  }

  /* ---------------- navigation ---------------- */

  function setView(view) {
    state.view = view;
    $$(".view").forEach((section) => {
      const active = section.id === "view-" + view;
      section.hidden = !active;
      section.classList.toggle("is-active", active);
    });
    $$("[data-action='nav']").forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    const titles = {
      home: ["Listening room", "Home"],
      search: ["Find something", "Search"],
      library: ["Your collection", "Library"],
      downloads: ["Offline room", "Downloads"]
    };
    const copy = titles[view] || titles.home;
    const eyebrow = $("#topEyebrow");
    const title = $("#topTitle");
    if (eyebrow) eyebrow.textContent = copy[0];
    if (title) title.textContent = copy[1];
    const main = $(".main");
    if (main) main.scrollTop = 0;
    if (view === "library") renderLibrary();
    if (view === "downloads") renderDownloads();
    if (view === "search") renderSearch();
  }

  function renderNav() {
    setView(state.view);
  }

  function renderSidebar() {
    const box = $("#sidebarPlaylists");
    if (!box) return;
    if (!state.playlists.length) {
      box.innerHTML = '<p class="sidebar-note">No playlists yet. Make one from Library.</p>';
      return;
    }
    box.innerHTML = state.playlists
      .map(
        (playlist) =>
          '<ui-button><button class="side-playlist' +
          (state.activePlaylistId === playlist.id ? " is-active" : "") +
          '" type="button" data-action="open-playlist" data-id="' +
          esc(playlist.id) +
          '"><span class="dot"></span><span>' +
          esc(playlist.name) +
          "</span><small>" +
          playlist.trackIds.length +
          "</small></button></ui-button>"
      )
      .join("");
    bindSdkEvents(box);
  }

  function renderMood() {
    const counts = {};
    MOODS.forEach((mood) => {
      counts[mood] = mood === "All" ? DEMOS.length : DEMOS.filter((track) => track.moods.includes(mood)).length;
    });
    $$("#moodRail [data-action='mood']").forEach((button) => {
      const mood = button.dataset.mood;
      button.classList.toggle("is-active", mood === state.mood);
      const count = button.querySelector(".mood-count");
      if (count) count.textContent = String(counts[mood] || 0);
    });
    const group = $("#moodRail");
    if (group) {
      try {
        setSdkState(group, "value", [state.mood]);
      } catch (error) {
        /* ignore */
      }
    }
  }

  function renderHome() {
    renderMood();
    const tracks = filteredDemos();
    const rail = $("#coverRail");
    if (rail) {
      rail.innerHTML = tracks.length
        ? tracks.map((track) => railCardMarkup(track, "home")).join("")
        : emptyState("moon", "No loops in this mood", "Pick another frequency. Energy is waiting for a future loop.");
      applyArt(rail);
      bindSdkEvents(rail);
    }
    const rows = $("#homeRows");
    if (rows) {
      rows.innerHTML = tracks.length
        ? tracks.map((track) => rowMarkup(track, { context: "home" })).join("")
        : emptyState("music", "Nothing here yet", "Try All, Chill, Focus, or Dream.");
      applyArt(rows);
      bindSdkEvents(rows);
    }
    const floatArt = $("#heroFloatArt");
    const moon = getTrack("demo:moon");
    if (floatArt && moon) {
      floatArt.style.backgroundImage = 'url("' + moon.artworkUrl + '")';
      floatArt.classList.add("has-art");
    }
    $$("#homeRows ui-toggle[data-like-id]").forEach((toggle) => {
      const liked = isLiked(toggle.dataset.likeId);
      try {
        setSdkState(toggle, "pressed", liked);
      } catch (error) {
        /* ignore */
      }
    });
  }

  /* ---------------- player ---------------- */

  const playerSeek = $("#playerSeek");
  const expandedSeek = $("#expandedSeek");
  const playerSeekFallback = $("#playerSeekFallback");
  const expandedSeekFallback = $("#expandedSeekFallback");
  const playerLike = $("#playerLike");
  const expandedLike = $("#expandedLike");
  const motionToggle = $("#motionToggle");
  const themeGroup = $("#themeGroup");

  function renderPlayState() {
    $$(".js-play-icon use").forEach((use) => {
      use.setAttribute("href", state.isPlaying ? "#i-pause" : "#i-play");
    });
    $$(".js-play-toggle").forEach((button) => {
      button.setAttribute("aria-label", state.isPlaying ? "Pause" : "Play");
    });
    $$("[data-eq]").forEach((eq) => {
      eq.classList.toggle("is-playing", state.isPlaying);
    });
    document.documentElement.classList.toggle("is-playing", state.isPlaying);
    $$(".song-row, .rail-card").forEach((row) => {
      const current = row.dataset.id === state.currentId;
      row.classList.toggle("is-current", current);
      const index = row.querySelector(".row-index");
      if (index) index.textContent = current ? "▶" : "";
    });
    $$(".js-play-toggle").forEach((button) => button.classList.toggle("is-loading", state.loading));
    if (!isNative() && "mediaSession" in navigator) navigator.mediaSession.playbackState = state.isPlaying ? "playing" : "paused";
  }

  function updateProgressUI() {
    const track = getTrack(state.currentId);
    const duration = state.duration || (track && track.duration) || 0;
    const current = clamp(seekPreview == null ? state.currentTime || 0 : seekPreview, 0, duration || 0);
    [playerSeek, expandedSeek].forEach((slider) => {
      if (!slider || seekPreview != null) return;
      try {
        setSdkState(slider, "max", Math.max(0.1, duration));
        setSdkState(slider, "value", current);
        setSdkState(slider, "disabled", duration <= 0);
      } catch (error) {
        /* ignore */
      }
    });
    [playerSeekFallback, expandedSeekFallback].forEach((input) => {
      if (!input) return;
      input.max = String(duration || 0);
      input.value = String(current);
      input.disabled = duration <= 0;
    });
    const labels = [
      ["#playerCurrent", current],
      ["#expandedCurrent", current],
      ["#playerDuration", duration],
      ["#expandedDuration", duration]
    ];
    labels.forEach(([selector, value]) => {
      const node = $(selector);
      if (node) node.textContent = formatTime(value);
    });
    const bar = $("#miniProgressBar");
    if (bar) bar.style.width = (duration ? (current / duration) * 100 : 0) + "%";
  }

  function renderPlayer() {
    const track = getTrack(state.currentId) || {
      id: "", title: "Nothing playing", artist: "Choose a track to start your orbit.",
      source: "", artworkUrl: "", duration: 0
    };
    ["#playerTitle", "#expandedTitle", "#miniTitle"].forEach((selector) => {
      const node = $(selector);
      if (node) node.textContent = track.title;
    });
    ["#playerArtist", "#expandedArtist", "#miniArtist"].forEach((selector) => {
      const node = $(selector);
      if (node) node.textContent = track.artist;
    });
    const artNodes = ["#playerCover", "#expandedCover", "#miniCover"];
    artNodes.forEach((selector) => {
      const node = $(selector);
      if (!node) return;
      node.setAttribute("data-fallback", initial(track.title));
      if (track.artworkUrl) {
        node.style.backgroundImage = 'url("' + track.artworkUrl.replace(/"/g, "%22") + '")';
        node.classList.add("has-art");
      } else {
        node.style.backgroundImage = "";
        node.classList.remove("has-art");
      }
    });
    const badge = $("#playerSourceBadge");
    if (badge) {
      badge.hidden = !track.id;
      badge.textContent = track.source === "demo" ? "Demo" : track.source === "youtube" ? "YouTube" : "Local";
    }
    ["#playerBadges", "#expandedBadges"].forEach((selector) => {
      const node = $(selector);
      if (node) node.innerHTML = badgesMarkup(track);
    });
    const source = $("#expandedSource");
    if (source) {
      if (!track.id) {
        source.textContent = "Play a track to start a new queue.";
      } else if (track.source === "demo") {
        source.textContent = "Original Orbit demo · 24 seconds. Use Repeat to loop it. Not a commercial track.";
      } else if (track.source === "youtube") {
        source.textContent = "YouTube result via " + (isNative() ? "the native extractor." : "your Piped endpoint.");
      } else {
        source.textContent = "Local audio import. Browser imports live only for this session.";
      }
    }
    const liked = isLiked(track.id);
    [playerLike, expandedLike].forEach((toggle) => {
      if (!toggle) return;
      try {
        setSdkState(toggle, "disabled", !track.id);
        setSdkState(toggle, "pressed", liked);
      } catch (error) {
        /* ignore */
      }
      const button = toggle.querySelector("button");
      if (button) {
        button.disabled = !track.id;
        button.classList.toggle("is-liked", liked);
        button.setAttribute("aria-pressed", String(liked));
        button.setAttribute("aria-label", "Like " + track.title);
      }
    });
    [playerLike, expandedLike].forEach((toggle) => {
      const button = toggle && toggle.querySelector("button");
      if (button) button.classList.toggle("is-liked", liked);
    });
    $$("[data-action='shuffle']").forEach((button) => {
      button.classList.toggle("is-on", state.shuffle);
      button.setAttribute("aria-pressed", String(state.shuffle));
    });
    $$("[data-action='repeat']").forEach((button) => {
      if (!button) return;
      button.classList.toggle("is-on", state.repeat !== "off");
      button.classList.toggle("repeat-one-on", state.repeat === "one");
      button.setAttribute("aria-label", "Repeat " + state.repeat);
    });
    const repeatButton = $("#playerRepeat");
    if (repeatButton) repeatButton.setAttribute("aria-label", "Repeat " + state.repeat);
    state.duration = track.id ? state.duration || track.duration || 0 : 0;
    updateProgressUI();
    renderPlayState();
    renderSleep();
    document.title = track.id ? (state.isPlaying ? "▶ " : "") + track.title + " — ORBIT" : "ORBIT";
    if (track.id) updateMediaSession(track);
    else if (!isNative() && "mediaSession" in navigator) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
    }
  }

  function renderUpNext() {
    const box = $("#upNextList");
    if (!box) return;
    ensureQueue();
    const index = state.queue.indexOf(state.currentId);
    let ids = state.queue.slice(index + 1, index + 4);
    if (!ids.length && state.repeat === "all") ids = state.queue.slice(0, 3);
    if (!ids.length) {
      box.innerHTML = '<p class="room-note">Queue is clear. Play a loop to start again.</p>';
      return;
    }
    box.innerHTML = ids
      .map((id) => {
        const track = getTrack(id);
        if (!track) return "";
        return (
          '<ui-button><button class="next-item" type="button" data-action="play-track" data-id="' +
          esc(track.id) +
          '" data-context="queue"><span class="row-art">' +
          coverMarkup(track, "") +
          '</span><span class="next-copy"><strong>' +
          esc(track.title) +
          "</strong><small>" +
          esc(track.artist) +
          "</small></span></button></ui-button>"
        );
      })
      .join("");
    applyArt(box);
    bindSdkEvents(box);
  }

  function renderQueue() {
    const box = $("#queueList");
    if (!box) return;
    ensureQueue();
    box.innerHTML = state.queue
      .map((id, index) => {
        const track = getTrack(id);
        if (!track) return "";
        const current = id === state.currentId;
        return (
          '<div class="queue-item' +
          (current ? " is-current" : "") +
          '" data-id="' +
          esc(track.id) +
          '"><span class="queue-handle">' +
          (current ? "▶" : twoDigits(index + 1)) +
          '</span><div class="row-art">' +
          coverMarkup(track, "") +
          '</div><div class="row-main"><strong class="row-title js-title">' +
          esc(track.title) +
          '</strong><small class="row-artist js-artist">' +
          esc(track.artist) +
          '</small></div><div class="queue-item-actions">' +
          '<ui-button><button class="icon-btn" type="button" data-action="queue-up" data-id="' +
          esc(track.id) +
          '" aria-label="Move ' +
          esc(track.title) +
          ' up"' +
          (index === 0 ? " disabled" : "") +
          '><svg class="icon"><use href="#i-up"/></svg></button></ui-button>' +
          '<ui-button><button class="icon-btn" type="button" data-action="queue-down" data-id="' +
          esc(track.id) +
          '" aria-label="Move ' +
          esc(track.title) +
          ' down"' +
          (index === state.queue.length - 1 ? " disabled" : "") +
          '><svg class="icon"><use href="#i-down"/></svg></button></ui-button>' +
          '<ui-button><button class="icon-btn" type="button" data-action="queue-remove" data-id="' +
          esc(track.id) +
          '" aria-label="Remove ' +
          esc(track.title) +
          ' from queue"><svg class="icon"><use href="#i-x"/></svg></button></ui-button>' +
          "</div></div>"
        );
      })
      .join("");
    applyArt(box);
    bindSdkEvents(box);
    renderSleep();
  }

  /* ---------------- search ---------------- */

  function renderSearchBanner() {
    const banner = $("#searchSourceBanner");
    const help = $("#searchHelpText");
    if (!banner) return;
    banner.classList.remove("is-warn");
    if (isNative()) {
      banner.innerHTML =
        '<span class="source-tag">Android</span><strong>Native YouTube search</strong><span>Results and playback run through the on-device extractor.</span>';
    } else if (state.pipedUrl) {
      banner.innerHTML =
        '<span class="source-tag">Browser</span><strong>Your Piped endpoint</strong><span>' +
        esc(state.pipedUrl) +
        "</span>";
    } else {
      banner.classList.add("is-warn");
      banner.innerHTML =
        '<span class="source-tag">Browser</span><strong>No search source yet</strong><span>Connect your own Piped API endpoint in Settings. The four demo loops never need it.</span>';
    }
    if (help) {
      help.textContent = isNative()
        ? "YouTube search and playback are handled by the Android app. Demo loops play offline from the APK. Nothing is faked: if the native extractor fails, the error is shown here."
        : "In a browser, search needs your own Piped API endpoint, set in Settings. There is no public server baked in and no invented results. Demo loops play offline without any network.";
    }
  }

  function renderSearch() {
    renderSearchBanner();
    const status = $("#searchStatus");
    const results = $("#searchResults");
    if (status) {
      status.classList.toggle("is-error", !!state.searchError);
      if (state.searchLoading) {
        status.innerHTML = '<span class="spinner"></span>Searching ' + esc(state.searchQuery || "") + "…";
      } else if (state.searchError) {
        status.textContent = state.searchError;
      } else if (state.searchResults.length) {
        status.textContent = state.searchResults.length + " result" + (state.searchResults.length === 1 ? "" : "s") + ".";
      } else if (state.searchQuery) {
        status.textContent = "No results for “" + state.searchQuery + "”.";
      } else {
        status.textContent = "";
      }
    }
    if (!results) return;
    if (state.searchLoading) {
      results.innerHTML = Array.from({ length: 6 })
        .map(() => '<div class="skeleton"></div>')
        .join("");
      return;
    }
    if (state.searchResults.length) {
      results.innerHTML = state.searchResults.map((track) => rowMarkup(track, { context: "search" })).join("");
      applyArt(results);
      bindSdkEvents(results);
      $$("ui-toggle[data-like-id]", results).forEach((toggle) => {
        try {
          setSdkState(toggle, "pressed", isLiked(toggle.dataset.likeId));
        } catch (error) {
          /* ignore */
        }
      });
      return;
    }
    if (!state.searchError && !state.searchQuery) {
      results.innerHTML = emptyState(
        "search",
        "Search something real",
        "Type a song, artist, or paste a YouTube link. Without a source, Orbit tells you instead of inventing results."
      );
    } else {
      results.innerHTML = "";
    }
  }

  function pipedBase() {
    if (!state.pipedUrl) throw new Error("Add your own Piped API endpoint in Settings first.");
    return state.pipedUrl.replace(/\/+$/, "");
  }

  async function pipedFetch(path, params, signal) {
    const base = pipedBase();
    let url;
    try {
      url = new URL(base + path);
    } catch (error) {
      throw new Error("The saved Piped endpoint is not a valid URL.");
    }
    Object.keys(params || {}).forEach((key) => {
      if (params[key] != null) url.searchParams.set(key, params[key]);
    });
    let response;
    try {
      response = await fetch(url.toString(), {
        signal: signal,
        headers: { Accept: "application/json" }
      });
    } catch (error) {
      if (error && error.name === "AbortError") throw error;
      throw new Error("Could not reach your Piped endpoint. Check the URL, CORS, and your connection.");
    }
    if (!response.ok) throw new Error("Piped returned HTTP " + response.status + ".");
    try {
      return await response.json();
    } catch (error) {
      throw new Error("Piped returned a response that was not JSON.");
    }
  }

  function pipedTrackFromStream(data, fallbackId) {
    const videoId = fallbackId || extractYouTubeId(data.url || "") || "";
    if (!videoId) return null;
    const track = registerTrack({
      id: "yt:" + videoId,
      title: data.title || "Untitled video",
      artist: data.uploader || data.uploaderName || data.channel || "YouTube",
      source: "youtube",
      videoId: videoId,
      duration: Number(data.duration) || 0,
      artworkUrl: data.thumbnailUrl || data.thumbnail || ""
    });
    return track;
  }

  function pipedSearchResults(data) {
    const items = Array.isArray(data && data.items) ? data.items : [];
    return items
      .filter((item) => item && item.type !== "channel" && item.type !== "playlist")
      .map((item) => {
        const videoId = extractYouTubeId(item.url || "") || extractYouTubeId(item.videoId || "") || "";
        if (!videoId) return null;
        return registerTrack({
          id: "yt:" + videoId,
          title: item.title || "Untitled video",
          artist: item.uploaderName || item.uploader || "YouTube",
          source: "youtube",
          videoId: videoId,
          duration: Number(item.duration) || 0,
          artworkUrl: item.thumbnail || item.thumbnailUrl || ""
        });
      })
      .filter(Boolean);
  }

  async function runSearch(rawQuery) {
    const query = String(rawQuery || "").trim();
    if (!query) {
      toast("Type something first", "Search a song, artist, or paste a YouTube link.");
      return;
    }
    setView("search");
    const topInput = $("#topSearchInput");
    const searchInput = $("#searchInput");
    setInputValue(topInput, query);
    setInputValue(searchInput, query);
    state.searchQuery = query;
    state.searchLoading = true;
    state.searchError = "";
    state.searchResults = [];
    renderSearch();
    const generation = ++searchGen;
    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();
    const signal = searchAbort.signal;
    const videoId = extractYouTubeId(query);
    try {
      if (navigator.onLine === false) throw new Error("You're offline. Search needs a connection; demo loops still play.");
      let results = [];
      if (isNative()) {
        const payload = videoId ? { query: query, videoId: videoId, url: query } : { query: query };
        const response = await nativeRequest("search", payload, 22000);
        if (generation !== searchGen) return;
        results = normalizeNativeResults(response);
        if (!results.length) throw new Error("The native extractor returned no results for that query.");
      } else if (state.pipedUrl) {
        if (videoId) {
          const data = await pipedFetch("/streams/" + encodeURIComponent(videoId), {}, signal);
          const track = pipedTrackFromStream(data, videoId);
          results = track ? [track] : [];
        } else {
          const data = await pipedFetch("/search", { q: query, filter: "videos" }, signal);
          results = pipedSearchResults(data);
        }
        if (!results.length) throw new Error("That search returned no playable results.");
      } else {
        throw new Error("No search source. Connect your own Piped API endpoint in Settings, or use the Android app.");
      }
      if (generation !== searchGen) return;
      state.searchResults = results;
      state.searchError = "";
    } catch (error) {
      if (error && error.name === "AbortError") return;
      if (generation !== searchGen) return;
      state.searchError = errorMessage(error, "Search failed.");
      state.searchResults = [];
    } finally {
      if (generation === searchGen) {
        state.searchLoading = false;
        renderSearch();
      }
    }
  }

  async function resolveBrowserStream(track) {
    if (track.audioUrl && (track.source !== "youtube" || Date.now() - (track.resolvedAt || 0) < 600000)) return track.audioUrl;
    if (track.source === "youtube" && track.videoId) {
      const data = await pipedFetch("/streams/" + encodeURIComponent(track.videoId), {});
      const streams = Array.isArray(data.audioStreams) ? data.audioStreams.slice() : [];
      streams.sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
      const chosen = streams.find((stream) => stream && stream.url && audio && audio.canPlayType(stream.mimeType || "audio/mp4")) || streams[0];
      if (!chosen || !chosen.url) throw new Error("This endpoint returned no audio stream for that video.");
      const absolute = new URL(chosen.url, pipedBase() + "/").toString();
      if (!absolute.startsWith("https://")) throw new Error("This endpoint returned an unsafe audio URL. HTTPS is required.");
      track.audioUrl = absolute;
      track.resolvedAt = Date.now();
      return absolute;
    }
    throw new Error("No playable audio URL for this track.");
  }

  /* ---------------- library ---------------- */

  function renderLibrary() {
    const filterInput = $("#libraryFilter");
    if (filterInput && filterInput.value !== state.filter) setInputValue(filterInput, state.filter);
    const all = libraryTracks().filter(matchesFilter);
    const liked = likedTracks().filter(matchesFilter);
    const count = $("#libraryCount");
    if (count) count.textContent = all.length + " saved track" + (all.length === 1 ? "" : "s");
    const likedCount = $("#likedCountLabel");
    if (likedCount) likedCount.textContent = liked.length + " liked";
    const playlistCount = $("#playlistCountLabel");
    if (playlistCount) playlistCount.textContent = state.playlists.length + " playlist" + (state.playlists.length === 1 ? "" : "s");

    const likedBox = $("#likedRows");
    if (likedBox) {
      likedBox.innerHTML = liked.length
        ? liked.map((track) => rowMarkup(track, { context: "library" })).join("")
        : emptyState("heart", "No liked songs yet", "Tap the heart on any loop or search result. It stays on this device.");
      applyArt(likedBox);
      bindSdkEvents(likedBox);
    }

    const rows = $("#libraryRows");
    if (rows) {
      rows.innerHTML = all.length
        ? all.map((track) => rowMarkup(track, { context: "library" })).join("")
        : emptyState("library", "Your library is quiet", "Like a track, save a search result to a playlist, or import a local audio file.");
      applyArt(rows);
      bindSdkEvents(rows);
    }

    const grid = $("#playlistGrid");
    if (grid) {
      const query = state.filter.trim().toLowerCase();
      const playlists = state.playlists.filter((playlist) => !query || playlist.name.toLowerCase().includes(query));
      if (!playlists.length) {
        grid.innerHTML = emptyState(
          "folder-plus",
          state.playlists.length ? "No playlists match" : "No playlists yet",
          state.playlists.length ? "Clear the filter or try another name." : "Create one, then add any track from its overflow menu."
        );
      } else {
        grid.innerHTML = playlists
          .map((playlist) => {
            const tracks = playlist.trackIds.map(getTrack).filter(Boolean).slice(0, 4);
            let mosaic;
            if (tracks.length) {
              const cells = tracks.map((track) => coverMarkup(track, ""));
              while (cells.length < 4) cells.push('<span class="mosaic-blank"></span>');
              mosaic = cells.join("");
            } else {
              mosaic = '<span class="mosaic-empty"><svg class="icon"><use href="#i-music"/></svg></span>';
            }
            return (
              '<article class="playlist-card' +
              (state.activePlaylistId === playlist.id ? " is-active" : "") +
              '"><ui-button><button class="playlist-open" type="button" data-action="open-playlist" data-id="' +
              esc(playlist.id) +
              '"><div class="playlist-mosaic">' +
              mosaic +
              '</div><strong class="js-title">' +
              esc(playlist.name) +
              '</strong><small class="js-artist">' +
              playlist.trackIds.length +
              " track" +
              (playlist.trackIds.length === 1 ? "" : "s") +
              '</small></button></ui-button><div class="playlist-card-actions">' +
              '<ui-button><button class="icon-btn" type="button" data-action="rename-playlist" data-id="' +
              esc(playlist.id) +
              '" aria-label="Rename ' +
              esc(playlist.name) +
              '"><svg class="icon"><use href="#i-pencil"/></svg></button></ui-button>' +
              '<ui-button><button class="icon-btn" type="button" data-action="delete-playlist" data-id="' +
              esc(playlist.id) +
              '" aria-label="Delete ' +
              esc(playlist.name) +
              '"><svg class="icon"><use href="#i-trash"/></svg></button></ui-button>' +
              "</div></article>"
            );
          })
          .join("");
        applyArt(grid);
        bindSdkEvents(grid);
      }
    }

    const detail = $("#playlistDetail");
    if (detail) {
      const playlist = state.playlists.find((pl) => pl.id === state.activePlaylistId);
      if (!playlist) {
        detail.innerHTML = "";
      } else {
        const tracks = playlist.trackIds.map(getTrack).filter(Boolean);
        detail.innerHTML =
          '<div class="playlist-detail"><div class="playlist-detail-head"><div><span class="eyebrow">Playlist</span><h2 class="js-title">' +
          esc(playlist.name) +
          '</h2><small class="js-artist">' +
          tracks.length +
          " track" +
          (tracks.length === 1 ? "" : "s") +
          ' · saved on this device</small></div><div class="playlist-detail-actions">' +
          '<ui-button><button class="btn btn-primary" type="button" data-action="play-playlist" data-id="' +
          esc(playlist.id) +
          '"' +
          (tracks.length ? "" : " disabled") +
          '><svg class="icon"><use href="#i-play"/></svg> Play all</button></ui-button>' +
          '<ui-button><button class="btn btn-ghost" type="button" data-action="rename-playlist" data-id="' +
          esc(playlist.id) +
          '">Rename</button></ui-button>' +
          '<ui-button><button class="btn btn-ghost" type="button" data-action="delete-playlist" data-id="' +
          esc(playlist.id) +
          '">Delete</button></ui-button>' +
          '<ui-button><button class="btn btn-ghost" type="button" data-action="close-playlist">Close</button></ui-button>' +
          '</div></div><div class="song-list">' +
          (tracks.length
            ? tracks.map((track) => rowMarkup(track, { context: "playlist:" + playlist.id, playlistId: playlist.id })).join("")
            : emptyState("plus", "This playlist is empty", "Use the overflow menu on any track to add it here.")) +
          "</div></div>";
        applyArt(detail);
        bindSdkEvents(detail);
      }
    }
  }

  function openPlaylist(id) {
    state.activePlaylistId = id;
    setView("library");
    renderLibrary();
    renderSidebar();
    const detail = $("#playlistDetail");
    if (detail) detail.scrollIntoView({ behavior: state.motion ? "smooth" : "auto", block: "start" });
  }

  function playPlaylist(id) {
    const playlist = state.playlists.find((pl) => pl.id === id);
    if (!playlist || !playlist.trackIds.length) {
      toast("Playlist is empty", "Add a track first.");
      return;
    }
    const first = playlist.trackIds.map(getTrack).filter(Boolean)[0];
    if (first) playTrack(first.id, "playlist:" + id);
  }

  /* ---------------- downloads ---------------- */

  function renderDownloads() {
    const stateBox = $("#downloadState");
    if (stateBox) {
      stateBox.innerHTML = isNative()
        ? '<svg class="icon"><use href="#i-download"/></svg><span>Native downloads: queued until the Android download service reports complete.</span>'
        : '<svg class="icon"><use href="#i-download"/></svg><span>Browser mode saves files only. It never fakes an offline library.</span>';
    }
    const list = $("#downloadsList");
    if (list) {
      const items = Object.keys(state.downloads)
        .map((id) => state.downloads[id])
        .filter((item) => item && item.id);
      if (!items.length) {
        list.innerHTML = isNative()
          ? emptyState("download", "No downloads yet", "Use a track's overflow menu, then choose Download. A download shows queued until it completes.")
          : emptyState("download", "No offline library in a browser", "Demo loops can be saved as files. YouTube downloads need the Android app.");
      } else {
        list.innerHTML = items
          .map((item) => {
            const track = getTrack(item.id) || {
              id: item.id,
              title: item.title,
              artist: item.artist,
              artworkUrl: item.artworkUrl,
              source: "youtube"
            };
            const statusClass =
              item.status === "complete"
                ? "is-complete"
                : item.status === "failed"
                ? "is-failed"
                : "is-queued";
            return (
              '<div class="download-row" data-id="' +
              esc(item.id) +
              '"><div class="row-art">' +
              coverMarkup(track, "") +
              '</div><div class="row-main"><strong class="row-title js-title">' +
              esc(item.title || track.title) +
              '</strong><small class="row-artist js-artist">' +
              esc(item.artist || track.artist || "") +
              (item.error ? " · " + esc(item.error) : "") +
              '</small></div><span class="download-status ' +
              statusClass +
              '">' +
              esc(item.status || "queued") +
              '</span><div class="row-actions">' +
              (item.status === "complete"
                ? '<ui-button><button class="icon-btn" type="button" data-action="play-track" data-id="' +
                  esc(item.id) +
                  '" data-context="downloads" aria-label="Play ' +
                  esc(track.title) +
                  '"><svg class="icon"><use href="#i-play"/></svg></button></ui-button>'
                 : "") +
              (item.status === "failed"
                ? '<ui-button><button class="icon-btn" type="button" data-action="download" data-id="' + esc(item.id) +
                  '" aria-label="Retry download of ' + esc(track.title) + '"><svg class="icon"><use href="#i-refresh"/></svg></button></ui-button>'
                : "") +
              (isNative()
                ? '<ui-button><button class="icon-btn" type="button" data-action="remove-download" data-id="' +
                  esc(item.id) +
                  '" aria-label="Remove download of ' + esc(track.title) + '"><svg class="icon"><use href="#i-trash"/></svg></button></ui-button>'
                : "") +
              "</div></div>"
            );
          })
          .join("");
        applyArt(list);
        bindSdkEvents(list);
      }
    }
    const grid = $("#demoDownloadGrid");
    if (grid) {
      grid.innerHTML = DEMOS.map((demo) => {
        const track = demoMap.get(demo.id);
        return (
          '<div class="demo-download-card"><div class="row-art">' +
          coverMarkup(track, "") +
          '</div><div><strong class="js-title">' +
          esc(track.title) +
          '</strong><small class="js-artist">24s · WAV</small></div>' +
          '<ui-button><button class="icon-btn" type="button" data-action="download-demo" data-id="' +
          esc(track.id) +
          '" aria-label="Download ' +
          esc(track.title) +
          '"><svg class="icon"><use href="#i-download"/></svg></button></ui-button></div>'
        );
      }).join("");
      applyArt(grid);
      bindSdkEvents(grid);
    }
  }

  function browserDownload(url, filename) {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  async function downloadTrack(id) {
    const track = getTrack(id);
    if (!track) return;
    if (track.source === "local") {
      toast("Already a local file", "Imported audio plays from the file you selected.");
      return;
    }
    if (isNative()) {
      if (state.downloads[track.id] && ["queued", "downloading", "running", "pending", "paused", "complete"].includes(state.downloads[track.id].status)) {
        toast("Already downloaded or queued", track.title);
        return;
      }
      const previous = state.downloads[track.id];
      try {
        const response = unwrap(await nativeRequest("download", { track: nativeTrackPayload(track) }, 20000)) || {};
        const existing = state.downloads[track.id];
        if (!existing || existing === previous) state.downloads[track.id] = normalizeDownload({ ...response, id: track.id, track });
        promoteTrack(track.id);
        renderDownloads();
        saveState();
        toast("Download queued", "Orbit marks it complete when the native download finishes.");
      } catch (error) {
        toast("Download did not start", errorMessage(error));
      }
      return;
    }
    if (track.source === "demo") {
      browserDownload(track.audioUrl, safeFilename(track.title) + ".wav");
      toast("Download started", "Your browser saves a file. Offline tracks live in the Android app.");
      return;
    }
    toast("Browser download is a file only", "YouTube audio needs the Android extractor. No offline library is invented here.");
  }

  async function refreshDownloads() {
    if (!isNative()) {
      renderDownloads();
      toast("Browser mode", "There is no native download list to refresh.");
      return;
    }
    const token = downloadChangeToken;
    try {
      const response = await nativeRequest("downloads", {}, 12000);
      if (token !== downloadChangeToken) return;
      applyDownloads(response);
      toast("Downloads refreshed", "Native download states are up to date.");
    } catch (error) {
      toast("Could not refresh downloads", errorMessage(error));
    }
  }

  function removeDownloadFlow(id) {
    const track = getTrack(id);
    askConfirm({
      title: "Remove this download?",
      description: "The offline file is deleted from the Android app. You can download it again later.",
      confirmLabel: "Remove download",
      deletion: true
    }).then(async (confirmed) => {
      if (!confirmed) return;
      try {
        if (isNative()) await nativeRequest("removeDownload", { id: nativeTrackId(id) }, 12000);
        delete state.downloads[id];
        renderDownloads();
        renderLibrary();
        saveState();
        toast("Download removed", track ? track.title : "The file was removed.");
      } catch (error) {
        toast("Could not remove download", errorMessage(error));
      }
    });
  }

  /* ---------------- settings ---------------- */

  function normalizePiped(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    let url;
    try {
      url = new URL(raw);
    } catch (error) {
      return null;
    }
    if (url.protocol !== "https:") return null;
    const path = url.pathname.replace(/\/+$/, "");
    return url.origin + path;
  }

  function renderSettingsState() {
    const input = $("#pipedUrlInput");
    if (input && document.activeElement !== input) setInputValue(input, state.pipedUrl);
    const pipedBox = $("#pipedSettings");
    if (pipedBox) pipedBox.hidden = isNative();
    const sourceState = $("#settingsSourceState");
    if (sourceState) {
      sourceState.innerHTML = isNative()
        ? '<span class="source-dot is-native"></span> Android native extractor'
        : '<span class="source-dot"></span> Browser mode';
    }
    const copy = $("#settingsSourceCopy");
    if (copy) {
      copy.textContent = isNative()
        ? "Search, playback, queue, and downloads are handled by the Android app through its native extractor. The four demo loops are bundled and play offline."
        : "Demo loops play from local files. YouTube search and playback are optional: add your own HTTPS Piped API endpoint below. No public server is hardcoded.";
    }
    if (themeGroup) {
      try {
        setSdkState(themeGroup, "value", [state.theme]);
      } catch (error) {
        /* ignore */
      }
    }
    $$("#themeGroup [data-action='theme']").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.themeChoice === state.theme);
    });
    if (motionToggle) {
      try {
        setSdkState(motionToggle, "checked", state.motion);
      } catch (error) {
        /* ignore */
      }
      motionToggle.classList.toggle("is-on", state.motion);
    }
  }

  function renderSource() {
    const dot = $("#sourceDot");
    const label = $("#sourceLabel");
    const detail = $("#sourceDetail");
    if (dot) {
      dot.classList.toggle("is-native", isNative());
      dot.classList.toggle("is-offline", !isNative() && navigator.onLine === false);
    }
    if (label) label.textContent = isNative() ? "Android mode" : "Browser mode";
    if (detail) {
      if (isNative()) detail.textContent = "Native extractor";
      else if (state.pipedUrl) detail.textContent = "Piped connected";
      else detail.textContent = "Demo loops ready";
    }
    renderSettingsState();
    renderSearchBanner();
  }

  function setTheme(theme) {
    state.theme = theme === "daylight" ? "daylight" : "midnight";
    document.documentElement.setAttribute("data-theme", state.theme);
    renderSettingsState();
    saveState();
  }

  function setMotion(enabled) {
    state.motion = !!enabled;
    document.documentElement.setAttribute("data-motion", state.motion ? "on" : "off");
    renderSettingsState();
    saveState();
  }

  function toggleMotion() {
    setMotion(!state.motion);
  }

  function setMood(mood) {
    state.mood = MOODS.includes(mood) ? mood : "All";
    renderHome();
    saveState();
  }

  function openSettings() {
    renderSettingsState();
    const input = $("#pipedUrlInput");
    setInputValue(input, state.pipedUrl);
    setFieldError(input && input.closest("ui-field"), "pipedError", "");
    modalOpen(settingsDialog);
  }

  async function testPiped() {
    const input = $("#pipedUrlInput");
    const status = $("#pipedStatus");
    const field = input && input.closest("ui-field");
    const normalized = normalizePiped(input ? input.value : state.pipedUrl);
    setFieldError(field, "pipedError", "");
    if (status) {
      status.className = "form-status";
      status.textContent = "";
    }
    if (!normalized) {
      setFieldError(field, "pipedError", "Enter an HTTPS URL, or clear the field to remove the endpoint.");
      return;
    }
    if (status) status.textContent = "Testing " + normalized + "…";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      const response = await fetch(normalized + "/search?q=orbit&filter=videos", {
        signal: controller.signal,
        headers: { Accept: "application/json" }
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error("HTTP " + response.status);
      const result = await response.json();
      if (!result || !Array.isArray(result.items)) throw new Error("Not a Piped API search response");
      if (status) {
        status.className = "form-status is-ok";
        status.textContent = "Connected. Save the endpoint to use it for search.";
      }
    } catch (caught) {
      clearTimeout(timer);
      if (status) {
        status.className = "form-status is-error";
        status.textContent =
          caught && caught.name === "AbortError"
            ? "The endpoint did not answer in 9 seconds."
            : "Could not reach that endpoint. Check HTTPS, CORS, and the URL.";
      }
    }
  }

  function savePiped() {
    const input = $("#pipedUrlInput");
    const field = input && input.closest("ui-field");
    const status = $("#pipedStatus");
    const normalized = normalizePiped(input ? input.value : "");
    setFieldError(field, "pipedError", "");
    if (normalized === null) {
      setFieldError(field, "pipedError", "Use a valid HTTPS URL. HTTP endpoints are rejected.");
      return;
    }
    state.pipedUrl = normalized;
    saveState();
    renderSource();
    renderSearch();
    if (status) {
      status.className = "form-status is-ok";
      status.textContent = normalized ? "Saved. Search now uses this endpoint." : "Endpoint cleared.";
    }
    toast(normalized ? "Endpoint saved" : "Endpoint cleared", normalized || "Browser search is off until you add one.");
  }

  /* ---------------- playback ---------------- */

  function nativeControl(action, value) {
    if (!isNative()) return;
    return nativeRequest("control", { action: action, value: value == null ? null : value }, 8000).catch((error) => {
      toast("Native control failed", errorMessage(error));
      refreshNativeState();
    });
  }

  function syncNativeQueue() {
    if (!isNative() || !nativeHasQueue) return;
    const payload = nativeQueuePayload();
    return nativeRequest("queue", { queue: payload.queue, index: payload.index }, 10000).catch((error) => {
      toast("Queue update failed", errorMessage(error));
      refreshNativeState();
    });
  }

  async function startAudio(url, track) {
    if (!audio) return;
    try {
      audio.pause();
      audio.src = url;
      audio.load();
      await audio.play();
      updateMediaSession(track);
    } catch (error) {
      throw new Error("The audio file could not start. Check the file or the stream URL.");
    }
  }

  async function playTrack(id, context) {
    const track = getTrack(id);
    if (!track) {
      toast("Track unavailable", "That track is no longer in your library.");
      return;
    }
    id = track.id;
    if (context && context !== "queue") {
      const ids = contextTrackIds(context);
      if (ids && ids.length) {
        state.queue = unique(ids);
        browserShufflePlayed.clear();
      }
    }
    if (state.queue.indexOf(id) < 0) state.queue.push(id);
    state.currentId = id;
    browserShufflePlayed.add(id);
    seekPreview = null;
    state.currentTime = 0;
    state.duration = track.duration || 0;
    state.isPlaying = true;
    state.loading = true;
    state.playbackError = "";
    state.queue.forEach(promoteTrack);
    renderPlayer();
    renderQueue();
    renderUpNext();
    renderSidebar();
    saveState();
    const token = ++playToken;
    if (isNative()) {
      try {
        await nativeRequest("play", nativeQueuePayload(), 15000);
        if (token === playToken) nativeHasQueue = true;
      } catch (error) {
        if (token !== playToken) return;
        state.isPlaying = false;
        state.loading = false;
        renderPlayState();
        toast("Native playback failed", errorMessage(error));
      }
      return;
    }
    try {
      const url = await resolveBrowserStream(track);
      if (token !== playToken) return;
      await startAudio(url, track);
      if (token !== playToken) return;
      state.loading = false;
      renderPlayState();
    } catch (error) {
      if (token !== playToken) return;
      state.isPlaying = false;
      state.loading = false;
      renderPlayState();
      toast("Could not play that track", errorMessage(error));
    }
  }

  function pausePlayback() {
    playToken += 1;
    if (isNative()) nativeControl("pause");
    else if (audio) audio.pause();
    state.isPlaying = false;
    state.loading = false;
    renderPlayState();
  }

  function togglePlay() {
    if (isNative()) {
      if (state.isPlaying || state.loading) pausePlayback();
      else if (!nativeHasQueue) playTrack(state.currentId || DEMOS[0].id, "queue");
      else nativeControl("resume");
      return;
    }
    if (state.loading) {
      pausePlayback();
      return;
    }
    if (!audio || !audio.src || !state.queue.length) {
      const track = getTrack(state.currentId) || DEMOS[0];
      playTrack(track.id, "queue");
      return;
    }
    if (audio.paused) {
      audio.play().catch((error) => {
        state.isPlaying = false;
        renderPlayState();
        toast("Playback did not start", errorMessage(error));
      });
    } else {
      audio.pause();
    }
  }

  function nextTrack(auto) {
    if (isNative() && nativeHasQueue) {
      nativeControl("next");
      return;
    }
    ensureQueue();
    const queue = state.queue;
    if (!queue.length) return;
    if (auto && state.repeat === "one") {
      if (isNative()) nativeControl("seek", 0);
      else if (audio) {
        audio.currentTime = 0;
        audio.play().catch(() => {});
      }
      return;
    }
    let nextId = "";
    if (state.shuffle) {
      let pool = queue.filter((id) => !browserShufflePlayed.has(id));
      if (!pool.length && state.repeat === "all") {
        browserShufflePlayed.clear();
        pool = queue.filter((id) => queue.length === 1 || id !== state.currentId);
      }
      if (pool.length) nextId = pool[Math.floor(Math.random() * pool.length)];
    } else {
      const index = queue.indexOf(state.currentId);
      if (index + 1 < queue.length) nextId = queue[index + 1];
      else if (!auto || state.repeat === "all") nextId = queue[0];
    }
    if (!nextId) {
      pausePlayback();
      return;
    }
    playTrack(nextId, "queue");
  }

  function previousTrack() {
    if (isNative() && nativeHasQueue) {
      nativeControl("previous");
      return;
    }
    if (!isNative() && audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      state.currentTime = 0;
      updateProgressUI();
      return;
    }
    ensureQueue();
    const queue = state.queue;
    if (!queue.length) return;
    const index = queue.indexOf(state.currentId);
    const previousId = index > 0 ? queue[index - 1] : queue[queue.length - 1];
    if (previousId) playTrack(previousId, "queue");
  }

  function seekTo(value) {
    seekPreview = null;
    const track = getTrack(state.currentId);
    const duration = state.duration || (track && track.duration) || 0;
    const target = clamp(Number(value) || 0, 0, duration || 0);
    state.currentTime = target;
    if (isNative()) nativeControl("seek", target);
    else if (audio && audio.src) {
      try {
        audio.currentTime = target;
      } catch (error) {
        /* ignore */
      }
    }
    updateProgressUI();
  }

  function toggleShuffle() {
    state.shuffle = !state.shuffle;
    browserShufflePlayed.clear();
    if (state.currentId) browserShufflePlayed.add(state.currentId);
    if (isNative()) nativeControl("shuffle", state.shuffle);
    saveState();
    renderPlayer();
    renderQueue();
    toast(state.shuffle ? "Shuffle on" : "Shuffle off", state.shuffle ? "Next picks a random orbit." : "Next follows the queue order.");
  }

  function cycleRepeat() {
    state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
    if (isNative()) nativeControl("repeat", state.repeat);
    saveState();
    renderPlayer();
    renderQueue();
    toast(
      "Repeat " + state.repeat,
      state.repeat === "off" ? "Playback stops at the end." : state.repeat === "all" ? "Queue wraps around." : "Current track loops."
    );
  }

  function updateMediaSession(track) {
    if (isNative() || !("mediaSession" in navigator) || typeof window.MediaMetadata !== "function") return;
    try {
      const artwork = track.artworkUrl
        ? [{ src: new URL(track.artworkUrl, window.location.href).href, sizes: "512x512", type: "image/svg+xml" }]
        : [];
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: "ORBIT",
        artwork: artwork
      });
    } catch (error) {
      /* ignore */
    }
  }

  /* ---------------- sleep ---------------- */

  function renderSleep() {
    const remaining = state.sleepEndsAt ? Math.max(0, state.sleepEndsAt - Date.now()) : 0;
    const label = remaining > 0 ? formatTime(Math.ceil(remaining / 1000)) : "";
    const chip = $("#sleepStatus");
    const expandedChip = $("#expandedSleepStatus");
    const text = $("#sleepStatusText");
    if (chip) {
      chip.hidden = !remaining;
      chip.textContent = remaining ? "Sleep " + label : "";
    }
    if (expandedChip) {
      expandedChip.hidden = !remaining;
      expandedChip.textContent = remaining ? "Sleep " + label : "";
    }
    if (text) text.textContent = remaining ? "Stopping in " + label + "." : "Sleep timer off.";
    $$(".sleep-options [data-action='sleep']").forEach((button) => {
      const minutes = Number(button.dataset.minutes) || 0;
      button.classList.toggle("is-active", minutes === state.sleepMinutes && (minutes === 0 || remaining > 0));
    });
  }

  function startSleepTicker() {
    clearInterval(sleepTimer);
    sleepTimer = null;
    if (!state.sleepEndsAt || state.sleepEndsAt <= Date.now()) return;
    sleepTimer = setInterval(() => {
      const remaining = state.sleepEndsAt - Date.now();
      if (remaining <= 0) {
        clearInterval(sleepTimer);
        sleepTimer = null;
        state.sleepMinutes = 0;
        state.sleepEndsAt = 0;
        if (!isNative()) pausePlayback();
        renderSleep();
        toast("Sleep timer finished", "Playback paused. Rest well.");
      } else {
        renderSleep();
      }
    }, 1000);
  }

  function setSleep(minutes) {
    state.sleepMinutes = [15, 30, 60].includes(Number(minutes)) ? Number(minutes) : 0;
    state.sleepEndsAt = state.sleepMinutes ? Date.now() + state.sleepMinutes * 60000 : 0;
    if (isNative()) nativeControl("sleep", state.sleepMinutes);
    startSleepTicker();
    renderSleep();
    toast(state.sleepMinutes ? "Sleep timer set" : "Sleep timer off",
      state.sleepMinutes ? "Playback stops in " + state.sleepMinutes + " minutes." : "Playback will keep going.");
  }

  /* ---------------- likes, queue ---------------- */

  function toggleLike(id) {
    const target = uiTrackId(id || state.currentId);
    setLiked(target, !isLiked(target));
  }

  function setLiked(id, liked) {
    const target = uiTrackId(id || state.currentId);
    if (!target || !getTrack(target)) return;
    const index = state.likes.indexOf(target);
    if ((index >= 0) === liked) return;
    if (!liked) {
      state.likes.splice(index, 1);
      toast("Removed from liked songs", getTrack(target).title);
    } else {
      state.likes.push(target);
      promoteTrack(target);
      toast("Liked", getTrack(target).title);
    }
    saveState();
    renderAll();
  }

  function playNext(id) {
    const track = getTrack(id);
    if (!track) return;
    id = track.id;
    if (id === state.currentId) {
      toast("Already the current track", track.title);
      return;
    }
    ensureQueue();
    state.queue = state.queue.filter((item) => item !== id);
    const index = state.queue.indexOf(state.currentId);
    state.queue.splice(index + 1, 0, id);
    promoteTrack(id);
    syncNativeQueue();
    saveState();
    renderQueue();
    renderUpNext();
    toast("Playing next", track.title);
  }

  function moveQueue(id, direction) {
    ensureQueue();
    const index = state.queue.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= state.queue.length) return;
    const temp = state.queue[index];
    state.queue[index] = state.queue[target];
    state.queue[target] = temp;
    syncNativeQueue();
    saveState();
    renderQueue();
    renderUpNext();
  }

  function removeQueue(id) {
    ensureQueue();
    const previousIndex = state.queue.indexOf(id);
    const wasPlaying = state.isPlaying;
    state.queue = state.queue.filter((item) => item !== id);
    if (id === state.currentId) {
      const nextId = state.queue[Math.min(Math.max(0, previousIndex), state.queue.length - 1)];
      if (!state.queue.length) {
        pausePlayback();
        state.currentId = "";
        state.currentTime = 0;
        state.duration = 0;
        if (!isNative() && audio) {
          audio.removeAttribute("src");
          audio.load();
        }
      }
      else if (isNative()) state.currentId = nextId;
      else if (wasPlaying) playTrack(nextId, "queue");
      else {
        if (audio) {
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
        }
        state.currentId = nextId;
        state.currentTime = 0;
        state.duration = getTrack(nextId).duration || 0;
      }
    }
    syncNativeQueue();
    saveState();
    renderPlayer();
    renderQueue();
    renderUpNext();
  }

  /* ---------------- playlists ---------------- */

  function createPlaylist(name, trackId) {
    const playlist = {
      id: "pl:" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name: String(name || "Untitled playlist").trim().slice(0, 80) || "Untitled playlist",
      trackIds: trackId ? [trackId] : [],
      createdAt: Date.now()
    };
    state.playlists.push(playlist);
    if (trackId) promoteTrack(trackId);
    saveState();
    return playlist;
  }

  function createPlaylistFlow() {
    askText({
      title: "Name your playlist",
      description: "You can rename it later. Nothing leaves this device.",
      label: "Playlist name",
      confirmLabel: "Create playlist",
      placeholder: "Late night loops"
    }).then((name) => {
      if (!name) return;
      const playlist = createPlaylist(name);
      renderAll();
      toast("Playlist created", playlist.name);
    });
  }

  function renamePlaylist(id) {
    const playlist = state.playlists.find((pl) => pl.id === id);
    if (!playlist) return;
    askText({
      title: "Rename playlist",
      description: "Only the name changes. Tracks stay where they are.",
      label: "Playlist name",
      confirmLabel: "Save name",
      value: playlist.name
    }).then((name) => {
      if (!name) return;
      playlist.name = name.slice(0, 80);
      saveState();
      renderAll();
      toast("Playlist renamed", playlist.name);
    });
  }

  function deletePlaylistFlow(id) {
    const playlist = state.playlists.find((pl) => pl.id === id);
    if (!playlist) return;
    askConfirm({
      title: 'Delete "' + playlist.name + '"?',
      description: "This removes the playlist only. Its tracks stay in your library and liked songs.",
      confirmLabel: "Delete playlist",
      deletion: true
    }).then((confirmed) => {
      if (!confirmed) return;
      state.playlists = state.playlists.filter((pl) => pl.id !== id);
      if (state.activePlaylistId === id) state.activePlaylistId = null;
      saveState();
      renderAll();
      toast("Playlist deleted", playlist.name);
    });
  }

  function addToPlaylist(playlistId, trackId) {
    const playlist = state.playlists.find((pl) => pl.id === playlistId);
    const track = getTrack(trackId);
    if (!playlist || !track) return;
    const existing = playlist.trackIds.indexOf(trackId);
    if (existing >= 0) {
      playlist.trackIds.splice(existing, 1);
      toast("Removed from playlist", track.title);
    } else {
      playlist.trackIds.push(trackId);
      promoteTrack(trackId);
      toast("Added to " + playlist.name, track.title);
    }
    saveState();
    renderLibrary();
    renderSidebar();
  }

  function removeFromPlaylist(playlistId, trackId) {
    const playlist = state.playlists.find((pl) => pl.id === playlistId);
    if (!playlist) return;
    playlist.trackIds = playlist.trackIds.filter((id) => id !== trackId);
    saveState();
    renderLibrary();
    renderSidebar();
    toast("Removed from playlist", getTrack(trackId) ? getTrack(trackId).title : "Track removed.");
  }

  function renderPicker() {
    const list = $("#playlistPickerList");
    const track = getTrack(pickerTrackId);
    const description = $("#pickerDescription");
    if (description) description.textContent = track ? "Choose a playlist for “" + track.title + "”." : "Choose a playlist.";
    if (!list) return;
    if (!state.playlists.length) {
      list.innerHTML = emptyState("folder-plus", "No playlists yet", "Create one below, then this track is added to it.");
      return;
    }
    list.innerHTML = state.playlists
      .map((playlist) => {
        const added = track && playlist.trackIds.indexOf(track.id) >= 0;
        return (
          '<ui-button><button class="picker-item' +
          (added ? " is-added" : "") +
          '" type="button" data-action="picker-add" data-playlist="' +
          esc(playlist.id) +
          '"><svg class="icon"><use href="#i-' +
          (added ? "check" : "plus") +
          '"/></svg><strong>' +
          esc(playlist.name) +
          "</strong><small>" +
          playlist.trackIds.length +
          " track" +
          (playlist.trackIds.length === 1 ? "" : "s") +
          "</small></button></ui-button>"
        );
      })
      .join("");
    bindSdkEvents(list);
  }

  function openPicker(id) {
    pickerTrackId = id;
    renderPicker();
    modalOpen(playlistPickerDialog);
  }

  function pickerNewPlaylist() {
    askText({
      title: "New playlist",
      description: "The current track is added when you create it.",
      label: "Playlist name",
      confirmLabel: "Create and add",
      placeholder: "Night drive"
    }).then((name) => {
      if (!name) return;
      const playlist = createPlaylist(name, pickerTrackId);
      renderPicker();
      renderAll();
      toast("Playlist created", playlist.name + " · track added");
    });
  }

  /* ---------------- track menu ---------------- */

  function menuItems(playlistId) {
    const items = [
      { value: "play-next", label: "Play next" },
      { value: "add-playlist", label: "Add to playlist" },
      { value: "rename", label: "Rename track" },
      { value: "download", label: "Download" },
      { value: "share", label: "Share" }
    ];
    if (playlistId) items.push({ value: "remove", label: "Remove from playlist" });
    return items;
  }

  function openFallbackSheet(items) {
    const box = $("#fallbackSheetActions");
    if (!box || !fallbackSheet) return;
    box.innerHTML = items
      .map(
        (item) =>
          '<button type="button" data-menu-value="' +
          esc(item.value) +
          '"><svg class="icon"><use href="#i-' +
          (item.value === "play-next"
            ? "next"
            : item.value === "add-playlist"
            ? "plus"
            : item.value === "rename"
            ? "pencil"
            : item.value === "download"
            ? "download"
            : item.value === "share"
            ? "share"
            : "x") +
          '"/></svg><span>' +
          esc(item.label) +
          "</span></button>"
      )
      .join("");
    if (!fallbackSheet.open) fallbackSheet.showModal();
  }

  function openTrackMenu(id, anchor) {
    const track = getTrack(id);
    if (!track) return;
    fallbackTrackId = id;
    fallbackPlaylistId = (anchor && anchor.dataset.playlist) || "";
    const items = menuItems(fallbackPlaylistId);
    const menu = anchor && anchor.closest("ui-menu");
    if (sdkHas("ui-menu") && menu && menu.api) {
      menu.api.setOpen(true);
      return;
    }
    openFallbackSheet(items);
  }

  function handleTrackMenuValue(value, id, playlistId) {
    if (!value) return;
    const target = id || fallbackTrackId;
    const playlist = playlistId || fallbackPlaylistId;
    if (value === "play-next") return playNext(target);
    if (value === "add-playlist") return openPicker(target);
    if (value === "rename") return renameTrack(target);
    if (value === "download") return downloadTrack(target);
    if (value === "share") return shareTrack(target);
    if (value === "remove") return removeFromPlaylist(playlist, target);
  }

  /* ---------------- rename, share, export ---------------- */

  function renameTrack(id) {
    const track = getTrack(id);
    if (!track) return;
    askText({
      title: "Rename this track",
      description: track.originalTitle
        ? "Original title: " + track.originalTitle + ". Your name is kept on this device."
        : "Your name is kept on this device. The original title is preserved underneath.",
      label: "Track name",
      confirmLabel: "Save name",
      maxLength: 140,
      value: track.title
    }).then((name) => {
      if (!name) return;
      const clean = name.slice(0, 140);
      [demoMap.get(id), ...extraTracks.filter((item) => item.id === id), ...Array.from(runtimeTracks.values()).filter((item) => item.id === id)]
        .filter(Boolean)
        .forEach((item) => {
          item.originalTitle = item.originalTitle || item.title;
          item.title = clean;
        });
      state.customTitles[id] = clean;
      saveState();
      if (isNative()) {
        nativeRequest("rename", { id: nativeTrackId(id), title: clean }, 10000).catch((error) => {
          toast("Name saved on this device", "Native metadata update failed: " + errorMessage(error));
        });
      }
      renderAll();
      toast("Track renamed", clean);
    });
  }

  function shareTrack(id) {
    const track = getTrack(id);
    if (!track) return;
    const url = track.videoId ? "https://www.youtube.com/watch?v=" + encodeURIComponent(track.videoId) : window.location.href;
    const text = track.title + " — " + track.artist + " on ORBIT";
    if (window.Native && typeof window.Native.shareText === "function") {
      window.Native.shareText(text + (track.videoId ? " " + url : ""));
      return;
    }
    if (navigator.share) {
      navigator
        .share({ title: track.title, text: text, url: url })
        .catch((error) => {
          if (error && error.name === "AbortError") return;
          copyShare(text + " " + url);
        });
      return;
    }
    copyShare(text + " " + url);
  }

  function copyShare(text) {
    if (window.Native && typeof window.Native.copyText === "function") {
      window.Native.copyText(text);
      toast("Copied to clipboard", "Share it anywhere.");
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => toast("Copied to clipboard", "Share it anywhere."))
        .catch(() => toast("Could not copy", "Clipboard is unavailable here."));
      return;
    }
    toast("Share unavailable", text);
  }

  function exportLibrary() {
    const summary = (track) => ({
      id: track.id,
      title: track.title,
      originalTitle: track.originalTitle || track.title,
      artist: track.artist,
      source: track.source,
      videoId: track.videoId || "",
      duration: track.duration || 0
    });
    const payload = {
      app: "ORBIT",
      version: 1,
      exportedAt: new Date().toISOString(),
      likes: state.likes.map(getTrack).filter((track) => track && !track.sessionOnly).map(summary),
      playlists: state.playlists.map((playlist) => ({
        name: playlist.name,
        createdAt: playlist.createdAt,
        tracks: playlist.trackIds.map(getTrack).filter((track) => track && !track.sessionOnly).map(summary)
      })),
      customTitles: Object.fromEntries(Object.entries(state.customTitles).filter(([id]) => getTrack(id) && !getTrack(id).sessionOnly)),
      settings: {
        theme: state.theme,
        motion: state.motion,
        pipedUrl: state.pipedUrl
      }
    };
    const content = JSON.stringify(payload, null, 2);
    if (window.Native && typeof window.Native.saveFile === "function") {
      const result = String(window.Native.saveFile("orbit-library.json", content));
      if (result.startsWith("failed")) toast("Export failed", result);
      else toast("Library exported", "Saved to Download/orbit-library.json.");
      return;
    }
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    browserDownload(url, "orbit-library.json");
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast("Library exported", "A readable JSON copy was saved.");
  }

  /* ---------------- local import ---------------- */

  async function importAudio() {
    if (!isNative()) {
      if (fileInput) fileInput.click();
      return;
    }
    try {
      const response = await nativeRequest("import", {}, 300000);
      const tracks = normalizeNativeResults(response);
      if (!tracks.length) throw new Error("Android returned no readable audio files.");
      tracks.forEach((track) => {
        track.sessionOnly = false;
        promoteTrack(track.id);
      });
      saveState();
      renderAll();
      setView("library");
      toast("Audio imported", tracks.length + " local file" + (tracks.length === 1 ? "" : "s") + " saved to your library.");
    } catch (error) {
      if (errorMessage(error) !== "Import cancelled") toast("Import failed", errorMessage(error));
    }
  }

  async function handleFiles(files) {
    if (!files || !files.length) return;
    if (isNative()) {
      await importAudio();
      return;
    }
    const accepted = /\.(mp3|m4a|aac|ogg|oga|wav|flac|opus|webm)$/i;
    for (const file of Array.from(files)) {
      if (!/^audio\//.test(file.type) && !accepted.test(file.name)) {
        toast("Not an audio file", file.name);
        continue;
      }
      const url = URL.createObjectURL(file);
      const track = registerTrack({
        id: "local:" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        title: stripExtension(file.name),
        artist: "Local import",
        source: "local",
        audioUrl: url,
        duration: 0,
        sessionOnly: true
      });
      extraTracks.push(track);
      toast("Imported for this session", file.name + " · browser imports are not saved after refresh.");
    }
    if (fileInput) fileInput.value = "";
    renderAll();
    setView("library");
  }

  /* ---------------- overlays ---------------- */

  function openQueue() {
    renderQueue();
    modalOpen(queueDrawer);
  }

  function openExpanded() {
    renderPlayer();
    modalOpen(expandedDialog);
  }

  function buildParticles() {
    const box = $("#particles");
    if (!box) return;
    box.innerHTML = "";
    for (let index = 0; index < 18; index += 1) {
      const particle = document.createElement("span");
      particle.className = "particle";
      particle.style.left = 4 + Math.random() * 92 + "%";
      particle.style.bottom = 4 + Math.random() * 26 + "%";
      particle.style.animationDelay = Math.random() * 4.5 + "s";
      particle.style.animationDuration = 3.5 + Math.random() * 3.5 + "s";
      box.appendChild(particle);
    }
  }

  /* ---------------- render all ---------------- */

  function renderAll() {
    renderNav();
    renderSidebar();
    renderHome();
    renderSearch();
    renderLibrary();
    renderDownloads();
    renderPlayer();
    renderQueue();
    renderUpNext();
    renderSource();
    renderSleep();
  }

  /* ---------------- actions ---------------- */

  function runAction(button, event) {
    if (!button || button.disabled) return;
    return handleAction(button, event);
  }

  function handleAction(button) {
    const data = button.dataset;
    switch (data.action) {
      case "nav":
        setView(data.view || "home");
        break;
      case "play-demo": {
        const first = filteredDemos()[0] || demoMap.get(DEMOS[0].id);
        playTrack(first.id, "home");
        break;
      }
      case "scroll-loops": {
        const section = $("#loopsSection");
        if (section) section.scrollIntoView({ behavior: state.motion ? "smooth" : "auto", block: "start" });
        break;
      }
      case "play-track":
        playTrack(data.id, data.context || "home");
        break;
      case "play-playlist":
        playPlaylist(data.id);
        break;
      case "toggle-play":
        togglePlay();
        break;
      case "next":
        nextTrack(false);
        break;
      case "previous":
        previousTrack();
        break;
      case "shuffle":
        toggleShuffle();
        break;
      case "repeat":
        cycleRepeat();
        break;
      case "toggle-like":
        toggleLike(data.id || state.currentId);
        break;
      case "mood":
        setMood(data.mood);
        break;
      case "theme":
        setTheme(data.themeChoice);
        break;
      case "motion":
        toggleMotion();
        break;
      case "new-playlist":
        createPlaylistFlow();
        break;
      case "open-settings":
        openSettings();
        break;
      case "open-queue":
        openQueue();
        break;
      case "open-expanded":
        openExpanded();
        break;
      case "open-youtube":
        if (window.Native && typeof window.Native.openUrl === "function") window.Native.openUrl("https://www.youtube.com");
        else window.open("https://www.youtube.com", "_blank", "noopener");
        break;
      case "submit-search": {
        const form = $("#" + data.form);
        const input = form && form.querySelector("input");
        return runSearch(input ? input.value : "");
      }
      case "submit-prompt":
        submitPrompt();
        break;
      case "track-menu":
        openTrackMenu(data.id, button);
        break;
      case "download":
      case "download-demo":
        return downloadTrack(data.id);
      case "share":
        shareTrack(data.id);
        break;
      case "rename-track":
        renameTrack(data.id);
        break;
      case "play-next":
        playNext(data.id);
        break;
      case "add-to-playlist":
        openPicker(data.id);
        break;
      case "open-playlist":
        openPlaylist(data.id);
        break;
      case "close-playlist":
        state.activePlaylistId = null;
        renderLibrary();
        renderSidebar();
        break;
      case "rename-playlist":
        renamePlaylist(data.id);
        break;
      case "delete-playlist":
        deletePlaylistFlow(data.id);
        break;
      case "remove-from-playlist":
        removeFromPlaylist(data.playlist, data.id);
        break;
      case "picker-add":
        addToPlaylist(data.playlist, pickerTrackId);
        renderPicker();
        break;
      case "picker-new-playlist":
        pickerNewPlaylist();
        break;
      case "import":
        return importAudio();
      case "refresh-downloads":
        return refreshDownloads();
      case "remove-download":
        removeDownloadFlow(data.id);
        break;
      case "export-library":
        exportLibrary();
        break;
      case "test-piped":
        return testPiped();
      case "save-piped":
        savePiped();
        break;
      case "sleep":
        setSleep(Number(data.minutes) || 0);
        break;
      case "focus-sleep": {
        openQueue();
        setTimeout(() => {
          const section = $("#sleepSection");
          if (section) section.scrollIntoView({ behavior: state.motion ? "smooth" : "auto", block: "center" });
        }, 260);
        break;
      }
      case "queue-up":
        moveQueue(data.id, -1);
        break;
      case "queue-down":
        moveQueue(data.id, 1);
        break;
      case "queue-remove":
        removeQueue(data.id);
        break;
      case "close-fallback-sheet":
        if (fallbackSheet && fallbackSheet.open) fallbackSheet.close();
        break;
      default:
        break;
    }
  }

  /* ---------------- events ---------------- */

  function updateOffline() {
    const banner = $("#offlineBanner");
    const offline = navigator.onLine === false;
    if (banner) banner.hidden = !offline;
    renderSource();
  }

  function closeFallbackFor(root) {
    if (root === promptDialog) settlePrompt(null);
    if (root === confirmDialog) settleConfirm(false);
    if (!sdkHas(root.localName)) modalClose(root);
  }

  function wireEvents() {
    document.addEventListener("click", (event) => {
      const closer = event.target.closest("[data-fallback-close]");
      if (closer) {
        const root = closer.closest("ui-dialog, ui-alert-dialog, ui-drawer");
        if (root) closeFallbackFor(root);
        return;
      }
      const actionButton = event.target.closest("[data-action]");
      if (actionButton) {
        const component = actionButton.closest("ui-button, ui-toggle, ui-switch, ui-menu-trigger");
        if (component && sdkHas(component.localName)) return;
        if (!actionButton.disabled) runAction(actionButton, event);
        return;
      }
      const openRoot = event.target.closest(".fallback-open");
      if (openRoot && event.target === openRoot) {
        closeFallbackFor(openRoot);
        return;
      }
      const row = event.target.closest(".song-row");
      if (row && !event.target.closest("button, a, input, select, textarea, ui-menu")) {
        playTrack(row.dataset.id, row.dataset.context || "home");
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (event.key === "Escape") {
        if (fallbackSheet && fallbackSheet.open) {
          fallbackSheet.close();
          return;
        }
        if (!isDialogSdk()) {
          const open = [settingsDialog, queueDrawer, expandedDialog, promptDialog, confirmDialog, playlistPickerDialog].find(
            (root) => root && root.classList.contains("fallback-open")
          );
          if (open) {
            closeFallbackFor(open);
            event.preventDefault();
            return;
          }
        }
        return;
      }
      if (typing) return;
      if (target && target.closest && target.closest("ui-dialog-content, ui-alert-dialog-content, ui-drawer-content, ui-menu-content")) return;
      if (event.code === "Space" && !(target && target.closest && target.closest("button, a, ui-switch, ui-toggle, ui-slider, ui-menu"))) {
        event.preventDefault();
        togglePlay();
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        const input = state.view === "search" ? $("#searchInput") : $("#topSearchInput");
        if (input) input.focus();
        return;
      }
      if (event.altKey && event.key === "ArrowRight") {
        event.preventDefault();
        nextTrack(false);
      } else if (event.altKey && event.key === "ArrowLeft") {
        event.preventDefault();
        previousTrack();
      }
    });

    const topForm = $("#topSearchForm");
    if (topForm) {
      topForm.addEventListener("submit", (event) => {
        event.preventDefault();
        runSearch($("#topSearchInput") ? $("#topSearchInput").value : "");
      });
    }
    const searchForm = $("#searchForm");
    if (searchForm) {
      searchForm.addEventListener("submit", (event) => {
        event.preventDefault();
        runSearch($("#searchInput") ? $("#searchInput").value : "");
      });
    }
    const libraryFilter = $("#libraryFilter");
    if (libraryFilter) {
      libraryFilter.addEventListener("input", () => {
        if (sdkHas("ui-input")) return;
        state.filter = libraryFilter.value;
        renderLibrary();
      });
      libraryFilter.closest("ui-input").addEventListener("valuechange", (event) => {
        state.filter = String(event.detail.value || "");
        renderLibrary();
      });
    }
    const pipedForm = $("#pipedForm");
    if (pipedForm) {
      pipedForm.addEventListener("submit", (event) => {
        event.preventDefault();
        savePiped();
      });
    }

    [playerSeek, expandedSeek].forEach((slider) => {
      if (!slider) return;
      slider.addEventListener("valuechange", (event) => {
        if (!event.detail) return;
        const value = Number(event.detail && event.detail.value);
        if (!isFinite(value)) return;
        if (event.detail.source === "agent" || event.detail.reason === "imperative") seekTo(value);
        else {
          seekPreview = value;
          updateProgressUI();
        }
      });
      slider.addEventListener("valuecommit", (event) => {
        seekPreview = null;
        const value = Number(event.detail && event.detail.value);
        if (isFinite(value)) seekTo(value);
      });
    });
    [playerSeekFallback, expandedSeekFallback].forEach((input) => {
      if (!input) return;
      input.addEventListener("input", () => seekTo(input.value));
    });

    const moodRail = $("#moodRail");
    if (moodRail) {
      moodRail.addEventListener("valuechange", (event) => {
        const value = event.detail && event.detail.value;
        if (Array.isArray(value) && value.length) setMood(value[0]);
      });
    }
    if (themeGroup) {
      themeGroup.addEventListener("valuechange", (event) => {
        const value = event.detail && event.detail.value;
        if (Array.isArray(value) && value.length) setTheme(value[0]);
      });
    }
    if (motionToggle) motionToggle.addEventListener("checkedchange", (event) => setMotion(!!event.detail.value));

    const promptForm = $("#promptForm");
    if (promptForm) {
      promptForm.addEventListener("submit", (event) => {
        event.preventDefault();
        submitPrompt();
      });
      promptForm.querySelector("ui-input").addEventListener("valuechange", () => {
        setFieldError($("#promptField"), "promptError", "");
      });
      $("#promptInput").addEventListener("input", () => {
        if (!sdkHas("ui-input")) setFieldError($("#promptField"), "promptError", "");
      });
    }
    const pipedInput = $("#pipedUrlInput");
    if (pipedInput) pipedInput.closest("ui-input").addEventListener("valuechange", () => {
      setFieldError(pipedInput.closest("ui-field"), "pipedError", "");
    });
    if (pipedInput) pipedInput.addEventListener("input", () => {
      if (!sdkHas("ui-input")) setFieldError(pipedInput.closest("ui-field"), "pipedError", "");
    });
    if (promptDialog) {
      promptDialog.addEventListener("openchange", (event) => {
        if (!event.detail.value) settlePrompt(null);
      });
    }
    const confirmButton = $("#confirmButton");
    if (confirmButton) {
      confirmButton.addEventListener("click", () => {
        if (!isDialogSdk()) {
          settleConfirm(true);
          modalClose(confirmDialog);
        }
      });
    }
    if (confirmDialog) {
      confirmDialog.addEventListener("openchange", (event) => {
        if (!event.detail.value) settleConfirm(event.detail.returnValue === "confirm");
      });
    }

    if (fallbackSheet) {
      fallbackSheet.addEventListener("click", (event) => {
        if (event.target === fallbackSheet) {
          fallbackSheet.close();
          return;
        }
        const item = event.target.closest("[data-menu-value]");
        if (item) {
          const value = item.dataset.menuValue;
          fallbackSheet.close();
          handleTrackMenuValue(value);
        }
      });
    }

    if (fileInput) {
      fileInput.addEventListener("change", () => handleFiles(fileInput.files));
    }

    if (audio) {
      audio.addEventListener("play", () => {
        if (isNative()) return;
        state.isPlaying = true;
        state.loading = false;
        renderPlayState();
      });
      audio.addEventListener("loadedmetadata", () => {
        if (isNative() || !isFinite(audio.duration) || audio.duration <= 0) return;
        const track = getTrack(state.currentId);
        if (track) track.duration = audio.duration;
        state.duration = audio.duration;
        updateProgressUI();
      });
      audio.addEventListener("pause", () => {
        if (isNative() || audio.ended) return;
        state.isPlaying = false;
        renderPlayState();
      });
      audio.addEventListener("timeupdate", () => {
        if (isNative()) return;
        state.currentTime = audio.currentTime || 0;
        if (isFinite(audio.duration) && audio.duration > 0) state.duration = audio.duration;
        updateProgressUI();
      });
      audio.addEventListener("ended", () => {
        if (isNative()) return;
        nextTrack(true);
      });
      audio.addEventListener("error", () => {
        if (isNative() || !audio.src) return;
        state.isPlaying = false;
        state.loading = false;
        renderPlayState();
        toast("Audio could not load", "Try another result or check that the local file exists.");
      });
    }

    if (!isNative() && "mediaSession" in navigator) {
      try {
        navigator.mediaSession.setActionHandler("play", () => { if (!state.isPlaying) togglePlay(); });
        navigator.mediaSession.setActionHandler("pause", () => pausePlayback());
        navigator.mediaSession.setActionHandler("previoustrack", () => previousTrack());
        navigator.mediaSession.setActionHandler("nexttrack", () => nextTrack(false));
        navigator.mediaSession.setActionHandler("seekto", (details) => {
          if (details && isFinite(details.seekTime)) seekTo(details.seekTime);
        });
      } catch (error) {
        /* unsupported */
      }
    }

    window.addEventListener("online", updateOffline);
    window.addEventListener("offline", updateOffline);
    window.addEventListener("pagehide", saveState);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && isNative()) hydrateNativeState();
    });
    if (window.customElements && window.customElements.whenDefined) {
      window.customElements.whenDefined("ui-slider").then(() => {
        [playerSeek, expandedSeek].forEach((slider) => { if (slider) slider.format = formatTime; });
      });
    }
  }

  async function refreshNativeState() {
    if (!isNative() || nativePolling) return;
    nativePolling = true;
    const token = nativeChangeToken;
    try {
      const response = await nativeRequest("state", {}, 10000);
      if (token === nativeChangeToken) applyNativeState(response);
    } catch (error) {
      /* native may not have state yet */
    } finally {
      nativePolling = false;
    }
  }

  async function pollDownloads() {
    if (!isNative() || downloadPolling) return;
    downloadPolling = true;
    const token = downloadChangeToken;
    try {
      const response = await nativeRequest("downloads", {}, 10000);
      if (token === downloadChangeToken) applyDownloads(response);
    } catch (error) {
      /* no downloads yet */
    } finally {
      downloadPolling = false;
    }
  }

  async function hydrateNativeState() {
    await Promise.all([refreshNativeState(), pollDownloads()]);
    renderSource();
  }

  function init() {
    installNativeBridge();
    document.documentElement.setAttribute("data-theme", state.theme);
    document.documentElement.setAttribute("data-motion", state.motion ? "on" : "off");
    applyCustomTitles();
    if (state.currentId && !getTrack(state.currentId)) state.currentId = state.queue.find((id) => getTrack(id)) || "";
    state.queue = state.queue.filter((id) => getTrack(id));
    ensureQueue();
    buildParticles();
    bindSdkEvents(document);
    wireEvents();
    renderAll();
    setView("home");
    updateOffline();
    if (isNative()) {
      hydrateNativeState();
      setInterval(() => { if (!document.hidden) refreshNativeState(); }, 1000);
      setInterval(() => {
        if (!document.hidden && (state.view === "downloads" || Object.values(state.downloads).some((item) => !["complete", "failed"].includes(item.status)))) pollDownloads();
      }, 5000);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

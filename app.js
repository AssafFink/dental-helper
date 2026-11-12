'use strict';

// Sounds are scheduled on the Web Audio clock, so timing stays exact even
// when the browser slows down JavaScript timers.
const REPEAT_SECONDS = 3.2;   // 3 seconds + 200 milliseconds
const ONCE_SECONDS = 60;      // one minute
const LOOKAHEAD = 1.0;        // schedule sounds this far ahead (seconds)
const TICK_MS = 200;          // how often the scheduler runs

const AudioCtx = window.AudioContext || window.webkitAudioContext;
let ctx = null;
let buffer = null;        // magic.wav – the 3.2-second button
let minuteBuffer = null;  // minute.mp3 – the one-minute button
let loading = null;

// iOS: let sound play even when the ring/silent switch is on silent.
try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}

function ensureAudio() {
  if (!ctx) ctx = new AudioCtx();
  if (ctx.state === 'suspended') ctx.resume();
  if (!loading) {
    const load = url => fetch(url)
      .then(r => r.arrayBuffer())
      .then(data => new Promise((resolve, reject) => ctx.decodeAudioData(data, resolve, reject)));
    loading = Promise.all([load('magic.wav'), load('minute.mp3')])
      .then(([a, b]) => { buffer = a; minuteBuffer = b; });
  }
  return loading;
}

function playAt(when, buf = buffer) {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(when);
  return src;
}

// ---------- Keep screen awake while a timer runs ----------
let wakeLock = null;
async function updateWakeLock() {
  const needed = repeat.running || once.running;
  try {
    if (needed && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!needed && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (e) { /* not supported or not allowed */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (ctx && ctx.state === 'suspended') ctx.resume();
    updateWakeLock();
  }
});

function flash(el) {
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

// ---------- Button 1: sound every 3.2 seconds until pressed again ----------
const repeatBtn = document.getElementById('repeatBtn');
const repeatTitle = document.getElementById('repeatTitle');
const repeatSub = document.getElementById('repeatSub');

const repeat = {
  running: false,
  startTime: 0,
  nextIndex: 1,
  sources: [],
  timer: null,
  uiTimer: null,
  count: 0,
};

function repeatSchedule() {
  const horizon = ctx.currentTime + LOOKAHEAD;
  while (repeat.startTime + repeat.nextIndex * REPEAT_SECONDS < horizon) {
    const when = repeat.startTime + repeat.nextIndex * REPEAT_SECONDS;
    const src = playAt(when);
    repeat.sources.push(src);
    src.onended = () => {
      repeat.sources = repeat.sources.filter(s => s !== src);
    };
    const delay = Math.max(0, (when - ctx.currentTime) * 1000);
    setTimeout(() => {
      if (!repeat.running) return;
      repeat.count++;
      flash(repeatBtn);
    }, delay);
    repeat.nextIndex++;
  }
}

function repeatUi() {
  if (!repeat.running) return;
  const elapsed = ctx.currentTime - repeat.startTime;
  const toNext = REPEAT_SECONDS - (elapsed % REPEAT_SECONDS);
  repeatSub.textContent = `הצליל הבא בעוד ${toNext.toFixed(1)} שנ׳ · לחצו לעצירה`;
}

async function startRepeat() {
  await ensureAudio();
  repeat.running = true;
  repeat.startTime = ctx.currentTime + 0.05;
  repeat.nextIndex = 1; // first sound 3.2 seconds after pressing
  repeat.count = 0;
  repeatSchedule();
  repeat.timer = setInterval(repeatSchedule, TICK_MS);
  repeat.uiTimer = setInterval(repeatUi, 100);
  repeatBtn.setAttribute('aria-pressed', 'true');
  repeatTitle.textContent = 'עצור';
  repeatUi();
  updateWakeLock();
}

function stopRepeat() {
  repeat.running = false;
  clearInterval(repeat.timer);
  clearInterval(repeat.uiTimer);
  // Cancel sounds that were scheduled but have not started yet.
  const now = ctx ? ctx.currentTime : 0;
  repeat.sources.forEach(s => { try { s.stop(Math.max(now, 0)); } catch (e) {} });
  repeat.sources = [];
  repeatBtn.setAttribute('aria-pressed', 'false');
  repeatTitle.textContent = 'התחל צליל כל 3.2 שניות';
  repeatSub.textContent = 'לחיצה נוספת עוצרת';
  updateWakeLock();
}

repeatBtn.addEventListener('click', () => {
  if (repeat.running) stopRepeat(); else startRepeat();
});

// ---------- Button 2: one sound after one minute ----------
const minuteBtn = document.getElementById('minuteBtn');
const minuteTitle = document.getElementById('minuteTitle');
const minuteSub = document.getElementById('minuteSub');

const once = { running: false, endTime: 0, source: null, uiTimer: null };

function onceUi() {
  if (!once.running) return;
  const left = once.endTime - ctx.currentTime;
  if (left <= 0) {
    minuteTitle.textContent = 'הצליל מתנגן';
    minuteSub.textContent = 'לחצו לעצירה';
    return;
  }
  const s = Math.ceil(left);
  minuteSub.textContent = `נותרו ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · לחצו לביטול`;
}

function resetOnce() {
  once.running = false;
  clearInterval(once.uiTimer);
  once.source = null;
  minuteBtn.setAttribute('aria-pressed', 'false');
  minuteTitle.textContent = 'צליל אחרי דקה';
  minuteSub.textContent = 'צליל אחד בלבד';
  updateWakeLock();
}

async function startOnce() {
  await ensureAudio();
  once.running = true;
  once.endTime = ctx.currentTime + ONCE_SECONDS;
  const src = playAt(once.endTime, minuteBuffer);
  once.source = src;
  setTimeout(() => {
    if (once.source === src) flash(minuteBtn);
  }, ONCE_SECONDS * 1000);
  // The timer ends when the sound finishes playing (or is stopped).
  src.onended = () => {
    if (once.source === src) resetOnce();
  };
  once.uiTimer = setInterval(onceUi, 200);
  minuteBtn.setAttribute('aria-pressed', 'true');
  minuteTitle.textContent = 'הטיימר פועל';
  onceUi();
  updateWakeLock();
}

function cancelOnce() {
  const src = once.source;
  once.source = null;
  if (src) { try { src.stop(); } catch (e) {} }
  resetOnce();
}

minuteBtn.addEventListener('click', () => {
  if (once.running) cancelOnce(); else startOnce();
});

// ---------- PWA: offline support ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

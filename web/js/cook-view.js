// The Cook screen: a full-page sheet over the app with "Before you start",
// ingredients and the steps, scaled to the chosen servings. Tap a line to
// tick it off; steps with a waiting time get a timer. The screen stays on
// while it's open, and the phone's Back button closes it.
import { scaleAmount, splitAmounts } from './cook.js';
import { icon } from './icons.js';
import * as storage from './storage.js';
import { escapeHtml as h } from './util.js';

export class NoStepsError extends Error {}

export function createCookView({ root, timersEl, toast }) {
  let current = null; // { recipe, servings, load, cook, error, progress }
  let wakeLock = null;
  const timers = []; // { id, label, endsAt, done }
  let ticker = null;
  let audio = null;

  const factor = () => (current.recipe.servings && current.servings ? current.servings / current.recipe.servings : 1);
  const withAmounts = (text) => splitAmounts(text)
    .map((p) => (p.amount != null ? `<strong class="amt">${h(scaleAmount(p.amount, factor()))}</strong>` : h(p.text)))
    .join('');
  const original = (text) => `<a class="ext" href="${h(current.recipe.url)}" target="_blank" rel="noopener">${text}${icon('external')}</a>`;

  // ------------------------------------------------------------ render

  function render() {
    const { recipe, cook, error } = current;
    const head = `
      <div class="cook-head">
        <div>
          <h2 id="cook-title">${h(recipe.name)}</h2>
          <div class="muted small-text">${original(h(recipe.site || 'Original recipe'))}</div>
        </div>
        <button class="cook-close" data-cook="close" aria-label="Close">${icon('x')}</button>
      </div>`;
    if (!cook) {
      root.innerHTML = `<div class="cook-sheet">${head}
        ${error
          ? `<div class="status error">${h(error)}</div><div class="actions">${current.noSteps ? '' : '<button data-cook="retry">Try again</button>'}${original('Open the original recipe')}</div>`
          : '<div class="status busy">Writing easy steps…</div>'}
      </div>`;
      return;
    }
    const { prep, steps } = current.progress;
    const next = cook.steps.findIndex((_, i) => !steps.includes(i));
    const servings = recipe.servings
      ? `<div class="cook-servings"><span class="muted">For</span>
          <button class="small" data-cook="servings" data-delta="-1" aria-label="Fewer">−</button>
          <strong>${current.servings}</strong>
          <button class="small" data-cook="servings" data-delta="1" aria-label="More">+</button>
          <span class="muted">${current.servings === 1 ? 'person' : 'people'}${factor() !== 1 ? ` · recipe makes ${h(recipe.servings)}` : ''}</span></div>`
      : recipe.yieldText ? `<div class="cook-servings muted">Makes ${h(recipe.yieldText)}</div>` : '';
    root.innerHTML = `<div class="cook-sheet">${head}${servings}
      ${cook.warnings.map((w) => `<p class="notice">${h(w)}</p>`).join('')}
      ${cook.prep.length ? `<h3>Before you start</h3>
        <ul class="cook-list">${cook.prep.map((p, i) => `<li class="cook-check ${prep.includes(i) ? 'done' : ''}" data-cook="prep" data-i="${i}">
          <span class="tick">${icon('check')}</span><span>${withAmounts(p)}</span></li>`).join('')}</ul>` : ''}
      <details class="cook-ingredients"><summary>Ingredients${factor() !== 1 ? ` for ${current.servings}` : ''}</summary>
        <ul>${recipe.ingredients.map((i) => `<li>${h(scaleAmount(i, factor()))}</li>`).join('')}</ul></details>
      <h3>Steps</h3>
      <ol class="cook-list cook-steps">${cook.steps.map((s, i) => `<li class="cook-step ${steps.includes(i) ? 'done' : ''} ${i === next ? 'current' : ''}" data-cook="step" data-i="${i}">
          <span class="num">${steps.includes(i) ? icon('check') : i + 1}</span>
          <div class="txt">${withAmounts(s.text)}
            ${s.timerMinutes ? `<button class="small timer-btn" data-cook="timer" data-i="${i}">${icon('clock')} ${formatMinutes(s.timerMinutes)}</button>` : ''}</div>
        </li>`).join('')}</ol>
      <div class="cook-foot">
        <button class="small" data-cook="reset">Start cook over</button>
        <button class="small" data-cook="regenerate">${icon('sparkle')} Regenerate steps</button>
      </div>
    </div>`;
  }

  // fresh: write new steps instead of using saved ones.
  async function load({ fresh = false } = {}) {
    current.cook = null;
    current.error = null;
    render();
    const target = current;
    try {
      const cook = await target.load({ fresh });
      if (current !== target) return;
      current.cook = cook;
    } catch (err) {
      if (current !== target) return;
      current.noSteps = err instanceof NoStepsError;
      current.error = current.noSteps
        ? "This recipe page doesn't share its steps in a way DinnerCart can read."
        : `Couldn't write the steps: ${err.message}`;
    }
    render();
  }

  // ------------------------------------------------------------ open / close

  function open({ recipe, servings, load: loader }) {
    current = { recipe, servings: servings || recipe.servings || null, load: loader, cook: null, error: null, progress: storage.loadProgress(recipe.url) };
    root.hidden = false;
    document.body.classList.add('cook-open');
    if (!history.state?.cook) history.pushState({ cook: true }, '');
    keepAwake();
    load();
    root.querySelector('.cook-close')?.focus();
  }

  function shut() {
    current = null;
    root.hidden = true;
    root.innerHTML = '';
    document.body.classList.remove('cook-open');
    wakeLock?.release().catch(() => {});
    wakeLock = null;
  }

  function close() {
    if (history.state?.cook) history.back(); // popstate does the rest
    else shut();
  }

  window.addEventListener('popstate', () => { if (current && !history.state?.cook) shut(); });

  async function keepAwake() {
    try {
      if (current && !wakeLock && navigator.wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch { /* not allowed (e.g. battery saver); the steps still work */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

  // ------------------------------------------------------------ timers

  function startTimer(step) {
    primeAudio();
    timers.push({ id: Math.random().toString(36).slice(2), label: step.timerLabel || 'Timer', endsAt: Date.now() + step.timerMinutes * 60_000, done: false });
    if (!ticker) ticker = setInterval(renderTimers, 1000);
    renderTimers();
  }

  function renderTimers() {
    const now = Date.now();
    for (const t of timers) {
      if (!t.done && t.endsAt <= now) {
        t.done = true;
        ring();
        toast(`Timer done: ${t.label}`);
      }
    }
    timersEl.hidden = !timers.length;
    timersEl.innerHTML = timers.map((t) => `<div class="timer-chip ${t.done ? 'done' : ''}">
      ${icon('clock')}<span class="label">${h(t.label)}</span><strong>${t.done ? 'Done' : clock(t.endsAt - now)}</strong>
      <button class="link" data-timer="${t.id}" aria-label="${t.done ? 'Dismiss' : 'Stop'} timer">${icon('x')}</button></div>`).join('');
    if (!timers.length) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  function primeAudio() {
    try {
      audio ||= new (window.AudioContext || window.webkitAudioContext)();
      audio.resume();
    } catch { audio = null; }
  }

  function ring() {
    navigator.vibrate?.([300, 150, 300, 150, 300]);
    if (!audio) return;
    for (let i = 0; i < 3; i++) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      const at = audio.currentTime + i * 0.4;
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.3, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + 0.32);
    }
  }

  timersEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-timer]');
    if (!btn) return;
    timers.splice(timers.findIndex((t) => t.id === btn.dataset.timer), 1);
    renderTimers();
  });

  // ------------------------------------------------------------ taps

  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-cook]');
    if (!el || !current || e.target.closest('a')) return;
    const i = Number(el.dataset.i);
    const { progress } = current;
    const toggle = (list) => { const at = list.indexOf(i); if (at >= 0) list.splice(at, 1); else list.push(i); };
    switch (el.dataset.cook) {
      case 'close': return close();
      case 'retry': return load();
      case 'servings':
        current.servings = Math.max(1, Math.min(40, current.servings + Number(el.dataset.delta)));
        return render();
      case 'timer':
        startTimer(current.cook.steps[i]);
        return toast(`Timer started: ${formatMinutes(current.cook.steps[i].timerMinutes)}`);
      case 'prep': toggle(progress.prep); break;
      case 'step': toggle(progress.steps); break;
      case 'regenerate':
        if (!confirm('Write the steps again with Gemini? The new steps replace these.')) return;
        current.progress = { prep: [], steps: [] };
        storage.saveProgress(current.recipe.url, current.progress);
        return load({ fresh: true });
      case 'reset':
        if (!confirm('Untick everything and start the cook over?')) return;
        progress.prep = [];
        progress.steps = [];
        break;
      default: return;
    }
    storage.saveProgress(current.recipe.url, progress);
    render();
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && current) close(); });

  return { open, close, get isOpen() { return Boolean(current); } };
}

function formatMinutes(min) {
  if (min < 1) return `${Math.round(min * 60)} sec`;
  if (min < 60) return `${Math.round(min)} min`;
  const hrs = Math.floor(min / 60);
  const rest = Math.round(min % 60);
  return rest ? `${hrs} hr ${rest} min` : `${hrs} hr`;
}

function clock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hrs = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return hrs ? `${hrs}:${String(min).padStart(2, '0')}:${sec}` : `${min}:${sec}`;
}

// DinnerCart UI controller. Plain DOM; views are re-rendered from `state`.
import { generateCook } from './cook.js';
import { NoStepsError, createCookView } from './cook-view.js';
import { LIGHT_MODEL, createGemini, createModelSwitch } from './gemini.js';
import { lastDirectProblem, lastSearchRoute, productSearcher, resetDirectSearch } from './kroger.js';
import { createRelay } from './relay.js';
import { findRecipes, scaleFor } from './recipes.js';
import { MAX_CANDIDATES, estimateTotal, heuristicPick, resolveIngredients, setPackages } from './resolver.js';
import * as storage from './storage.js';
import { summarizeNeeds } from './units.js';
import { escapeHtml as h, money } from './util.js';
import { IDEAS, generateIdeas, rotatePlaceholder, todayKey } from './suggestions.js';
import { hydrateIcons, icon } from './icons.js';
import { groupByRecency } from './library.js';
import { VERSION } from './version.js';
import { DEFAULT_RELAY_URL } from './config.js';
import { makeSetupLink, readSetupLink } from './setup-link.js';

const $ = (sel) => document.querySelector(sel);
const VIEWS = ['find', 'cart', 'recipes', 'settings'];
// These open the Fred Meyer app on phones that have it installed. The Kroger
// API can't read orders, so "orders" is Fred Meyer's purchases page (newest first).
const FM_CART_URL = 'https://www.fredmeyer.com/cart';
const FM_ORDERS_URL = 'https://www.fredmeyer.com/mypurchases';
const extLink = (url, text) => `<a class="ext" href="${url}" target="_blank" rel="noopener">${text}${icon('external')}</a>`;
const fmCartLink = (text = 'Fred Meyer cart') => extLink(FM_CART_URL, text);
const fmLinks = () => `<div class="fm-links">${fmCartLink()}${extLink(FM_ORDERS_URL, 'Fred Meyer orders')}</div>`;

let settings = storage.loadSettings();
let prefs = storage.loadPrefs();
const state = { criteria: null, results: null, selected: [], cart: null, ...storage.loadState() };
let library = null;
let busy = false;

const persist = () => storage.saveState({ criteria: state.criteria, results: state.results, selected: state.selected, cart: state.cart });
// The deploy builds in this repo's relay URL; Settings can override it.
const relayUrl = () => settings.relayUrl || DEFAULT_RELAY_URL;
const configured = () => Boolean(relayUrl() && settings.relayPassword && settings.geminiKey);
const relay = () => createRelay({ url: relayUrl(), password: settings.relayPassword });
// Starts on the strong model every page load; drops to the light one when
// the strong model is rate limited, or when switched in Settings.
const modelSwitch = createModelSwitch({
  onChange: (_tier, _model, reason) => {
    renderModelToggle();
    if (reason === 'limit') toast('Gemini limit reached. Switched to the Light model until you reload.');
  },
});
function renderModelToggle() {
  document.querySelectorAll('[name=modelTier]').forEach((r) => { r.checked = r.value === modelSwitch.tier; });
}
const gemini = () => createGemini({ apiKey: settings.geminiKey, model: modelSwitch });

// ---------------------------------------------------------------- helpers

function setStatus(el, text, kind = 'busy') {
  el.hidden = !text;
  el.className = `status ${kind}`;
  el.textContent = text || '';
}

let toastTimer;
function toast(text, kind = '') {
  const el = $('#toast');
  el.textContent = text;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 7000 : 3500);
}

// Resolves true if fn finished, false if it failed or something else was running.
async function guarded(statusEl, fn) {
  if (busy) {
    syncButtons();
    return false;
  }
  busy = true;
  document.body.classList.add('busy');
  try {
    await fn();
    return true;
  } catch (err) {
    console.error(err);
    if (statusEl) setStatus(statusEl, err.message, 'error');
    else toast(err.message, 'error');
    return false;
  } finally {
    busy = false;
    document.body.classList.remove('busy');
    syncButtons();
  }
}

// ---------------------------------------------------------------- button states

// Green (go) and red (keep) buttons go solid the moment they're tapped.
// syncButtons() then settles the ones backed by state to what's true (picked,
// saved, steps written, list matched or sent), so a cancel or a failure turns
// them back to an outline. Config buttons settle where they're handled.
document.addEventListener('click', (e) => {
  const b = e.target.closest('button.go, button.keep');
  if (b && !b.disabled) b.classList.add('on');
}, true);

// Lets a button that just went solid paint before a confirm() blocks the page.
const painted = () => new Promise((r) => setTimeout(r, 60));

let searchingMode = null; // the search running now, if any

function syncButtons() {
  markSearchMethod(searchingMode || state.results?.mode);
  document.querySelectorAll('button[data-url]').forEach((b) => {
    const { action, url } = b.dataset;
    if (action === 'toggle-pick' && b.classList.contains('go')) b.classList.toggle('on', isPicked(url));
    if (action === 'save') b.classList.toggle('on', Boolean(savedEntry(url)));
    if (action === 'cook') b.classList.toggle('on', hasCook(url));
  });
  document.querySelectorAll('[data-action="lib-delete"]').forEach((b) => b.classList.remove('on'));
  $('[data-action="build-cart"]')?.classList.toggle('on', listMatchesPicks());
  $('[data-action="send-cart"]')?.classList.toggle('on', listSent());
}

function allKnownRecipes() {
  const map = new Map();
  for (const r of state.results?.ranked || []) map.set(r.recipe.url, r.recipe);
  for (const r of library || []) map.set(r.url, r);
  for (const s of state.selected) map.set(s.recipe.url, s.recipe);
  return map;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isPicked = (url) => state.selected.some((s) => s.recipe.url === url);
const savedEntry = (url) => (library || []).find((r) => r.url === url);
const pickSignature = () => state.selected.map((s) => `${s.recipe.url}@${s.servings}`).join('|');

// What "Add to Fred Meyer cart" sends: one line per product, packages summed.
function cartLines(cart) {
  const byUpc = new Map();
  for (const item of cart.items) {
    const p = item.candidates[item.choice];
    if (item.removed || !p || item.packages < 1) continue;
    byUpc.set(p.upc, (byUpc.get(p.upc) || 0) + item.packages);
  }
  return [...byUpc].map(([upc, quantity]) => ({ upc, quantity }));
}
const linesSignature = (cart) => cartLines(cart).map((l) => `${l.upc}x${l.quantity}`).join('|');
const listMatchesPicks = () => Boolean(state.cart) && state.cart.signature === pickSignature();
// Sent, and unchanged since (older carts didn't record what was sent).
const listSent = () => Boolean(state.cart?.sentAt) && (state.cart.sentSignature ?? linesSignature(state.cart)) === linesSignature(state.cart);

// ---------------------------------------------------------------- routing

function route() {
  const hash = location.hash.slice(1) === 'library' ? 'recipes' : location.hash.slice(1); // old links
  const view = VIEWS.includes(hash) ? hash : configured() ? 'find' : 'settings';
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === view));
  if (view === 'find') renderResults();
  if (view === 'cart') renderCart();
  if (view === 'recipes') loadLibrary();
  if (view === 'settings') renderSettings();
  renderTray(view);
}

function renderTray(view = location.hash.slice(1)) {
  const n = state.selected.length;
  const badge = $('#pick-count');
  badge.hidden = !n;
  badge.textContent = n;
  const tray = $('#tray');
  tray.hidden = !n || view === 'cart' || view === 'settings';
  tray.textContent = `${plural(n, 'recipe')} picked · Review ingredients →`;
}

// ---------------------------------------------------------------- recipe cards

// Solid Cook = steps already written (saved with the recipe or on this phone).
const hasCook = (url) => Boolean(savedEntry(url)?.cook || storage.loadCook(url));

function recipeCard(recipe, { reason, libraryId } = {}) {
  const picked = isPicked(recipe.url);
  const saved = savedEntry(recipe.url);
  const meta = [
    recipe.site && `<span>${h(recipe.site)}</span>`,
    `<span>${icon('clock')} ${recipe.totalMinutes ? `${recipe.totalMinutes} min` : 'time ?'}</span>`,
    `<span>${icon('people')} ${recipe.servings ? `serves ${h(recipe.servings)}` : 'servings ?'}</span>`,
    recipe.rating && `<span>${icon('star', { filled: true })} ${h(recipe.rating.value)}${recipe.rating.count ? ` (${h(recipe.rating.count)})` : ''}</span>`,
    recipe.nutrition?.caloriesNumber && `<span>${icon('flame')} ${h(recipe.nutrition.caloriesNumber)} cal</span>`,
  ].filter(Boolean).join('');
  return `
    <article class="card recipe ${picked ? 'selected' : ''}">
      <a class="photo" href="${h(recipe.url)}" target="_blank" rel="noopener" aria-label="Open the original recipe: ${h(recipe.name)}">
        ${recipe.image ? `<img src="${h(recipe.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="dcImageFallback(this)">` : `<div class="noimg">${icon('bowl')}</div>`}
        <span class="photo-go">${icon('external')}</span></a>
      <div class="body">
        <h3>${h(recipe.name)}</h3>
        <div class="meta">${meta}</div>
        ${reason ? `<div class="why">${h(reason)}</div>` : ''}
        <details><summary>${plural((recipe.ingredients || []).length, 'ingredient')}</summary>
          <ul>${(recipe.ingredients || []).map((i) => `<li>${h(i)}</li>`).join('')}</ul>
        </details>
        <div class="buttons">
          <button class="go ${picked ? 'on' : ''}" data-action="toggle-pick" data-url="${h(recipe.url)}">${picked ? `${icon('check')} Picked` : `${icon('cart')} Pick`}</button>
          ${libraryId
            ? `<button class="keep" data-action="lib-delete" data-id="${h(libraryId)}">${icon('trash')} Remove</button>`
            : `<button class="keep ${saved ? 'on' : ''}" data-action="save" data-url="${h(recipe.url)}" ${saved ? 'disabled' : ''}>${saved ? `${icon('book', { filled: true })} Saved` : `${icon('book')} Save`}</button>`}
          <button class="go ${hasCook(recipe.url) ? 'on' : ''}" data-action="cook" data-url="${h(recipe.url)}">${icon('pan')} Cook</button>
        </div>
      </div>
    </article>`;
}

function togglePick(url) {
  const i = state.selected.findIndex((s) => s.recipe.url === url);
  if (i >= 0) {
    state.selected.splice(i, 1);
  } else {
    const recipe = allKnownRecipes().get(url);
    if (!recipe) return;
    state.selected.push({ recipe, servings: Number(state.criteria?.servings) || prefs.servings || recipe.servings || storage.DEFAULT_SERVINGS });
  }
  persist();
  route();
}

// ---------------------------------------------------------------- find

function readCriteria(form) {
  const f = new FormData(form);
  const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  return {
    wants: String(f.get('wants') || '').trim(),
    maxMinutes: Number(f.get('maxMinutes')) || null,
    servings: Number(f.get('servings')) || null,
    easy: f.get('easy') === 'on',
  };
}

// Max time, servings and Easy start from the household defaults on every load,
// unless the user has already edited the form this visit.
let findFormTouched = false;
function applySearchDefaults() {
  if (findFormTouched) return;
  const form = $('#criteria');
  const time = form.elements.maxMinutes;
  time.value = prefs.maxMinutes ? String(prefs.maxMinutes) : '';
  if (time.selectedIndex < 0) time.value = String(storage.DEFAULT_MAX_MINUTES);
  form.elements.servings.value = prefs.servings || storage.DEFAULT_SERVINGS;
  form.elements.easy.checked = Boolean(prefs.easy);
  form.querySelector('.pill-toggle').title = `Up to ${easyLimits().maxIngredients} ingredients (not counting pantry staples) and ${easyLimits().maxSteps} steps`;
}

const easyLimits = () => ({
  maxIngredients: prefs.easyMaxIngredients || storage.DEFAULT_EASY_MAX_INGREDIENTS,
  maxSteps: prefs.easyMaxSteps || storage.DEFAULT_EASY_MAX_STEPS,
});

async function runSearch(event) {
  event.preventDefault();
  const status = $('#find-status');
  if (!configured()) {
    toast('Finish Config first (relay URL, password, Gemini key).', 'error');
    location.hash = 'settings';
    return syncButtons();
  }
  // Search, Suggest (more like your saved recipes) or New (unlike them).
  const mode = { 'suggest-btn': 'recommend', 'new-btn': 'new' }[event.submitter?.id] || 'find';
  const recommend = mode !== 'find';
  markSearchMethod(mode);
  // What to leave out, the pantry and the Easy limits come from Config.
  const criteria = {
    ...readCriteria(event.target),
    exclude: prefs.leaveOut || [],
    minRating: prefs.minRating ?? storage.DEFAULT_MIN_RATING,
    pantry: prefs.pantry || [],
    easyMaxIngredients: easyLimits().maxIngredients,
    easyMaxSteps: easyLimits().maxSteps,
  };
  if (!recommend && !criteria.wants) {
    setStatus(status, 'Tell me what sounds good, or try Suggest or New.', 'error');
    return syncButtons();
  }
  const buttons = [$('#search-btn'), $('#suggest-btn'), $('#new-btn')];
  await guarded(status, async () => {
    buttons.forEach((b) => { b.disabled = true; });
    searchingMode = mode;
    try {
      state.criteria = criteria;
      let liked;
      if (recommend) {
        if (!library) library = (await relay().library()).recipes;
        liked = library;
      }
      const results = await findRecipes({ gemini: gemini(), relay: relay(), criteria, liked, novel: mode === 'new', onProgress: (t) => setStatus(status, t) });
      state.results = { ...results, mode, basedOn: liked?.length || 0, minRating: criteria.minRating, at: Date.now() };
      persist();
      setStatus(status, '');
      renderResults();
    } finally {
      searchingMode = null;
      buttons.forEach((b) => { b.disabled = false; });
    }
  });
}

function resultsBasis(r) {
  if (r.mode === 'recommend') return r.basedOn ? `Based on ${plural(r.basedOn, 'saved recipe')} · ` : 'No saved recipes yet, so these are popular picks · ';
  if (r.mode === 'new') return r.basedOn ? `Unlike your ${plural(r.basedOn, 'saved recipe')} · ` : 'A mix of cuisines to start · ';
  return '';
}

// The method behind the results below shows solid.
function markSearchMethod(mode) {
  const ids = { find: 'search-btn', recommend: 'suggest-btn', new: 'new-btn' };
  for (const [m, id] of Object.entries(ids)) $(`#${id}`).classList.toggle('on', m === mode);
}

function renderResults() {
  const el = $('#results');
  const r = state.results;
  markSearchMethod(r?.mode);
  if (!r) {
    el.innerHTML = '';
    return;
  }
  const rejected = r.rejected || [];
  const failed = r.failed || [];
  el.innerHTML = `
    <div class="section-title">
      <h2>${r.ranked.length ? `${{ recommend: 'Suggested: ', new: 'New to you: ' }[r.mode] || ''}${plural(r.ranked.length, 'recipe')}` : 'No recipes matched'}</h2>
      <button class="small clear" data-action="clear-results">Clear results</button>
    </div>
    <p class="muted small-text">${resultsBasis(r)}Searched: ${r.queries.map(h).join(' · ')}${r.minRating ? ` · rated ${h(r.minRating)}★ and up` : ''}</p>
    <div class="grid">${r.ranked.map((x) => recipeCard(x.recipe, { reason: x.reason })).join('')}</div>
    ${rejected.length ? `<details class="card small-text"><summary>${rejected.length} filtered out</summary><ul>${rejected.map((x) =>
      `<li><a href="${h(x.recipe.url)}" target="_blank" rel="noopener">${h(x.recipe.name)}</a> — ${h(x.reason)}</li>`).join('')}</ul></details>` : ''}
    ${failed.length ? `<details class="card small-text"><summary>${plural(failed.length, 'page')} couldn't be read</summary><ul>${failed.map((x) =>
      `<li><a href="${h(x.failed)}" target="_blank" rel="noopener">${h(x.failed)}</a> — ${h(x.reason)}</li>`).join('')}</ul></details>` : ''}`;
}

// ---------------------------------------------------------------- cart

function renderCart() {
  const picked = $('#picked');
  const cart = state.cart;
  const storeName = prefs.store?.name;
  if (!state.selected.length && !cart) {
    picked.innerHTML = `<div class="card"><h2>Nothing picked yet</h2><p class="muted">Pick recipes from <a href="#find">Search</a> or <a href="#recipes">Save</a></p>${fmLinks()}</div>`;
    $('#cart').innerHTML = '';
    return;
  }
  picked.innerHTML = `
    <div class="card">
      <div class="section-title" style="margin-top:0"><h2>Picked recipes</h2><button class="small clear" data-action="clear-cart">Clear picks</button></div>
      ${state.selected.map((s) => `
        <div class="picked-row">
          <div class="name"><a href="${h(s.recipe.url)}" target="_blank" rel="noopener">${h(s.recipe.name)}</a>
            <div class="muted small-text">${h(s.recipe.site || '')}${s.recipe.servings ? ` · recipe makes ${h(s.recipe.servings)}` : ' · servings unknown, not scaled'}</div></div>
          <label class="small-text">serves <input type="number" min="1" max="40" value="${h(s.servings)}" data-action="servings" data-url="${h(s.recipe.url)}"></label>
          <button class="clear" data-action="toggle-pick" data-url="${h(s.recipe.url)}" aria-label="Remove">${icon('trash')}</button>
        </div>`).join('')}
      <div class="actions" style="margin-top:12px">
        <button class="go" data-action="build-cart" ${state.selected.length ? '' : 'disabled'}>${cart ? 'Rebuild' : 'Match'} ingredients${storeName ? ` at ${h(storeName)}` : ''}</button>
      </div>
      ${storeName ? '' : '<p class="notice" style="margin:12px 0 0">Choose your Fred Meyer store in <a href="#settings">Config</a> first.</p>'}
    </div>`;
  renderShoppingList();
}

function renderShoppingList() {
  const el = $('#cart');
  const cart = state.cart;
  // Servings edits only redraw from here.
  $('[data-action="build-cart"]')?.classList.toggle('on', listMatchesPicks());
  if (!cart) {
    el.innerHTML = '';
    return;
  }
  const active = cart.items.filter((i) => !i.removed);
  const removed = cart.items.filter((i) => i.removed);
  const sendable = active.filter((i) => i.candidates[i.choice] && i.packages > 0);
  const missing = active.filter((i) => !i.candidates[i.choice]);
  const unchanged = listSent() || !cart.sentAt;
  el.innerHTML = `
    ${cart.signature !== pickSignature() ? '<div class="notice">Your picks or servings changed since this list was built. Rebuild to update it.</div>' : ''}
    <div class="card">
      <div class="section-title" style="margin-top:0"><h2>Shopping list</h2><span class="muted small-text">${plural(active.length, 'item')}${missing.length ? ` · ${missing.length} need a product` : ''}</span></div>
      ${active.map(itemRow).join('') || '<p class="muted">Everything is covered by the pantry.</p>'}
    </div>
    ${cart.skipped.length ? `<div class="card"><h3>Not adding</h3><p class="muted small-text">Pantry staples, optional garnishes and water. Tap + to add one anyway.</p>
      <div class="chips">${cart.skipped.map((s, i) => `<span class="chip" title="${h(s.text)}">${h(s.name)} <span class="reason">${h(s.reason)}</span><button class="small link" data-action="add-skipped" data-idx="${i}" aria-label="Add">${icon('plus')}</button></span>`).join('')}</div></div>` : ''}
    ${removed.length ? `<div class="card"><h3>Removed</h3><div class="chips">${removed.map((i) => `<span class="chip">${h(i.name)}<button class="small link" data-action="restore-item" data-key="${h(i.key)}">undo</button></span>`).join('')}</div></div>` : ''}
    <div class="card sendbar">
      <div><strong>${plural(sendable.length, 'product')}</strong> · est. ${money(estimateTotal(sendable))}
        ${cart.sentAt ? `<div class="muted small-text">Sent ${new Date(cart.sentAt).toLocaleString()}${unchanged ? '' : ' · list changed since'}</div>` : ''}</div>
      <div class="sendbar-side">
        <div class="sendbar-actions">
          <button class="go ${listSent() ? 'on' : ''}" data-action="send-cart" ${sendable.length ? '' : 'disabled'}>${cart.sentAt ? 'Send again' : 'Add to Fred Meyer cart'}</button>
          <button class="clear" data-action="clear-list">Clear list</button>
        </div>
        ${fmLinks()}
      </div>
    </div>`;
}

function itemRow(item) {
  const p = item.candidates[item.choice];
  const options = item.candidates.map((c, i) => `<option value="${i}" ${i === item.choice ? 'selected' : ''}>${h(c.description)}${c.size ? ` · ${h(c.size)}` : ''}${c.price ? ` · ${money(c.promoPrice || c.price)}` : ''}${c.inStock === false ? ' · out of stock' : ''}</option>`).join('');
  const lines = item.needs.map((n) => `<li>${h(n.text)} <span class="muted">(${h(n.recipe)})</span></li>`).join('');
  return `
    <div class="item ${p ? '' : 'nomatch'}" data-key="${h(item.key)}">
      ${p?.image ? `<img src="${h(p.image)}" alt="" loading="lazy">` : `<div class="noimg">${icon(p ? 'basket' : 'question')}</div>`}
      <div>
        <div class="need"><strong>${h(item.name)}</strong> · ${h(summarizeNeeds(item.needs))}${item.recipes.length > 1 ? ` · ${item.recipes.length} recipes` : ''}</div>
        ${item.candidates.length
          ? `<select data-action="swap" data-key="${h(item.key)}" aria-label="Product">${options}<option value="-1" ${item.choice === -1 ? 'selected' : ''}>— none of these —</option></select>`
          : `<div class="product-meta">${item.searchError ? `Fred Meyer search failed: ${h(item.searchError)}` : 'No products found. Try another search below.'}</div>`}
        ${p ? `<div class="product-meta">${[p.brand, p.size, p.price && money(p.promoPrice || p.price) + (p.promoPrice ? ' sale' : ''), p.aisle, p.inStock === false && '⚠ out of stock', item.reason].filter(Boolean).map(h).join(' · ')}</div>` : ''}
        <details ${p ? '' : 'open'}><summary>Recipe lines · search again</summary>
          <ul>${lines}</ul>
          <span class="row"><input value="${h(item.searchTerm)}" data-search-for="${h(item.key)}" aria-label="Search term"><button class="small" data-action="research" data-key="${h(item.key)}">Search</button></span>
        </details>
      </div>
      <div class="side">
        <div class="qty">
          <button data-action="qty" data-delta="-1" data-key="${h(item.key)}" aria-label="Fewer" ${p ? '' : 'disabled'}>−</button>
          <span title="${h(item.packagesSource || '')}">${p ? item.packages : 0}</span>
          <button data-action="qty" data-delta="1" data-key="${h(item.key)}" aria-label="More" ${p ? '' : 'disabled'}>+</button>
        </div>
        <button class="small clear" data-action="remove-item" data-key="${h(item.key)}">remove</button>
      </div>
    </div>`;
}

const findItem = (key) => state.cart?.items.find((i) => i.key === key);

async function buildCart() {
  const status = $('#cart-status');
  if (!configured() || !prefs.store?.locationId) {
    syncButtons();
    location.hash = 'settings';
    return toast(configured() ? 'Choose your Fred Meyer store first.' : 'Finish Config first.', 'error');
  }
  await guarded(status, async () => {
    const recipes = state.selected.map((s) => ({ name: s.recipe.name, ingredients: s.recipe.ingredients || [], scale: scaleFor(s.recipe, s.servings) }));
    const result = await resolveIngredients({
      recipes,
      pantry: prefs.pantry || [],
      gemini: gemini(),
      searchProducts: productSearcher(relay(), prefs.store.locationId),
      onProgress: (t) => setStatus(status, t),
    });
    state.cart = { ...result, signature: pickSignature(), builtAt: Date.now(), sentAt: null };
    persist();
    const failed = result.items.filter((i) => i.searchError);
    const direct = lastDirectProblem() ? ` Searching directly from this device also failed: ${lastDirectProblem()}.` : '';
    setStatus(status, failed.length ? `Fred Meyer search failed for ${plural(failed.length, 'item')}: ${failed[0].searchError}.${direct}` : '', 'error');
    renderCart();
  });
}

async function searchFor(item, term) {
  const found = (await productSearcher(relay(), prefs.store?.locationId)([term]))[term];
  item.searchTerm = term;
  item.candidates = (Array.isArray(found) ? found : []).filter((p) => p.upc).slice(0, MAX_CANDIDATES);
  item.searchError = item.candidates.length ? null : found?.error || null;
  item.choice = item.candidates.length ? heuristicPick(item, item.candidates) : -1;
  item.geminiChoice = undefined;
  item.reason = item.candidates.length ? 'your search' : item.searchError ? 'search failed' : 'no products found';
  setPackages(item);
}

async function sendCart() {
  const cart = state.cart;
  const items = cartLines(cart);
  if (cart.sentAt && !(await painted(), confirm('These were already sent. The Fred Meyer cart can\'t be read or edited from here, so sending again will add duplicates. Send anyway?'))) return syncButtons();
  const status = $('#cart-status');
  await guarded(status, async () => {
    setStatus(status, `Adding ${items.length} products to your Fred Meyer cart…`);
    try {
      const r = await relay().cartAdd(items, prefs.modality);
      cart.sentAt = Date.now();
      cart.sentSignature = linesSignature(cart);
      persist();
      setStatus(status, `Added ${r.added} products. Review and check out in Fred Meyer: `, 'ok');
      status.insertAdjacentHTML('beforeend', fmCartLink('Open Fred Meyer cart'));
      renderCart();
      // Picked recipes are saved to the shared Save tab automatically.
      relay().libraryPicked(state.selected.slice(0, 20).map((s) => withCook(s.recipe)))
        .then((r) => { library = r.recipes; })
        .catch((err) => console.warn('could not record picked recipes', err));
    } catch (err) {
      if (err.code === 'kroger_auth_required') {
        setStatus(status, '');
        if (confirm('Connect your Fred Meyer account first? You\'ll come back here afterwards.')) await connectKroger('#cart');
        return;
      }
      throw err;
    }
  });
}

// ---------------------------------------------------------------- library

async function loadLibrary(force = false) {
  const status = $('#library-status');
  if (!configured()) {
    setStatus(status, 'Set up the relay in Config to use your saved recipes.', 'error');
    return;
  }
  if (library && !force) return renderLibrary();
  try {
    setStatus(status, 'Loading recipes…');
    library = (await relay().library()).recipes;
    setStatus(status, '');
  } catch (err) {
    setStatus(status, err.message, 'error');
    library = library || [];
  }
  renderLibrary();
}

const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// One list (saved by hand or automatically when sent to Fred Meyer), grouped
// by when it was last saved or picked. Each can be picked again or removed.
function renderLibrary() {
  const q = $('#library-filter').value.trim().toLowerCase();
  const list = (library || [])
    .filter((r) => !q || [r.name, r.site, ...(r.ingredients || []), ...(r.cuisine || [])].join(' ').toLowerCase().includes(q));
  const note = (r) => (r.lastPickedAt
    ? `Picked ${shortDate(r.lastPickedAt)}${r.pickedCount > 1 ? ` · ${r.pickedCount}× so far` : ''}`
    : r.savedAt ? `Saved ${shortDate(r.savedAt)}` : '');
  $('#library').innerHTML = list.length
    ? groupByRecency(list).map((g) => `
        <div class="section-title"><h2>${g.title}</h2><span class="muted small-text">${g.recipes.length}</span></div>
        <div class="grid">${g.recipes.map((r) => recipeCard(r, { libraryId: r.id, reason: note(r) })).join('')}</div>`).join('')
    : `<p class="muted">${library?.length ? 'No matches.' : 'Nothing saved yet. Save recipes from search results or add one by link below. Recipes you send to Fred Meyer are saved here automatically.'}</p>`;
}

async function saveRecipe(url) {
  const recipe = allKnownRecipes().get(url);
  if (!recipe) return;
  await guarded(null, async () => {
    const saved = (await relay().librarySave(withCook(recipe))).recipe;
    library = [saved, ...(library || []).filter((r) => r.url !== saved.url)];
    toast('Saved');
    route();
  });
}

async function addByUrl() {
  const input = $('#add-url');
  const url = input.value.trim();
  if (!url) return;
  const status = $('#library-status');
  await guarded(status, async () => {
    setStatus(status, 'Reading recipe…');
    const r = await relay().recipe(url, true);
    if (!r.recipe) throw new Error(`No recipe found on that page (${r.reason}).`);
    const saved = (await relay().librarySave(r.recipe)).recipe;
    library = [saved, ...(library || []).filter((x) => x.url !== saved.url)];
    input.value = '';
    setStatus(status, `Added “${saved.name}”.`, 'ok');
    renderLibrary();
  });
}

// ---------------------------------------------------------------- cook

const cookView = createCookView({ root: $('#cook'), timersEl: $('#timers'), toast, onClose: syncButtons });

// Steps written on this device ride along when a recipe gets saved, so
// they're in the shared library for both of you.
function withCook(recipe) {
  const cook = recipe.cook || storage.loadCook(recipe.url);
  return cook ? { ...recipe, cook } : recipe;
}

function openCook(url) {
  // Search results carry the original steps; saved entries carry Cook steps.
  const fromResults = state.results?.ranked?.find((r) => r.recipe.url === url)?.recipe;
  const pick = state.selected.find((s) => s.recipe.url === url);
  const recipe = { ...pick?.recipe, ...fromResults, ...savedEntry(url) };
  if (!recipe.url) return syncButtons();
  recipe.ingredients ||= [];
  const view = location.hash.slice(1);
  const servings = pick?.servings || (view === 'find' && state.criteria?.servings) || prefs.servings || recipe.servings;
  cookView.open({ recipe, servings, load: ({ fresh }) => loadCook(recipe, { fresh }) });
}

// fresh: write new steps (Regenerate) instead of using saved ones.
async function loadCook(recipe, { fresh = false } = {}) {
  const saved = savedEntry(recipe.url);
  if (saved?.cook && !fresh) return saved.cook;
  let cook = fresh ? null : storage.loadCook(recipe.url);
  if (!cook) {
    if (!configured()) throw new Error('finish Config first.');
    let { instructions } = recipe;
    if (!Array.isArray(instructions)) {
      // Pages read before Cook existed were cached without their steps: fetch again.
      let fresh = (await relay().recipe(recipe.url)).recipe;
      if (fresh && !Array.isArray(fresh.instructions)) fresh = (await relay().recipe(recipe.url, true)).recipe;
      instructions = fresh?.instructions || [];
    }
    if (!instructions.length) throw new NoStepsError();
    // Always the strong model for Cook (accuracy matters more than speed);
    // it falls back to the light one only if the strong one is rate limited.
    cook = await generateCook(createGemini({ apiKey: settings.geminiKey, model: createModelSwitch() }), recipe, instructions);
    storage.saveCook(recipe.url, cook);
  }
  if (saved) {
    relay().librarySave({ ...saved, cook })
      .then((r) => { library = (library || []).map((x) => (x.url === r.recipe.url ? r.recipe : x)); })
      .catch((err) => console.warn('could not save Cook steps', err));
  }
  return cook;
}

// ---------------------------------------------------------------- settings

function renderSettings() {
  const form = $('#settings-form');
  for (const k of ['relayUrl', 'relayPassword', 'geminiKey']) form.elements[k].value = settings[k] || '';
  if (DEFAULT_RELAY_URL) form.elements.relayUrl.placeholder = DEFAULT_RELAY_URL;
  $('#relay-url-hint').hidden = !DEFAULT_RELAY_URL;
  const pf = $('#prefs-form');
  pf.elements.pantry.value = (prefs.pantry || []).join('\n');
  pf.elements.leaveOut.value = (prefs.leaveOut || []).join('\n');
  pf.elements.modality.value = prefs.modality || 'PICKUP';
  pf.elements.minRating.value = String(prefs.minRating ?? storage.DEFAULT_MIN_RATING);
  pf.elements.maxMinutes.value = prefs.maxMinutes ? String(prefs.maxMinutes) : '';
  pf.elements.servings.value = prefs.servings || storage.DEFAULT_SERVINGS;
  pf.elements.easy.checked = Boolean(prefs.easy);
  pf.elements.easyMaxIngredients.value = easyLimits().maxIngredients;
  pf.elements.easyMaxSteps.value = easyLimits().maxSteps;
  $('#store-current').innerHTML = prefs.store
    ? `Store: <strong>${h(prefs.store.name)}</strong> <span class="muted small-text">${h(prefs.store.address || '')} · #${h(prefs.store.locationId)}</span>`
    : '<span class="notice">No store chosen yet.</span>';
  if (configured()) refreshKrogerStatus();
}

async function refreshKrogerStatus() {
  const el = $('#kroger-status');
  try {
    const s = await relay().krogerStatus();
    el.textContent = s.connected ? `Connected${s.connectedAt ? ` since ${new Date(s.connectedAt).toLocaleDateString()}` : ''}.` : 'Not connected.';
    // Not connected: one green Connect. Connected: red Disconnect, with Reconnect as a quiet link.
    $('#kroger-connect').textContent = s.connected ? 'Reconnect' : 'Connect Fred Meyer';
    $('#kroger-connect').className = s.connected ? 'small link' : 'go';
    $('#kroger-disconnect').hidden = !s.connected;
  } catch (err) {
    el.textContent = `Couldn't check: ${err.message}`;
  }
}

async function connectKroger(hash = '#settings') {
  const returnTo = `${location.origin}${location.pathname}${hash}`;
  const { url } = await relay().oauthStart(returnTo);
  location.href = url;
}

async function loadRemotePrefs() {
  if (!configured()) return;
  try {
    const remote = (await relay().prefs()).prefs || {};
    prefs = { ...storage.loadPrefs(), ...remote };
    storage.savePrefs(prefs);
  } catch (err) {
    console.warn('prefs load failed', err);
  }
}

async function savePrefsRemote(patch) {
  const updated = (await relay().prefsUpdate(patch)).prefs;
  prefs = { ...prefs, ...updated, ...patch };
  storage.savePrefs(prefs);
}

async function diagnose() {
  const out = $('#diagnostics');
  const line = (ok, text) => `<li>${ok ? '✅' : '⚠️'} ${h(text)}</li>`;
  out.innerHTML = '<li>Checking…</li>';
  const rows = [];
  try {
    const health = await relay().health();
    const c = health.configured;
    rows.push(line(true, 'Relay reachable and password accepted.'));
    rows.push(line(c.brave, `Brave key ${c.brave ? 'set' : 'missing'} · Kroger keys ${c.kroger ? 'set' : 'missing'} · KV ${c.kv ? 'bound' : 'missing'}`));
  } catch (err) {
    rows.push(line(false, `Relay: ${err.message}`));
  }
  try {
    const r = await gemini().json('Reply with {"ok": true}.', { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] });
    rows.push(line(r.ok === true, `Gemini (${modelSwitch.model}) responding.`));
  } catch (err) {
    rows.push(line(false, `Gemini: ${err.message}`));
  }
  // Build-plan question: does Kroger allow direct browser calls (CORS)?
  // Real product search, reporting whether it went direct from this device or via the relay.
  try {
    resetDirectSearch();
    const milk = (await productSearcher(relay(), prefs.store?.locationId)(['milk'])).milk;
    const route = { direct: 'directly from this device', relay: 'through the relay', mixed: 'partly through the relay' }[lastSearchRoute()] || '';
    rows.push(Array.isArray(milk) && milk.length
      ? line(true, `Fred Meyer product search works ${route} (${milk.length} results for "milk").`)
      : line(false, `Fred Meyer product search failed ${route}: ${milk?.error || 'no results'}`));
    if (lastSearchRoute() !== 'direct' && lastDirectProblem()) rows.push(line(false, `Direct search from this device: ${lastDirectProblem()}.`));
  } catch (err) {
    rows.push(line(false, `Fred Meyer product search: ${err.message}`));
  }
  rows.push(line(Boolean(prefs.store), prefs.store ? `Store: ${prefs.store.name}` : 'No store chosen yet.'));
  out.innerHTML = rows.join('');
  $('#diagnose-btn').classList.add('on');
}

async function findStores() {
  const zip = $('#zip').value.trim();
  const el = $('#store-list');
  return guarded(null, async () => {
    el.innerHTML = '<p class="muted">Searching…</p>';
    const { locations } = await relay().locations(zip);
    el.innerHTML = locations.length
      ? `<div class="stores">${locations.map((l) => `<label><input type="radio" name="store" value="${h(l.locationId)}" ${prefs.store?.locationId === l.locationId ? 'checked' : ''} data-store='${h(JSON.stringify(l))}'> <span><strong>${h(l.name)}</strong><br><span class="muted small-text">${h(l.address)}</span></span></label>`).join('')}</div>`
      : '<p class="muted">No Kroger-family stores within 25 miles of that ZIP.</p>';
  });
}

// ---------------------------------------------------------------- events

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.tagName === 'SELECT' || btn.tagName === 'INPUT') return;
  const { action, url, key, id } = btn.dataset;
  const cart = state.cart;
  switch (action) {
    case 'toggle-pick': return togglePick(url);
    case 'save': return saveRecipe(url);
    case 'cook': return openCook(url);
    case 'lib-delete':
      await painted();
      if (!confirm('Remove this recipe from Save (for both of you)?')) return syncButtons();
      return guarded($('#library-status'), async () => {
        await relay().libraryDelete(id);
        library = library.filter((r) => r.id !== id);
        renderLibrary();
      });
    case 'build-cart': return buildCart();
    case 'clear-results':
      state.results = null;
      persist();
      setStatus($('#find-status'), '');
      return renderResults();
    case 'clear-cart':
      if (!confirm('Clear the picked recipes and shopping list? This doesn\'t change your Fred Meyer cart.')) return;
      state.selected = [];
      state.cart = null;
      persist();
      setStatus($('#cart-status'), '');
      return route();
    case 'clear-list':
      // Shopping list only; the picked recipes stay so it can be rebuilt.
      if (!confirm('Clear the shopping list? Your picked recipes stay. This doesn\'t change your Fred Meyer cart.')) return;
      state.cart = null;
      persist();
      setStatus($('#cart-status'), '');
      return renderCart();
    case 'send-cart': return sendCart();
    case 'qty': {
      const item = findItem(key);
      item.packages = Math.max(1, Math.min(99, item.packages + Number(btn.dataset.delta)));
      item.packagesSource = 'you';
      break;
    }
    case 'remove-item': findItem(key).removed = true; break;
    case 'restore-item': findItem(key).removed = false; break;
    case 'research': {
      const term = document.querySelector(`[data-search-for="${CSS.escape(key)}"]`).value.trim();
      if (!term) return;
      await guarded($('#cart-status'), () => searchFor(findItem(key), term));
      break;
    }
    case 'add-skipped': {
      const [s] = cart.skipped.splice(Number(btn.dataset.idx), 1);
      const item = { key: `added:${s.line}`, name: s.name, searchTerm: s.searchTerm, needs: s.needs, recipes: [s.recipe], lines: [s.line], candidates: [], choice: -1 };
      cart.items.push(item);
      await guarded($('#cart-status'), () => searchFor(item, s.searchTerm));
      break;
    }
    default: return;
  }
  persist();
  renderShoppingList();
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.action === 'swap') {
    const item = findItem(el.dataset.key);
    item.choice = Number(el.value);
    item.reason = item.choice === item.geminiChoice ? item.reason : 'your choice';
    setPackages(item);
    persist();
    renderShoppingList();
  } else if (el.dataset.action === 'servings') {
    const s = state.selected.find((x) => x.recipe.url === el.dataset.url);
    s.servings = Math.max(1, Number(el.value) || 1);
    persist();
    renderShoppingList();
  } else if (el.name === 'modelTier') {
    modelSwitch.set(el.value);
  } else if (el.name === 'store') {
    const store = JSON.parse(el.dataset.store);
    guarded(null, async () => {
      await savePrefsRemote({ store });
      toast(`Store set to ${store.name}`);
      renderSettings();
    });
  }
});

$('#criteria').addEventListener('submit', runSearch);
$('#library-filter').addEventListener('input', renderLibrary);
// Add is solid while it reads the page; Find stores stays solid over its results.
$('#add-url-btn').addEventListener('click', () => addByUrl().finally(() => $('#add-url-btn').classList.remove('on')));
$('#zip-btn').addEventListener('click', async () => { if (!await findStores()) $('#zip-btn').classList.remove('on'); });
$('#diagnose-btn').addEventListener('click', diagnose);
$('#kroger-connect').addEventListener('click', async () => {
  if (!await guarded(null, () => connectKroger())) $('#kroger-connect').classList.remove('on');
});
$('#kroger-disconnect').addEventListener('click', async () => {
  await painted();
  const ok = confirm('Disconnect the Fred Meyer account for both of you?') && await guarded(null, async () => {
    await relay().krogerDisconnect();
    refreshKrogerStatus();
  });
  if (!ok) $('#kroger-disconnect').classList.remove('on');
});

$('#settings-form').addEventListener('input', () => $('#device-save').classList.remove('on'));
$('#prefs-form').addEventListener('input', () => $('#prefs-save').classList.remove('on'));
$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  settings = {
    relayUrl: ((u) => (u === DEFAULT_RELAY_URL ? '' : u))(f.relayUrl.value.trim().replace(/\/+$/, '')),
    relayPassword: f.relayPassword.value,
    geminiKey: f.geminiKey.value.trim(),
  };
  storage.saveSettings(settings);
  toast('Saved on this device');
  $('#device-save').classList.add('on');
  library = null;
  await loadRemotePrefs();
  renderSettings();
});

// An app added to the home screen keeps its own storage and has no address
// bar to open a setup link in, so the link can be pasted here instead.
$('#paste-setup-btn').addEventListener('click', async () => {
  const text = (prompt('Paste the setup link (Config → Share setup link, on a phone that\'s set up):') || '').trim();
  if (!text) return;
  const hash = text.slice(Math.max(0, text.indexOf('#')));
  if (!readSetupLink(hash)) return toast("That isn't a DinnerCart setup link.", 'error');
  applySetupLink(hash);
  library = null;
  await loadRemotePrefs();
  applySearchDefaults();
  renderSettings();
  route();
});

$('#share-setup-btn').addEventListener('click', () => guarded(null, async () => {
  if (!relayUrl() || !settings.relayPassword) throw new Error('Save the relay URL and password on this device first.');
  const link = makeSetupLink(`${location.origin}${location.pathname}`, {
    relayUrl: settings.relayUrl,
    relayPassword: settings.relayPassword,
    geminiKey: $('#share-gemini').checked ? settings.geminiKey : '',
  });
  if (navigator.share) {
    try {
      await navigator.share({ title: 'DinnerCart setup', url: link });
    } catch (err) {
      if (err.name !== 'AbortError') throw err;
    }
    return;
  }
  await navigator.clipboard.writeText(link);
  toast('Setup link copied. Open it on the other phone.');
}).then(() => $('#share-setup-btn').classList.remove('on')));

$('#prefs-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const lines = (text) => text.split('\n').map((s) => s.trim()).filter(Boolean);
  const pantry = lines(f.pantry.value);
  guarded(null, async () => {
    await savePrefsRemote({
      pantry,
      leaveOut: lines(f.leaveOut.value),
      modality: f.modality.value,
      minRating: Number(f.minRating.value),
      maxMinutes: Number(f.maxMinutes.value) || null,
      servings: Math.min(20, Math.max(1, Math.round(Number(f.servings.value) || storage.DEFAULT_SERVINGS))),
      easy: f.easy.checked,
      easyMaxIngredients: Math.min(50, Math.max(1, Math.round(Number(f.easyMaxIngredients.value) || storage.DEFAULT_EASY_MAX_INGREDIENTS))),
      easyMaxSteps: Math.min(50, Math.max(1, Math.round(Number(f.easyMaxSteps.value) || storage.DEFAULT_EASY_MAX_STEPS))),
    });
    applySearchDefaults();
    toast('Household settings saved');
    $('#prefs-save').classList.add('on');
  }).then((ok) => { if (!ok) $('#prefs-save').classList.remove('on'); });
});

// ---------------------------------------------------------------- start

// Opened from a "Share setup link" link: save its settings on this device.
function applySetupLink(hash = location.hash) {
  const fromLink = readSetupLink(hash);
  if (!fromLink) return;
  const differs = settings.relayPassword && (settings.relayPassword !== fromLink.relayPassword || (settings.relayUrl || '') !== (fromLink.relayUrl || ''));
  if (!differs || confirm('Replace the DinnerCart settings on this device with the ones from this link?')) {
    settings = { ...settings, ...fromLink, relayUrl: fromLink.relayUrl || '' };
    storage.saveSettings(settings);
  }
  const done = Boolean(settings.geminiKey);
  history.replaceState(null, '', `${location.pathname}${location.search}${done ? '#find' : '#settings'}`);
  toast(done ? 'This device is set up.' : 'Almost done: add your Gemini key and press Save.');
}

// Opening the app starts on Search (a home-screen app can come back on
// whatever tab it was left on). A reload, the Fred Meyer login coming back,
// a setup link and the boot check's retry keep their tab; until the app is
// set up it opens on Config.
function startOnSearch() {
  const nav = performance.getEntriesByType?.('navigation')[0]?.type;
  const params = new URLSearchParams(location.search);
  if (nav === 'reload' || nav === 'back_forward' || params.has('kroger') || params.has('r')) return;
  if (!configured() || readSetupLink(location.hash) || !location.hash || location.hash === '#find') return;
  history.replaceState(null, '', `${location.pathname}${location.search}#find`);
}

function handleOAuthReturn() {
  const params = new URLSearchParams(location.search);
  const result = params.get('kroger');
  if (!result) return;
  if (result === 'connected') toast('Fred Meyer account connected.');
  else toast(`Fred Meyer login didn't finish (${params.get('reason') || 'unknown'}).`, 'error');
  history.replaceState(null, '', `${location.pathname}${location.hash}`);
}

$('#app-version').textContent = `v${VERSION}`;
hydrateIcons();
// Recipe photos that fail to load get the bowl placeholder.
window.dcImageFallback = (img) => {
  const div = document.createElement('div');
  div.className = 'noimg';
  div.innerHTML = icon('bowl');
  img.replaceWith(div);
};
renderModelToggle();
applySearchDefaults();
$('#criteria').addEventListener('change', () => { findFormTouched = true; });

// Rotating "What sounds good?" ideas; tapping the label fills in the one showing.
// Gemini writes a fresh batch once a day for the household (light model,
// so it doesn't use up the strong model's limit). The first device to open
// the app that day generates it and shares it via the relay's prefs; the
// other picks it up from there. Built-in ideas until then.
let dailyIdeas = storage.loadIdeas();
const ideas = rotatePlaceholder($('#criteria').elements.wants, () => (dailyIdeas?.ideas?.length ? dailyIdeas.ideas : IDEAS));
async function refreshDailyIdeas() {
  if (!configured()) return;
  const today = todayKey();
  const use = (batch) => {
    dailyIdeas = batch;
    storage.saveIdeas(batch);
    ideas.refresh();
  };
  if (prefs.dailyIdeas?.date === today && prefs.dailyIdeas.ideas?.length) {
    if (dailyIdeas?.date !== today || dailyIdeas.ideas.join() !== prefs.dailyIdeas.ideas.join()) use(prefs.dailyIdeas);
    return;
  }
  try {
    if (dailyIdeas?.date === today) {
      // Made here earlier but never reached the relay (e.g. offline): share it now.
      await savePrefsRemote({ dailyIdeas });
      return;
    }
    const fresh = await generateIdeas(createGemini({ apiKey: settings.geminiKey, model: LIGHT_MODEL }), { liked: library || [] });
    if (!fresh) return;
    use({ date: today, ideas: fresh });
    await savePrefsRemote({ dailyIdeas: dailyIdeas });
  } catch (err) {
    console.warn('daily ideas failed; using built-in list', err);
  }
}
document.querySelectorAll('[data-suggest]').forEach((label) => label.addEventListener('click', (e) => {
  e.preventDefault();
  const input = $('#criteria').elements[label.dataset.suggest];
  input.value = ideas.current();
  input.focus();
}));
startOnSearch();
applySetupLink();
handleOAuthReturn();
window.addEventListener('hashchange', route);
route();
window.dcStarted = true; // the boot check in index.html stands down
// Drop the ?r= the boot check adds when it reloads.
if (new URLSearchParams(location.search).has('r')) history.replaceState(history.state, '', `${location.pathname}${location.hash}`);
if (configured()) {
  const prefsLoaded = loadRemotePrefs().then(() => { applySearchDefaults(); if (location.hash === '#settings') renderSettings(); if (location.hash === '#cart') renderCart(); });
  const libraryLoaded = relay().library().then((r) => { library = r.recipes; if (location.hash !== '#cart' && location.hash !== '#settings') route(); });
  // Needs the shared prefs (today's batch, if any) and the library (taste).
  Promise.allSettled([prefsLoaded, libraryLoaded]).then(refreshDailyIdeas);
}

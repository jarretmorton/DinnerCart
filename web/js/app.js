// DinnerCart UI controller. Plain DOM; views are re-rendered from `state`.
import { LIGHT_MODEL, createGemini, createModelSwitch } from './gemini.js';
import { createRelay, productSearcher } from './relay.js';
import { findRecipes, scaleFor } from './recipes.js';
import { MAX_CANDIDATES, estimateTotal, heuristicPick, resolveIngredients, setPackages } from './resolver.js';
import * as storage from './storage.js';
import { summarizeNeeds } from './units.js';
import { escapeHtml as h, money } from './util.js';
import { IDEAS, LEAVE_OUT_EXAMPLES, generateIdeas, rotatePlaceholder, todayKey } from './suggestions.js';
import { VERSION } from './version.js';

const $ = (sel) => document.querySelector(sel);
const VIEWS = ['find', 'cart', 'recipes', 'settings'];
// Opens the Fred Meyer app on phones that have it installed.
const FM_CART_URL = 'https://www.fredmeyer.com/cart';
const fmCartLink = (text = 'Open Fred Meyer cart ↗') => `<a href="${FM_CART_URL}" target="_blank" rel="noopener">${text}</a>`;

let settings = storage.loadSettings();
let prefs = storage.loadPrefs();
const state = { criteria: null, results: null, selected: [], cart: null, ...storage.loadState() };
let library = null;
let busy = false;

const persist = () => storage.saveState({ criteria: state.criteria, results: state.results, selected: state.selected, cart: state.cart });
const configured = () => Boolean(settings.relayUrl && settings.relayPassword && settings.geminiKey);
const relay = () => createRelay({ url: settings.relayUrl, password: settings.relayPassword });
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

async function guarded(statusEl, fn) {
  if (busy) return;
  busy = true;
  document.body.classList.add('busy');
  try {
    await fn();
  } catch (err) {
    console.error(err);
    if (statusEl) setStatus(statusEl, err.message, 'error');
    else toast(err.message, 'error');
  } finally {
    busy = false;
    document.body.classList.remove('busy');
  }
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

function recipeCard(recipe, { reason, libraryId } = {}) {
  const picked = isPicked(recipe.url);
  const saved = savedEntry(recipe.url);
  const meta = [
    recipe.site && `<span>${h(recipe.site)}</span>`,
    `<span>⏱ ${recipe.totalMinutes ? `${recipe.totalMinutes} min` : 'time ?'}</span>`,
    `<span>🍽 ${recipe.servings ? `serves ${h(recipe.servings)}` : 'servings ?'}</span>`,
    recipe.rating && `<span>★ ${h(recipe.rating.value)}${recipe.rating.count ? ` (${h(recipe.rating.count)})` : ''}</span>`,
    recipe.nutrition?.caloriesNumber && `<span>${h(recipe.nutrition.caloriesNumber)} cal</span>`,
  ].filter(Boolean).join('');
  return `
    <article class="card recipe ${picked ? 'selected' : ''}">
      ${recipe.image ? `<img src="${h(recipe.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'noimg',textContent:'🍲'}))">` : '<div class="noimg">🍲</div>'}
      <div class="body">
        <h3><a href="${h(recipe.url)}" target="_blank" rel="noopener">${h(recipe.name)}</a></h3>
        <div class="meta">${meta}</div>
        ${reason ? `<div class="why">${h(reason)}</div>` : ''}
        <details><summary>${plural(recipe.ingredients.length, 'ingredient')}</summary>
          <ul>${recipe.ingredients.map((i) => `<li>${h(i)}</li>`).join('')}</ul>
        </details>
        <div class="buttons">
          <button class="${picked ? '' : 'primary'}" data-action="toggle-pick" data-url="${h(recipe.url)}">${picked ? '✓ Picked' : 'Pick'}</button>
          ${libraryId
            ? `<button data-action="lib-delete" data-id="${h(libraryId)}">Remove</button>`
            : `<button data-action="save" data-url="${h(recipe.url)}" ${saved ? 'disabled' : ''}>${saved ? '★ Saved' : '☆ Save'}</button>`}
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
    exclude: list(f.get('exclude')),
  };
}

// Max time and servings start from the household defaults on every load,
// unless the user has already edited the form this visit.
let findFormTouched = false;
function applySearchDefaults() {
  if (findFormTouched) return;
  const form = $('#criteria');
  const time = form.elements.maxMinutes;
  time.value = prefs.maxMinutes ? String(prefs.maxMinutes) : '';
  if (time.selectedIndex < 0) time.value = String(storage.DEFAULT_MAX_MINUTES);
  form.elements.servings.value = prefs.servings || storage.DEFAULT_SERVINGS;
}

// "What sounds good?" starts empty on every load; only the leave-out list
// carries over from the last search.
function fillCriteria(form, c) {
  if (!c) return;
  form.elements.exclude.value = (c.exclude || []).join(', ');
}

async function runSearch(event) {
  event.preventDefault();
  const status = $('#find-status');
  if (!configured()) {
    toast('Finish Settings first (relay URL, password, Gemini key).', 'error');
    location.hash = 'settings';
    return;
  }
  const recommend = event.submitter?.id === 'recommend-btn';
  const criteria = { ...readCriteria(event.target), minRating: prefs.minRating ?? storage.DEFAULT_MIN_RATING };
  if (!recommend && !criteria.wants) {
    setStatus(status, 'Tell me what sounds good, or try Recommendations.', 'error');
    return;
  }
  const buttons = [$('#search-btn'), $('#recommend-btn')];
  await guarded(status, async () => {
    buttons.forEach((b) => { b.disabled = true; });
    try {
      state.criteria = criteria;
      let liked;
      if (recommend) {
        if (!library) library = (await relay().library()).recipes;
        liked = library;
      }
      const results = await findRecipes({ gemini: gemini(), relay: relay(), criteria, liked, onProgress: (t) => setStatus(status, t) });
      state.results = { ...results, mode: recommend ? 'recommend' : 'find', basedOn: liked?.length || 0, minRating: criteria.minRating, at: Date.now() };
      persist();
      setStatus(status, '');
      renderResults();
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  });
}

function renderResults() {
  const el = $('#results');
  const r = state.results;
  if (!r) {
    el.innerHTML = '';
    return;
  }
  const rejected = r.rejected || [];
  const failed = r.failed || [];
  el.innerHTML = `
    <div class="section-title">
      <h2>${r.ranked.length ? `${r.mode === 'recommend' ? 'Recommended: ' : ''}${plural(r.ranked.length, 'recipe')}` : 'No recipes matched'}</h2>
      <button class="small" data-action="clear-results">Clear results</button>
    </div>
    <p class="muted small-text">${r.mode === 'recommend' ? (r.basedOn ? `Based on ${plural(r.basedOn, 'saved recipe')} · ` : 'No saved recipes yet, so these are popular picks · ') : ''}Searched: ${r.queries.map(h).join(' · ')}${r.minRating ? ` · rated ${h(r.minRating)}★ and up` : ''}</p>
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
    picked.innerHTML = `<div class="card"><h2>Nothing picked yet</h2><p class="muted">Pick recipes on <a href="#find">Find</a> or from your saved <a href="#recipes">Recipes</a>.</p><p>${fmCartLink()}</p></div>`;
    $('#cart').innerHTML = '';
    return;
  }
  picked.innerHTML = `
    <div class="card">
      <div class="section-title" style="margin-top:0"><h2>Picked recipes</h2><button class="small" data-action="clear-cart">Clear cart</button></div>
      ${state.selected.map((s) => `
        <div class="picked-row">
          <div class="name"><a href="${h(s.recipe.url)}" target="_blank" rel="noopener">${h(s.recipe.name)}</a>
            <div class="muted small-text">${h(s.recipe.site || '')}${s.recipe.servings ? ` · recipe makes ${h(s.recipe.servings)}` : ' · servings unknown, not scaled'}</div></div>
          <label class="small-text">serves <input type="number" min="1" max="40" value="${h(s.servings)}" data-action="servings" data-url="${h(s.recipe.url)}"></label>
          <button class="small" data-action="toggle-pick" data-url="${h(s.recipe.url)}" aria-label="Remove">✕</button>
        </div>`).join('')}
      <div class="actions" style="margin-top:12px">
        <button class="primary" data-action="build-cart" ${state.selected.length ? '' : 'disabled'}>${cart ? 'Rebuild' : 'Match'} ingredients${storeName ? ` at ${h(storeName)}` : ''}</button>
      </div>
      ${storeName ? '' : '<p class="notice" style="margin:12px 0 0">Choose your Fred Meyer store in <a href="#settings">Settings</a> first.</p>'}
    </div>`;
  renderShoppingList();
}

function renderShoppingList() {
  const el = $('#cart');
  const cart = state.cart;
  if (!cart) {
    el.innerHTML = '';
    return;
  }
  const active = cart.items.filter((i) => !i.removed);
  const removed = cart.items.filter((i) => i.removed);
  const sendable = active.filter((i) => i.candidates[i.choice] && i.packages > 0);
  const missing = active.filter((i) => !i.candidates[i.choice]);
  el.innerHTML = `
    ${cart.signature !== pickSignature() ? '<div class="notice">Your picks or servings changed since this list was built. Rebuild to update it.</div>' : ''}
    <div class="card">
      <div class="section-title" style="margin-top:0"><h2>Shopping list</h2><span class="muted small-text">${plural(active.length, 'item')}${missing.length ? ` · ${missing.length} need a product` : ''}</span></div>
      ${active.map(itemRow).join('') || '<p class="muted">Everything is covered by the pantry.</p>'}
    </div>
    ${cart.skipped.length ? `<div class="card"><h3>Not adding</h3><p class="muted small-text">Pantry staples, optional garnishes and water. Tap + to add one anyway.</p>
      <div class="chips">${cart.skipped.map((s, i) => `<span class="chip" title="${h(s.text)}">${h(s.name)} <span class="reason">${h(s.reason)}</span><button class="small link" data-action="add-skipped" data-idx="${i}" aria-label="Add">＋</button></span>`).join('')}</div></div>` : ''}
    ${removed.length ? `<div class="card"><h3>Removed</h3><div class="chips">${removed.map((i) => `<span class="chip">${h(i.name)}<button class="small link" data-action="restore-item" data-key="${h(i.key)}">undo</button></span>`).join('')}</div></div>` : ''}
    <div class="card sendbar">
      <div><strong>${plural(sendable.length, 'product')}</strong> · est. ${money(estimateTotal(sendable))}
        <div class="muted small-text">${prefs.modality === 'DELIVERY' ? 'Delivery' : 'Pickup'} cart${cart.sentAt ? ` · sent ${new Date(cart.sentAt).toLocaleString()}` : ''} · ${fmCartLink()}</div></div>
      <button class="primary" data-action="send-cart" ${sendable.length ? '' : 'disabled'}>${cart.sentAt ? 'Send again' : 'Add to Fred Meyer cart'}</button>
    </div>`;
}

function itemRow(item) {
  const p = item.candidates[item.choice];
  const options = item.candidates.map((c, i) => `<option value="${i}" ${i === item.choice ? 'selected' : ''}>${h(c.description)}${c.size ? ` · ${h(c.size)}` : ''}${c.price ? ` · ${money(c.promoPrice || c.price)}` : ''}${c.inStock === false ? ' · out of stock' : ''}</option>`).join('');
  const lines = item.needs.map((n) => `<li>${h(n.text)} <span class="muted">(${h(n.recipe)})</span></li>`).join('');
  return `
    <div class="item ${p ? '' : 'nomatch'}" data-key="${h(item.key)}">
      ${p?.image ? `<img src="${h(p.image)}" alt="" loading="lazy">` : `<div class="noimg">${p ? '🛒' : '?'}</div>`}
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
        <button class="small link" data-action="remove-item" data-key="${h(item.key)}">remove</button>
      </div>
    </div>`;
}

const findItem = (key) => state.cart?.items.find((i) => i.key === key);

async function buildCart() {
  const status = $('#cart-status');
  if (!configured()) { location.hash = 'settings'; return toast('Finish Settings first.', 'error'); }
  if (!prefs.store?.locationId) { location.hash = 'settings'; return toast('Choose your Fred Meyer store first.', 'error'); }
  await guarded(status, async () => {
    const recipes = state.selected.map((s) => ({ name: s.recipe.name, ingredients: s.recipe.ingredients, scale: scaleFor(s.recipe, s.servings) }));
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
    setStatus(status, failed.length ? `Fred Meyer search failed for ${plural(failed.length, 'item')}: ${failed[0].searchError}` : '', 'error');
    renderCart();
  });
}

async function searchFor(item, term) {
  const { results, errors = {} } = await relay().products([term], prefs.store?.locationId);
  item.searchTerm = term;
  item.candidates = (results[term] || []).filter((p) => p.upc).slice(0, MAX_CANDIDATES);
  item.searchError = item.candidates.length ? null : errors[term] || null;
  item.choice = item.candidates.length ? heuristicPick(item, item.candidates) : -1;
  item.geminiChoice = undefined;
  item.reason = item.candidates.length ? 'your search' : item.searchError ? 'search failed' : 'no products found';
  setPackages(item);
}

async function sendCart() {
  const cart = state.cart;
  const byUpc = new Map();
  for (const item of cart.items) {
    const p = item.candidates[item.choice];
    if (item.removed || !p || item.packages < 1) continue;
    byUpc.set(p.upc, (byUpc.get(p.upc) || 0) + item.packages);
  }
  const items = [...byUpc].map(([upc, quantity]) => ({ upc, quantity }));
  if (cart.sentAt && !confirm('These were already sent. The Fred Meyer cart can\'t be read or edited from here, so sending again will add duplicates. Send anyway?')) return;
  const status = $('#cart-status');
  await guarded(status, async () => {
    setStatus(status, `Adding ${items.length} products to your Fred Meyer cart…`);
    try {
      const r = await relay().cartAdd(items, prefs.modality);
      cart.sentAt = Date.now();
      persist();
      setStatus(status, `Added ${r.added} products. Review and check out in Fred Meyer: `, 'ok');
      status.insertAdjacentHTML('beforeend', fmCartLink());
      renderCart();
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
    setStatus(status, 'Set up the relay in Settings to use your saved recipes.', 'error');
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

function renderLibrary() {
  const q = $('#library-filter').value.trim().toLowerCase();
  const list = (library || []).filter((r) => !q || [r.name, r.site, ...(r.ingredients || []), ...(r.cuisine || [])].join(' ').toLowerCase().includes(q));
  $('#library').innerHTML = list.length
    ? `<div class="section-title"><h2>${list.length} saved</h2></div><div class="grid">${list.map((r) => recipeCard(r, { libraryId: r.id })).join('')}</div>`
    : `<p class="muted">${library?.length ? 'No matches.' : 'Nothing saved yet. Save recipes from search results, or add one by link.'}</p>`;
}

async function saveRecipe(url) {
  const recipe = allKnownRecipes().get(url);
  if (!recipe) return;
  await guarded(null, async () => {
    const saved = (await relay().librarySave(recipe)).recipe;
    library = [saved, ...(library || []).filter((r) => r.url !== saved.url)];
    toast('Saved to Recipes');
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

// ---------------------------------------------------------------- settings

function renderSettings() {
  const form = $('#settings-form');
  for (const k of ['relayUrl', 'relayPassword', 'geminiKey']) form.elements[k].value = settings[k] || '';
  const pf = $('#prefs-form');
  pf.elements.pantry.value = (prefs.pantry || []).join('\n');
  pf.elements.leaveOut.value = (prefs.leaveOut || []).join('\n');
  pf.elements.modality.value = prefs.modality || 'PICKUP';
  pf.elements.minRating.value = String(prefs.minRating ?? storage.DEFAULT_MIN_RATING);
  pf.elements.maxMinutes.value = prefs.maxMinutes ? String(prefs.maxMinutes) : '';
  pf.elements.servings.value = prefs.servings || storage.DEFAULT_SERVINGS;
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
    $('#kroger-connect').textContent = s.connected ? 'Reconnect' : 'Connect Fred Meyer';
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
  try {
    const res = await fetch('https://api.kroger.com/v1/products?filter.term=milk', { mode: 'cors' });
    rows.push(line(true, `Kroger CORS: browser CAN call api.kroger.com directly (HTTP ${res.status}). The relay is still needed for the client secret.`));
  } catch {
    rows.push(line(true, 'Kroger CORS: blocked for browsers, as expected; all Kroger calls go through the relay.'));
  }
  rows.push(line(Boolean(prefs.store), prefs.store ? `Store: ${prefs.store.name}` : 'No store chosen yet.'));
  out.innerHTML = rows.join('');
}

async function findStores() {
  const zip = $('#zip').value.trim();
  const el = $('#store-list');
  await guarded(null, async () => {
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
    case 'lib-delete':
      if (!confirm('Remove this recipe from your saved Recipes (for both of you)?')) return;
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
$('#add-url-btn').addEventListener('click', addByUrl);
$('#zip-btn').addEventListener('click', findStores);
$('#diagnose-btn').addEventListener('click', diagnose);
$('#kroger-connect').addEventListener('click', () => guarded(null, () => connectKroger()));
$('#kroger-disconnect').addEventListener('click', () => guarded(null, async () => {
  if (!confirm('Disconnect the Fred Meyer account for both of you?')) return;
  await relay().krogerDisconnect();
  refreshKrogerStatus();
}));

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  settings = {
    relayUrl: f.relayUrl.value.trim().replace(/\/+$/, ''),
    relayPassword: f.relayPassword.value,
    geminiKey: f.geminiKey.value.trim(),
  };
  storage.saveSettings(settings);
  toast('Saved on this device');
  library = null;
  await loadRemotePrefs();
  renderSettings();
});

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
    });
    applySearchDefaults();
    toast('Household settings saved');
  });
});

// ---------------------------------------------------------------- start

function handleOAuthReturn() {
  const params = new URLSearchParams(location.search);
  const result = params.get('kroger');
  if (!result) return;
  if (result === 'connected') toast('Fred Meyer account connected.');
  else toast(`Fred Meyer login didn't finish (${params.get('reason') || 'unknown'}).`, 'error');
  history.replaceState(null, '', `${location.pathname}${location.hash}`);
}

$('#app-version').textContent = `v${VERSION}`;
renderModelToggle();
fillCriteria($('#criteria'), state.criteria);
applySearchDefaults();
$('#criteria').addEventListener('change', () => { findFormTouched = true; });

// Rotating suggestions. Tapping a field's label fills in what it suggests:
// the idea showing for "What sounds good?", the household list for "What to leave out?".
// Gemini writes a fresh batch once a day per device (light model, so it
// doesn't use up the strong model's limit); built-in ideas until then.
let dailyIdeas = storage.loadIdeas();
const ideas = rotatePlaceholder($('#criteria').elements.wants, () => (dailyIdeas?.ideas?.length ? dailyIdeas.ideas : IDEAS));
async function refreshDailyIdeas() {
  if (!configured() || dailyIdeas?.date === todayKey()) return;
  try {
    const fresh = await generateIdeas(createGemini({ apiKey: settings.geminiKey, model: LIGHT_MODEL }), { liked: library || [] });
    if (!fresh) return;
    dailyIdeas = { date: todayKey(), ideas: fresh };
    storage.saveIdeas(dailyIdeas);
    ideas.refresh();
  } catch (err) {
    console.warn('daily ideas failed; using built-in list', err);
  }
}
const leaveOutList = () => (prefs.leaveOut?.length ? prefs.leaveOut : LEAVE_OUT_EXAMPLES);
const leaveOutIdeas = rotatePlaceholder($('#criteria').elements.exclude, leaveOutList);
document.querySelectorAll('[data-suggest]').forEach((label) => label.addEventListener('click', (e) => {
  e.preventDefault();
  const form = $('#criteria');
  const field = label.dataset.suggest;
  form.elements[field].value = field === 'wants'
    ? ideas.current()
    : (prefs.leaveOut?.length ? prefs.leaveOut.join(', ') : leaveOutIdeas.current());
  form.elements[field].focus();
}));
handleOAuthReturn();
window.addEventListener('hashchange', route);
route();
if (configured()) {
  loadRemotePrefs().then(() => { applySearchDefaults(); if (location.hash === '#settings') renderSettings(); if (location.hash === '#cart') renderCart(); });
  relay().library().then((r) => { library = r.recipes; if (location.hash !== '#cart' && location.hash !== '#settings') route(); }).catch(() => {}).finally(refreshDailyIdeas);
}

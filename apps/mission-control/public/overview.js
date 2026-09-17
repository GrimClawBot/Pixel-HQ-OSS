import { OverviewState } from '/assets/overview-controller.js';
import { renderSection, renderSystems } from '/assets/overview-view.js';
import { MAX_BYTES, MAX_AGE_MS, validToken } from '/assets/overview-contract.js';
let preference;
try { preference = localStorage.getItem('pixel.home.hero'); } catch { /* Display preferences are optional. */ }
const state = new OverviewState(preference);
let lastAccepted = 0;
const status = document.querySelector('#refresh-status');
const tabs = [...document.querySelectorAll('[role="tab"]')];
function updateHero() {
  for (const tab of tabs) {
    const selected = tab.dataset.hero === state.selected;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
  }
  for (const name of ['storage','ai_compute','incident']) document.querySelector(`#panel-${name}`).hidden = state.hero !== name;
}
for (const tab of tabs) {
  tab.addEventListener('click', () => {
    state.select(tab.dataset.hero); updateHero();
    try { localStorage.setItem('pixel.home.hero', state.selected); } catch { /* Optional preference. */ }
  });
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const target = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(tabs.indexOf(tab) + 1) % tabs.length];
    target.click(); target.focus();
  });
}
function draw() {
  if (!state.value) return;
  const activeId = document.activeElement?.id;
  const focusedDetail = [...document.querySelectorAll('#storage-card-root summary')].indexOf(document.activeElement);
  const openDetails = [...document.querySelectorAll('#storage-card-root details')].map(d => d.open);
  for (const [name, section] of Object.entries(state.value.sections)) {
    const root = document.querySelector(`[data-section="${name}"]`);
    if (root) { root.innerHTML = name === 'systems' ? renderSystems(section) : renderSection(name, section); root.setAttribute('aria-busy','false'); }
  }
  document.querySelectorAll('#storage-card-root details').forEach((d, i) => { d.open = openDetails[i] ?? false; });
  const company = state.value.sections.company;
  document.querySelector('#global-state').textContent = ['AVAILABLE','STALE'].includes(company.availability) ? `${company.data.state}${company.availability === 'STALE' ? ' · STALE' : ''}` : `Company ${company.availability}`;
  const incidents = state.value.sections.active_incidents;
  const banner = document.querySelector('#incident-banner');
  banner.hidden = incidents.availability === 'AVAILABLE' && incidents.data.items.length === 0;
  banner.dataset.critical = String(state.value.incident_override === true);
  banner.innerHTML = renderSection('active_incidents', incidents);
  document.querySelector('#incident-hero-content').innerHTML = renderSection('active_incidents', incidents);
  if (focusedDetail >= 0) document.querySelectorAll('#storage-card-root summary')[focusedDetail]?.focus({ preventScroll: true });
  if (activeId) document.getElementById(activeId)?.focus({ preventScroll: true });
  updateHero();
}
let inflight = false;
async function refresh() {
  if (inflight) return;
  inflight = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('/api/v1/mission-control/overview', { cache: 'no-store', headers: { accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error();
    // Bound streaming input before parsing, even if Content-Length is absent.
    const reader = response.body.getReader();
    const chunks = []; let length = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > MAX_BYTES) { await reader.cancel(); throw new Error(); } chunks.push(value); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!validToken(body.freshness_token)) throw new Error();
    if (state.accept(body)) { lastAccepted = performance.now(); draw(); status.textContent = 'Overview updated'; }
    else if (!state.value || performance.now() - lastAccepted > MAX_AGE_MS) throw new Error();
  } catch {
    state.markStale(); draw(); status.textContent = state.value ? 'STALE · Refresh failed. Showing last known values.' : 'UNAVAILABLE · Overview could not load.';
    // Only overview sections settle here; the protected-app card owns its own loading state.
    document.querySelectorAll('[data-section][aria-busy="true"]').forEach(root => { root.setAttribute('aria-busy','false'); root.innerHTML = renderSection(root.dataset.section, { availability: 'UNAVAILABLE' }); });
  } finally { clearTimeout(timeout); inflight = false; }
}
document.querySelector('#refresh-overview').addEventListener('click', refresh);
const navigation = document.querySelector('#sidebar');
const toggle = document.querySelector('#nav-toggle');
toggle.addEventListener('click', () => { const open = toggle.getAttribute('aria-expanded') !== 'true'; toggle.setAttribute('aria-expanded', String(open)); navigation.classList.toggle('nav-open', open); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && navigation.classList.contains('nav-open')) { navigation.classList.remove('nav-open'); toggle.setAttribute('aria-expanded','false'); toggle.focus(); } });
document.querySelector('#mobile-more').addEventListener('click', event => { event.preventDefault(); toggle.click(); if (toggle.getAttribute('aria-expanded') === 'true') navigation.querySelector('a').focus(); });
const localTime = document.querySelector('#local-time');
function drawLocalTime() { localTime.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
drawLocalTime();
updateHero();
await refresh();
setInterval(() => { drawLocalTime(); refresh(); }, 15_000);

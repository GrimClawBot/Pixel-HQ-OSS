import { renderStorageCard } from './storage-card-view.js';
export const escapeHtml = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const e = escapeHtml;
const LABELS = { company: 'Company state', storage: 'Storage', ai_compute: 'AI Compute', systems: 'Systems', facilities: 'Facilities', workforce: 'Company / Workforce', needs_you: 'Needs You', recent_work: 'Recent Work', recent_activity: 'Recent Activity', active_incidents: 'Incident state' };
const badge = s => `<span class="status-label">${e(s.availability)}</span>${s.source_mode ? `<span class="source-label">${e(s.source_mode)}</span>` : ''}`;
const meaningful = s => ['AVAILABLE','STALE'].includes(s?.availability);
function rows(items) {
  return `<ul class="record-list">${items.map(i => `<li data-state="${e(i.state)}"><div><strong>${e(i.title ?? i.id)}</strong><p>${e(i.summary ?? i.reason_code ?? '')}</p><small>${e(i.role ?? '')}${i.department ? ` · ${e(i.department)}` : ''}</small></div><div class="record-state"><span>${e(i.state)}</span>${i.occurred_at ? `<time datetime="${e(i.occurred_at)}">${e(new Date(i.occurred_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</time>` : ''}</div></li>`).join('')}</ul>`;
}
export function renderSection(name, section) {
  const s = section ?? { availability: 'UNKNOWN' };
  if (!meaningful(s)) return `<div class="section-state"><p>${e(LABELS[name])} · ${badge(s)}</p><p class="muted">${s.reason_code === 'NOT_YET_CONNECTED' ? 'NOT YET CONNECTED' : 'Pixel could not verify this source.'}</p></div>`;
  const d = s.data;
  let content = '';
  if (name === 'storage') content = renderStorageCard(d);
  else if (name === 'company') content = `<p class="company-state">${e(d.state)}</p><p>${e(d.summary)}</p>`;
  else if (name === 'workforce') content = `<dl class="metrics"><div><dt>Employees</dt><dd>${d.total}</dd></div><div><dt>Active lifecycle</dt><dd>${d.active}</dd></div><div><dt>Quarantined</dt><dd>${d.quarantined}</dd></div></dl><p class="muted">Observations: ${d.watch} WATCH · ${d.review} REVIEW</p><small>Employee identity is separate from model/runtime identity.</small>`;
  else if (name === 'active_incidents') content = d.items.length ? `<ul class="incident-list">${d.items.map(i => `<li><strong>${e(i.incident_class)} · ${e(i.severity)} · ${e(i.state)}</strong><p>${e(i.summary)} · ${i.affected_resource_count} affected resources</p><small>${e(i.id)}${i.phase ? ` · ${e(i.phase)}` : ''}</small></li>`).join('')}</ul>` : `<p>${s.availability === 'STALE' ? 'Incident state is stale. Current incidents are unknown.' : 'No active incidents'}</p>`;
  else if (name === 'facilities') content = `<dl class="metrics"><div><dt>Power</dt><dd>${e(d.power_state)}</dd></div><div><dt>Thermal</dt><dd>${e(d.thermal_state)}</dd></div></dl><p>${e(d.summary)}</p>`;
  else content = d.items.length ? rows(d.items) : `<p class="muted">${name === 'recent_work' ? 'No recent Relay work.' : name === 'needs_you' ? 'Nothing needs your attention.' : 'No recorded activity.'}</p>`;
  return `<div class="section-meta">${badge(s)}<time datetime="${e(s.observed_at)}">Observed ${e(new Date(s.observed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</time></div>${content}${d.truncated ? `<p class="muted">Showing ${d.items.length} of ${d.total_count} · truncated</p>` : ''}`;
}
export function renderSystems(section) {
  return ['CORE','INFRA','DEV','MEDIA'].map(id => {
    const item = meaningful(section) ? section.data.items.find(i => i.id === id) : null;
    return `<article class="card quick-card"><h3>${id}</h3>${item ? `<p>${e(item.state)}</p><small>${e(item.summary)}</small><div class="section-meta">${badge(section)}</div>` : `<p class="muted">UNAVAILABLE</p><small>NOT YET CONNECTED</small>`}</article>`;
  }).join('');
}

import { CONTRACT, MAX_BYTES, SECTIONS, isNewerToken, normalizeSection } from './overview-contract.js';
export class OverviewState {
  value = null;
  selected;
  constructor(preference = 'storage') { this.selected = preference === 'ai_compute' ? preference : 'storage'; }
  get hero() { return this.value?.incident_override === true ? 'incident' : this.selected; }
  select(name) { if (['storage','ai_compute'].includes(name)) this.selected = name; }
  accept(view) {
    if (view?.contract !== CONTRACT || view.availability === 'FAILED'
      || !isNewerToken(view.freshness_token, this.value?.freshness_token ?? null)
      || ![true,false,null].includes(view.incident_override)
      || typeof view.observed_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(view.observed_at) || !Number.isFinite(Date.parse(view.observed_at))
      || new Date(view.observed_at).toISOString() !== view.observed_at
      || !view.sections || Object.keys(view.sections).length !== SECTIONS.length
      || new TextEncoder().encode(JSON.stringify(view)).length > MAX_BYTES) return false;
    const sections = {};
    for (const name of SECTIONS) {
      const raw = view.sections[name];
      if (!raw || !['AVAILABLE','STALE','UNAVAILABLE','DENIED','FAILED','UNKNOWN'].includes(raw.availability)) return false;
      const safe = normalizeSection(name, raw, view.observed_at);
      if (['AVAILABLE','STALE'].includes(raw.availability) && safe.availability === 'FAILED') return false;
      sections[name] = safe;
      if (raw.reason_code === 'NOT_YET_CONNECTED') sections[name].reason_code = 'NOT_YET_CONNECTED';
    }
    this.value = { contract: CONTRACT, freshness_token: { epoch: view.freshness_token.epoch, sequence: view.freshness_token.sequence }, observed_at: view.observed_at, incident_override: view.incident_override, sections };
    return true;
  }
  markStale() {
    if (!this.value) return;
    for (const section of Object.values(this.value.sections)) if (section.availability === 'AVAILABLE') section.availability = 'STALE';
    if (this.value.incident_override !== true) this.value.incident_override = null;
  }
}

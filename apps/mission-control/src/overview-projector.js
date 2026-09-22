import { CONTRACT, SECTIONS, failure, normalizeSection, serializeOverview, validToken } from './overview-contract.js';

export class MissionControlOverviewProjector {
  #sources;
  #freshness;
  #clock;
  #inflight = null;
  constructor({ sources = {}, freshness = null, clock = () => new Date().toISOString() } = {}) {
    this.#sources = Object.fromEntries(SECTIONS.map(name => [name, sources[name] ?? null]));
    this.#freshness = freshness;
    this.#clock = clock;
  }
  // Overlapping HTTP requests share one in-flight projection, so a burst of
  // refreshes cannot repeat the same source reads or burn freshness sequence.
  project() {
    if (this.#inflight === null) {
      this.#inflight = this.#project().finally(() => { this.#inflight = null; });
    }
    return this.#inflight;
  }
  async #project() {
    let freshness_token;
    try {
      // Reserve order before asynchronous reads so an earlier read cannot win late.
      freshness_token = this.#freshness.next();
      if (!validToken(freshness_token)) throw new Error();
    } catch { return failure('FRESHNESS_STATE_UNAVAILABLE'); }
    let observed_at;
    try { observed_at = new Date(this.#clock()).toISOString(); } catch { return failure('SOURCE_INVALID'); }
    const sections = {};
    await Promise.all(SECTIONS.map(async name => {
      const source = this.#sources[name];
      if (source === null) { sections[name] = { availability: 'UNAVAILABLE', reason_code: 'NOT_YET_CONNECTED' }; return; }
      let timer;
      try {
        const value = await Promise.race([
          Promise.resolve().then(() => source.read()),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), 3000); }),
        ]);
        sections[name] = normalizeSection(name, value, new Date(this.#clock()).toISOString());
      } catch { sections[name] = { availability: 'FAILED', reason_code: 'SOURCE_READ_FAILED' }; }
      finally { clearTimeout(timer); }
    }));
    // The completion timestamp is re-read after the section reads so it bounds
    // them from above; the guarded read keeps a throwing or invalid clock on
    // the bounded fail-closed path instead of rejecting project().
    try { observed_at = new Date(this.#clock()).toISOString(); } catch { return failure('SOURCE_INVALID'); }
    const incidents = sections.active_incidents;
    const incident_override = ['AVAILABLE', 'STALE'].includes(incidents.availability)
      && incidents.data.items.some(i => ['SEV-0', 'SEV-1'].includes(i.severity))
      ? true : incidents.availability === 'AVAILABLE' ? false : null;
    return JSON.parse(serializeOverview({ contract: CONTRACT, freshness_token, observed_at, incident_override, sections }));
  }
}

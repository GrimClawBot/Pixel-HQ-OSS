// Shared wire validation. No service authority or browser-supplied policy lives here.
export const CONTRACT = 'pixel.mission-control-overview.v1';
export const MAX_BYTES = 65_536;
export const MAX_AGE_MS = 60_000;
export const SECTIONS = Object.freeze(['company', 'storage', 'systems', 'ai_compute', 'facilities', 'workforce', 'needs_you', 'recent_work', 'recent_activity', 'active_incidents']);
const STATES = ['AVAILABLE', 'STALE', 'UNAVAILABLE', 'DENIED', 'FAILED', 'UNKNOWN'];
const MODES = ['SIMULATED', 'SHADOW', 'LIVE'];
const U64 = 18446744073709551615n;
const METADATA = ['location', 'zone', 'pool', 'service', 'version', 'window', 'scope', 'category', 'unit'];
const COMPANY = ['NORMAL', 'NIGHT', 'HOLIDAY', 'MAINTENANCE', 'SECURITY_INCIDENT', 'INFRASTRUCTURE_OR_ENVIRONMENT_INCIDENT', 'SURVIVAL'];
const fail = (code = 'SOURCE_INVALID') => { throw new Error(code); };
const record = (v) => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(); return v; };
export function text(value, max) {
  if (typeof value !== 'string' || !value.isWellFormed()) fail();
  const normalized = value.normalize('NFC');
  if ([...normalized].length > max) fail('PROJECTION_BOUND_EXCEEDED');
  if (!normalized.trim()) fail();
  return normalized;
}
const code = (v, allowed) => { const s = text(v, 64); if (allowed && !allowed.includes(s)) fail(); return s; };
const counter = (v) => { if (!Number.isInteger(v) || v < 0 || v > 1_000_000) fail('PROJECTION_BOUND_EXCEEDED'); return v; };
const timestamp = (v) => { const s = text(v, 64); if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString() !== s) fail(); return s; };
function array(v, max, mapper) {
  if (!Array.isArray(v)) fail();
  if (v.length > max) fail('PROJECTION_BOUND_EXCEEDED');
  return Array.from(v, mapper); // holes are invalid items, never omitted
}
const refs = (v) => array(v, 16, (x) => text(x, 160));
function decimal(v) { return typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= U64; }
export function validToken(t) {
  return !!t && Object.keys(t).length === 2 && decimal(t.epoch) && decimal(t.sequence) && BigInt(t.epoch) > 0n && BigInt(t.sequence) > 0n;
}
export function isNewerToken(next, current) {
  if (!validToken(next)) return false;
  if (current === null) return true;
  if (!validToken(current)) return false;
  return BigInt(next.epoch) > BigInt(current.epoch)
    || (next.epoch === current.epoch && BigInt(next.sequence) > BigInt(current.sequence));
}
export function failure(reason_code) { return { contract: CONTRACT, availability: 'FAILED', reason_code }; }
export function serializeOverview(value) {
  const json = JSON.stringify(value);
  return new TextEncoder().encode(json).length <= MAX_BYTES ? json : JSON.stringify(failure('PROJECTION_TOO_LARGE'));
}
function metadata(data, out) {
  if (data.metadata === undefined) return out;
  const raw = record(data.metadata);
  const selected = METADATA.filter((key) => Object.hasOwn(raw, key));
  out.metadata = {};
  // Validate all allowlisted entries, including entries excluded by the map limit.
  for (const key of selected) {
    text(key, 64);
    const value = text(raw[key], 256);
    if (Object.keys(out.metadata).length < 8) out.metadata[key] = value;
  }
  out.metadata_truncated = selected.length > 8;
  return out;
}
function item(value, name) {
  const v = record(value);
  const out = { id: text(v.id, 160) };
  if (name === 'active_incidents') {
    out.incident_class = code(v.incident_class, ['SECURITY','INFRASTRUCTURE','POWER','THERMAL']);
    out.severity = code(v.severity, ['SEV-0','SEV-1','SEV-2','SEV-3']);
    out.state = code(v.state, ['OPEN']);
    out.summary = text(v.summary, 512);
    out.affected_resource_count = counter(v.affected_resource_count);
    if (v.phase !== undefined) out.phase = code(v.phase, ['DECLARE','CONTAIN','PRESERVE_EVIDENCE','DIAGNOSE','REMEDIATE','RECOVER','VERIFY','CLOSE','POST_INCIDENT_REVIEW']);
  } else if (name === 'systems' || name === 'ai_compute') {
    if (name === 'systems' && !['CORE','INFRA','DEV','MEDIA'].includes(out.id)) fail();
    out.state = code(v.state, ['NORMAL','DEGRADED','CRITICAL','OFFLINE','MAINTENANCE','AVAILABLE','WORKING','BUSY','IDLE','THROTTLED','UNKNOWN','STANDBY','PRESSURE']);
    out.summary = text(v.summary, 512);
  } else {
    out.title = text(v.title, 120);
    out.state = code(v.state, name === 'recent_work' ? ['SUBMITTED','ACCEPTED','RUNNING','COMPLETED','FAILED'] : undefined);
    out.occurred_at = timestamp(v.occurred_at);
    if (v.reason_code !== undefined) out.reason_code = code(v.reason_code);
    if (v.summary !== undefined) out.summary = text(v.summary, 512);
    if (v.role !== undefined) out.role = text(v.role, 120);
    if (v.department !== undefined) out.department = text(v.department, 120);
    if (name === 'needs_you') out.priority = counter(v.priority);
  }
  if (v.refs !== undefined) out.refs = refs(v.refs);
  return metadata(v, out);
}
function list(data, name) {
  const max = { recent_work: 12, recent_activity: 12, needs_you: 10, active_incidents: 8, systems: 4, ai_compute: 2 }[name];
  const truncatable = ['recent_work','recent_activity','needs_you'].includes(name);
  const items = array(data.items, truncatable ? 1_000_000 : max, (v) => item(v, name));
  if (new Set(items.map(v => v.id)).size !== items.length) fail();
  if (truncatable) items.sort((a, b) => (name === 'needs_you' ? a.priority - b.priority : Date.parse(b.occurred_at) - Date.parse(a.occurred_at)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Pre-bounded owning-service reads must declare total count and ordering.
  const total = data.total_count === undefined ? items.length : counter(data.total_count);
  if ((total > items.length && items.length !== max) || total < items.length || (total > items.length && (!truncatable || data.truncated !== true || data.order !== (name === 'needs_you' ? 'priority' : 'newest')))) fail();
  const out = { items: items.slice(0, max) };
  if (truncatable) { out.total_count = counter(total); out.truncated = total > max; if (out.truncated) out.order = name === 'needs_you' ? 'priority' : 'newest'; }
  return out;
}
function dataFor(name, value) {
  const d = record(value);
  let out;
  if (name === 'company') {
    out = { state: code(d.state, COMPANY), summary: text(d.summary, 512), refs: refs(d.refs) };
  } else if (name === 'workforce') {
    out = Object.fromEntries(['total','active','restricted','watch','review'].map(k => [k, counter(d[k])]));
    if (out.active + out.restricted > out.total || out.watch + out.review > out.total) fail();
  } else if (name === 'storage') {
    out = {};
    for (const k of ['device_id','role_id','trace_id']) out[k] = text(d[k], 160);
    out.display_name = text(d.display_name, 120);
    for (const k of ['source','event_name','schema_version']) out[k] = code(d[k]);
    // The v1 hero binds the one canonical storage role; a different identity needs a contract revision.
    if (out.role_id !== 'PIXEL-STORAGE-01' || !['simulator','live'].includes(out.source)) fail();
    out.health_state = code(d.health_state, ['ready','needs_attention']);
    out.state = code(d.state, ['Ready','Needs Attention']);
    // Health and owner-facing state must agree, so a malformed pair cannot render as Ready.
    if ((out.health_state === 'ready') !== (out.state === 'Ready')) fail();
    for (const k of ['summary','impact']) out[k] = text(d[k], 512);
    out.recommended_action = d.recommended_action === null ? null : text(d.recommended_action, 512);
    out.verified_at = timestamp(d.verified_at);
    out.storage = {};
    for (const k of ['capacity_bytes','used_bytes','available_bytes']) {
      const n = d.storage?.[k]; if (!Number.isSafeInteger(n) || n < 0) fail(); out.storage[k] = n;
    }
    if (out.storage.capacity_bytes <= 0 || out.storage.used_bytes + out.storage.available_bytes !== out.storage.capacity_bytes) fail();
    out.storage.protection_state = code(d.storage.protection_state);
    out.provenance = { adapter_id: text(d.provenance?.adapter_id, 160), scenario: text(d.provenance?.scenario, 120) };
    if (!/^[a-f0-9]{32}$/.test(out.trace_id)) fail();
  } else if (name === 'facilities') {
    out = { power_state: code(d.power_state), thermal_state: code(d.thermal_state), summary: text(d.summary, 512) };
  } else { out = list(d, name); }
  return metadata(d, out);
}
export function normalizeSection(name, value, now) {
  try {
    if (!SECTIONS.includes(name)) fail();
    const v = record(value);
    let availability = code(v.availability, STATES);
    if (!['AVAILABLE','STALE'].includes(availability)) {
      // Upstream freeform error text is never echoed.
      if (v.diagnostic !== undefined) text(v.diagnostic, 256);
      if (v.reason_code !== undefined) text(v.reason_code, 64);
      return { availability, reason_code: 'SOURCE_NOT_READY' };
    }
    const source_mode = code(v.source_mode, MODES);
    const observed_at = timestamp(v.observed_at);
    const age = Date.parse(timestamp(now)) - Date.parse(observed_at);
    if (age > MAX_AGE_MS || age < 0) availability = 'STALE';
    const data = dataFor(name, v.data);
    if (name === 'storage' && ((data.source === 'simulator') !== (source_mode === 'SIMULATED') || !['simulator','live'].includes(data.source))) fail();
    return { availability, source_mode, observed_at, data };
  } catch (error) {
    return { availability: 'FAILED', reason_code: error.message === 'PROJECTION_BOUND_EXCEEDED' ? error.message : 'SOURCE_INVALID' };
  }
}

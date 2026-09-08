const DECISION_FIELDS = new Set([
  'decision_id', 'event_name', 'schema_version', 'decided_at', 'environment',
  'trace_id', 'span_id', 'request_id', 'decision', 'reason_code', 'target',
  'owner', 'policy_id', 'provenance',
]);
const REASONS = new Set([
  'ACCESS_ALLOWED', 'IDENTITY_NOT_VERIFIED', 'DEVICE_NOT_ENROLLED', 'DEVICE_REVOKED',
  'DEVICE_UNTRUSTED', 'CERTIFICATE_NOT_VALID', 'RISK_NOT_ACCEPTABLE', 'APP_NOT_PERMITTED',
  'CLIENT_AUTHORITY_CLAIM_REJECTED', 'CLIENT_INTENT_INVALID',
  'IDENTITY_CONTEXT_UNAVAILABLE', 'DEVICE_TRUST_CONTEXT_UNAVAILABLE', 'ACCESS_CONTEXT_INVALID',
]);
const EARLY_DENIAL_REASONS = new Set([
  'CLIENT_AUTHORITY_CLAIM_REJECTED', 'CLIENT_INTENT_INVALID',
  'IDENTITY_CONTEXT_UNAVAILABLE', 'DEVICE_TRUST_CONTEXT_UNAVAILABLE', 'ACCESS_CONTEXT_INVALID',
]);
const ENVIRONMENTS = new Set(['dev', 'simulation', 'shadow', 'canary', 'production']);
const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_16 = /^[0-9a-f]{16}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactFields(value, fields) {
  return isRecord(value)
    && Object.keys(value).length === fields.size
    && Object.keys(value).every((field) => fields.has(field));
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value) {
  return hasText(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function isValidAccessDecisionView(value) {
  if (!hasExactFields(value, DECISION_FIELDS)) return false;
  if (value.event_name !== 'pixel.access.decision.v1' || value.schema_version !== '1.0.0') return false;
  if (!hasText(value.decision_id) || !isIsoTimestamp(value.decided_at) || !ENVIRONMENTS.has(value.environment)) return false;
  if (
    !HEX_32.test(value.trace_id)
    || /^0+$/.test(value.trace_id)
    || !HEX_16.test(value.span_id)
    || /^0+$/.test(value.span_id)
  ) return false;
  if (!['ALLOW', 'DENY'].includes(value.decision) || !REASONS.has(value.reason_code)) return false;
  if (value.decision === 'ALLOW' && value.reason_code !== 'ACCESS_ALLOWED') return false;
  if (value.decision === 'DENY' && value.reason_code === 'ACCESS_ALLOWED') return false;
  if (EARLY_DENIAL_REASONS.has(value.reason_code)) {
    if (value.request_id !== null || value.policy_id !== null) return false;
  } else if (!hasText(value.request_id) || !hasText(value.policy_id)) {
    return false;
  }
  if (
    !hasExactFields(value.target, new Set(['app_id', 'capability']))
    || value.target.app_id !== 'pixel-bench'
    || value.target.capability !== 'launch'
  ) return false;
  if (
    !hasExactFields(value.owner, new Set(['state', 'summary', 'impact']))
    || !hasText(value.owner.summary)
    || !hasText(value.owner.impact)
  ) return false;
  if (value.decision === 'ALLOW' && value.owner.state !== 'Ready') return false;
  if (value.decision === 'DENY' && value.owner.state !== 'Protected') return false;
  if (
    !hasExactFields(value.provenance, new Set(['access_gate_contract']))
    || value.provenance.access_gate_contract !== 'pixel.access-gate.v1'
  ) return false;
  return true;
}

export function renderAccessCard(decision) {
  if (!isValidAccessDecisionView(decision)) return renderAccessUnavailable();
  const allowed = decision.decision === 'ALLOW';
  const boundary = allowed
    ? '<p class="access-boundary" data-launch-state="authorized"><strong>Authorized launch boundary</strong><span>Pixel Bench is not installed in this Alpha milestone.</span></p>'
    : '<p class="access-boundary"><strong>Launch unavailable</strong><span>Pixel kept this protected app closed.</span></p>';

  return `<article class="access-card" data-state="${allowed ? 'ready' : 'protected'}" aria-labelledby="access-card-title">
  <header class="access-card__header">
    <div>
      <p class="access-card__role">Protected app</p>
      <h2 id="access-card-title">Pixel Bench</h2>
    </div>
    <span class="state-badge">${escapeHtml(decision.owner.state)}</span>
  </header>

  <p class="access-card__summary">${escapeHtml(decision.owner.summary)}</p>
  <p class="access-card__impact">${escapeHtml(decision.owner.impact)}</p>
  ${boundary}

  <details>
    <summary>Details</summary>
    <div class="disclosure-body">
      <p>Pixel evaluates current identity, device trust, and permission together before protected apps can open.</p>
    </div>
  </details>

  <details>
    <summary>Expert</summary>
    <div class="disclosure-body expert-data">
      <dl>
        <div><dt>Decision</dt><dd>${escapeHtml(decision.decision)}</dd></div>
        <div><dt>Reason</dt><dd>${escapeHtml(decision.reason_code)}</dd></div>
        <div><dt>Contract</dt><dd>${escapeHtml(decision.event_name)}</dd></div>
        <div><dt>Schema</dt><dd>${escapeHtml(decision.schema_version)}</dd></div>
        <div><dt>Environment</dt><dd>${escapeHtml(decision.environment)}</dd></div>
        <div><dt>Trace</dt><dd>${escapeHtml(decision.trace_id)}</dd></div>
      </dl>
      <a href="/api/v1/evidence/${escapeHtml(decision.trace_id)}">View structured evidence</a>
    </div>
  </details>
</article>`;
}

export function renderAccessUnavailable() {
  return `<article class="access-card access-card--unavailable" data-state="protected" aria-labelledby="access-card-title">
  <header class="access-card__header">
    <div>
      <p class="access-card__role">Protected app</p>
      <h2 id="access-card-title">Pixel Bench</h2>
    </div>
    <span class="state-badge">Protected</span>
  </header>
  <p class="access-card__summary">Pixel could not verify protected-app access.</p>
  <p class="access-card__impact">The app remains closed. Nothing was changed.</p>
</article>`;
}

export function renderAccessChecking() {
  return '<p class="loading-state">Checking protected-app access…</p>';
}

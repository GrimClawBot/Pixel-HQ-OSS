function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatTerabytes(bytes) {
  const terabytes = bytes / 1_000_000_000_000;
  return Number.isInteger(terabytes) ? String(terabytes) : terabytes.toFixed(1);
}

function formatPercent(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function displayTechnicalState(value) {
  return String(value)
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function renderStorageCard(view) {
  const availablePercent = (view.storage.available_bytes / view.storage.capacity_bytes) * 100;
  const usedPercent = 100 - availablePercent;
  const stateToken = view.health_state === 'needs_attention' ? 'needs_attention' : 'ready';
  const recommendedAction = view.recommended_action
    ? `<p class="recommended-action"><strong>Recommended:</strong> ${escapeHtml(view.recommended_action)}</p>`
    : '';

  return `<article class="storage-card" data-state="${stateToken}" aria-labelledby="storage-card-title">
  <header class="storage-card__header">
    <div>
      <p class="storage-card__role">Storage system</p>
      <h2 id="storage-card-title">${escapeHtml(view.display_name)}</h2>
    </div>
    <span class="state-badge">${escapeHtml(view.state)}</span>
  </header>

  <p class="storage-card__summary">${escapeHtml(view.summary)}</p>
  <p class="storage-card__impact">${escapeHtml(view.impact)}</p>

  <div class="capacity" aria-label="Storage capacity">
    <progress
      class="capacity__rail"
      aria-label="Storage capacity used"
      value="${formatPercent(usedPercent)}"
      max="100"
    >${formatPercent(usedPercent)}% used</progress>
    <p><strong>${formatTerabytes(view.storage.available_bytes)} TB available</strong> of ${formatTerabytes(view.storage.capacity_bytes)} TB</p>
    <span>${formatPercent(availablePercent)}% available</span>
  </div>

  <p class="verified">Verified <time datetime="${escapeHtml(view.verified_at)}">${escapeHtml(view.verified_at)}</time></p>

  <details>
    <summary>Details</summary>
    <div class="disclosure-body">
      <dl>
        <div><dt>Protection</dt><dd>${escapeHtml(displayTechnicalState(view.storage.protection_state))}</dd></div>
        <div><dt>Used</dt><dd>${formatTerabytes(view.storage.used_bytes)} TB</dd></div>
        <div><dt>Available</dt><dd>${formatTerabytes(view.storage.available_bytes)} TB</dd></div>
      </dl>
      ${recommendedAction}
    </div>
  </details>

  <details>
    <summary>Expert</summary>
    <div class="disclosure-body expert-data">
      <dl>
        <div><dt>Event</dt><dd>${escapeHtml(view.event_name)}</dd></div>
        <div><dt>Schema</dt><dd>${escapeHtml(view.schema_version)}</dd></div>
        <div><dt>Role</dt><dd>${escapeHtml(view.role_id)}</dd></div>
        <div><dt>Device</dt><dd>${escapeHtml(view.device_id)}</dd></div>
        <div><dt>Source</dt><dd>${escapeHtml(view.source)}</dd></div>
        <div><dt>Adapter</dt><dd>${escapeHtml(view.provenance.adapter_id)}</dd></div>
        <div><dt>Scenario</dt><dd>${escapeHtml(view.provenance.scenario)}</dd></div>
        <div><dt>Trace</dt><dd>${escapeHtml(view.trace_id)}</dd></div>
      </dl>
      <a href="/api/v1/evidence/${escapeHtml(view.trace_id)}">View structured evidence</a>
    </div>
  </details>
</article>`;
}

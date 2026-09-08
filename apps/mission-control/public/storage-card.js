import { renderStorageCard } from '/assets/storage-card-view.js';

const root = document.querySelector('#storage-card-root');

async function loadStorageCard() {
  try {
    const response = await fetch('/api/v1/devices/PIXEL-STORAGE-01', {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Storage request failed with status ${response.status}`);
    }
    const body = await response.json();
    root.innerHTML = renderStorageCard(body.data);
  } catch {
    root.innerHTML = `<section class="load-failure" role="alert">
      <h2>Storage status is unavailable</h2>
      <p>Mission Control could not verify storage. No action was taken.</p>
    </section>`;
  } finally {
    root.setAttribute('aria-busy', 'false');
  }
}

await loadStorageCard();

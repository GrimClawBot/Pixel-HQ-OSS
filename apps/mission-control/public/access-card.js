import { loadAccessCard } from '/assets/access-card-controller.js';

const root = document.querySelector('#access-card-root');
await loadAccessCard(root);

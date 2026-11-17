// Entry point: wire the scaffold-to-beam modal to its launch button(s).
import { ScaffoldModal } from './modal.js';

const root = document.getElementById('scaffold-modal');
if (root) {
  const modal = new ScaffoldModal(root);
  for (const btn of document.querySelectorAll('[data-open-scaffold]')) {
    btn.addEventListener('click', () => modal.open());
  }
  window.addEventListener('scafmetric:loads-imported', e => {
    const n = e.detail?.count ?? 0;
    for (const btn of document.querySelectorAll('[data-open-scaffold]')) {
      btn.dataset.imported = String(n);
      btn.setAttribute('title', n ? `${n} scaffold leg load${n > 1 ? 's' : ''} imported` : 'Import scaffold leg loads');
    }
  });
}

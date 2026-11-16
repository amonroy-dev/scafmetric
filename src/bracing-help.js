// Native dialog keeps focus inside the explanation while it is open. The
// spotlight only changes presentation; it never edits brace inputs or results.
export function initializeBracingHelp({
  section = document.querySelector('.bracing-section'),
  dialog = document.getElementById('bracing-help-dialog'),
  root = document
} = {}) {
  let highlightTimer;
  let trigger = null;

  function highlight() {
    if (!section) return;
    clearTimeout(highlightTimer);
    section.classList.remove('is-bracing-highlighted');
    // Restart the short emphasis animation when the same action is used again.
    void section.offsetWidth;
    section.classList.add('is-bracing-highlighted');
    highlightTimer = setTimeout(() => section.classList.remove('is-bracing-highlighted'), 8000);
  }

  function open(button) {
    if (!dialog || dialog.open) return;
    trigger = button;
    dialog.showModal();
    dialog.querySelector('.bracing-help-content')?.scrollTo(0, 0);
    document.body.classList.add('bracing-help-open');
  }

  root.addEventListener('click', event => {
    const button = event.target.closest('[data-open-bracing-help]');
    if (button) open(button);
  });
  dialog?.querySelector('[data-close-bracing-help]')?.addEventListener('click', () => dialog.close());
  dialog?.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  dialog?.addEventListener('close', () => {
    document.body.classList.remove('bracing-help-open');
    if (trigger?.isConnected) trigger.focus({preventScroll:true});
    trigger = null;
  });

  return {highlight, open};
}

// Progressive form navigation. The existing beam solver remains the source of
// truth; this module validates the visible inputs before unlocking each step.
export function initializeStepWizard({ form, readBracing, invalidate, drawSchematic }) {
 const steps = [...form.querySelectorAll('.wizard-step')];
 const after = [...form.querySelectorAll('[data-after-steps]')];
 const byId = id => document.getElementById(id);
 let unlocked = 1, noInteriorBracing = false;

 function error(step, message, field) {
  const output = step.querySelector('[data-step-error]');
  output.textContent = message; output.hidden = false;
  if (field) field.focus({preventScroll:true});
  return false;
 }
 function clearError(step) {
  const output = step.querySelector('[data-step-error]');
  output.hidden = true; output.textContent = '';
 }
 function check(index, show = true) {
  const step = steps[index - 1];
  if (!step) return false;
  const fail = (message, field) => show ? error(step, message, field) : false;
  if (show) clearError(step);
  if (index === 1) {
   const project = byId('project'), preparer = byId('preparer');
   if (!project.value.trim()) return fail('Enter the project name.', project);
   if (!preparer.value.trim()) return fail('Enter who prepared this analysis.', preparer);
  }
  if (index === 2) {
   const section = byId('section'), span = byId('span');
   if (!section.value) return fail('Select a beam size after the section library loads.', section);
   if (!span.value || !span.checkValidity() || Number(span.value) <= 0) return fail('Enter a valid span greater than zero.', span);
  }
  if (index === 3) {
   const span = Number(byId('span').value);
   for (const input of step.querySelectorAll('#load-rows input:not(:disabled)')) {
    if (!input.value || !input.checkValidity()) return fail(`Enter a valid nonnegative value for ${input.getAttribute('aria-label') || 'each load'}.`, input);
    if (input.classList.contains('point-location') && Number(input.value) > span) return fail('Point-load distance must be between the supports.', input);
   }
   const custom = byId('custom-safety-factor');
   if (!custom.disabled && (!custom.value || !custom.checkValidity())) return fail('Enter a custom safety factor of at least 1.', custom);
  }
  if (index === 4) {
   const span = Number(byId('span').value), entries = [...step.querySelectorAll('.brace-list input')];
   for (const input of entries) {
    if (!input.value || !input.checkValidity() || Number(input.value) > span) return fail('Enter each brace position between the supports, or remove the empty entry.', input);
   }
   if (!entries.length && !noInteriorBracing) return fail('Enter a brace position or choose No lateral bracing.');
   try { readBracing(); } catch (problem) { return fail(problem.message); }
  }
  return true;
 }
 function showStep(index, focus = true) {
  if (index < 1 || index > unlocked) return;
  const target = steps[index - 1];
  for (const step of steps) if (step !== target) step.open = false;
  target.hidden = false; target.open = true;
  if (focus) {
   const summary = target.querySelector('summary');
   summary.focus({preventScroll:true});
   summary.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block:'nearest'});
  }
 }
 function unlock(index) {
  unlocked = Math.max(unlocked, index);
  for (let i = 0; i < unlocked; i++) steps[i].hidden = false;
  if (unlocked >= 5) after.forEach(element => { element.hidden = false; });
 }
 function prerequisites(index) {
  for (let n = 1; n < index; n++) if (!check(n, false)) { showStep(n); check(n); return false; }
  return true;
 }
 function advance(index) {
  if (!prerequisites(index) || !check(index)) return;
  unlock(index + 1); showStep(index + 1);
 }

 for (const step of steps) {
  const index = Number(step.dataset.step);
  step.querySelector('[data-step-next]')?.addEventListener('click', () => advance(index));
  step.querySelector('summary').addEventListener('click', event => {
   if (!step.open && !prerequisites(index)) event.preventDefault();
  });
  step.addEventListener('toggle', () => {
   if (step.open && !step.hidden) for (const other of steps) if (other !== step) other.open = false;
  });
  step.addEventListener('input', () => clearError(step));
 }
 for (const input of [byId('project'), byId('preparer')]) input.addEventListener('input', () => {
  if (check(1, false)) unlock(2);
 });
 const skip = form.querySelector('[data-no-bracing]');
 skip.addEventListener('click', () => {
  if (!prerequisites(4)) return;
  for (const editor of form.querySelectorAll('.brace-editor')) {
   editor.querySelector('.brace-list').replaceChildren();
   byId(`${editor.dataset.flange}-brace-locations`).value = '';
  }
  noInteriorBracing = true;
  byId('brace-cleared').textContent = 'Interior braces cleared.';
  invalidate(); drawSchematic();
  advance(4);
 });
 form.addEventListener('click', event => {
  if (event.target.closest('.brace-editor .next-brace, .brace-editor .brace-list button')) noInteriorBracing = false;
 });
 // Validate all steps explicitly, then the remaining enabled form controls. This
 // avoids native validation trying to focus an invalid control in a closed step.
 form.noValidate = true;
 function canSubmit() {
  if (unlocked < 5) { showStep(unlocked); return false; }
  for (let n = 1; n <= 4; n++) {
   if (!check(n, false)) { showStep(n); check(n); return false; }
  }
  for (const field of form.querySelectorAll('input:not(:disabled), select:not(:disabled)')) {
   if (field.checkValidity()) continue;
   const step = field.closest('.wizard-step');
   if (step) { showStep(Number(step.dataset.step), false); }
   for (let parent = field.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
   field.focus(); field.reportValidity(); return false;
  }
  return true;
 }
 return { canSubmit, showStep };
}

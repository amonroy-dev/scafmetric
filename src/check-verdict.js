// Percent of allowable for display, rounded up to one decimal so a failing ratio
// never reads as 100.0% or less. Pass/fail decisions always use the raw ratio.
// toFixed strips binary noise first, so 0.51 shows as 51.0%, not 51.1%.
export function formatUtilization(ratio) {
  if (!Number.isFinite(ratio)) return '—';
  const tenths = Math.ceil(Number((ratio * 1000).toFixed(6)));
  if (ratio > 1 && tenths <= 1000) return '>100.0%';
  return `${(tenths / 10).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

// Summarize every supported check: ASD bending and shear, any selected comparison,
// and the service deflection limit. Deflection is evaluated even when the strength
// checks are not, so a beam that sags too much always fails. A missing result can
// never produce a pass. Items keep the verdict order; `label` is the short meter name.
export function summarizeChecks(check = {}) {
  const items = [];
  const unavailable = [];
  const add = (name, label, result, value, kind = 'strength') => {
    if (result?.status !== 'evaluated' || !Number.isFinite(value)) unavailable.push(`${name}: ${result?.reason || 'Not evaluated.'}`);
    else items.push({ name, label, utilization: value, kind });
  };
  let strengthDetail = null;
  if (check.status === 'evaluated') {
    add('Service bending', 'Bending', check.flexure, check.flexure?.governingSegment?.utilization);
    add('Service shear', 'Shear', check.shear, check.shear?.utilization);
    if (check.extra || ['four', 'custom'].includes(check.comparisonSelection)) {
      const four = check.comparisonSelection === 'four';
      const name = four ? '4:1 comparison' : 'Custom comparison', label = four ? '4:1' : 'Custom SF';
      add(`${name} bending`, `${label} bending`, check.extra?.bending, check.extra?.bending?.governingSegment?.utilization);
      add(`${name} shear`, `${label} shear`, check.extra?.shearing, check.extra?.shearing?.utilization);
    }
  } else {
    strengthDetail = check.status === 'not_requested' ? 'Turn on the steel member checks and confirm the required assumptions, then calculate again.'
      : check.status === 'not_evaluated' ? check.reason || 'Complete the required steel-check assumptions, then calculate again.'
      : 'The steel checks could not be evaluated.';
    unavailable.push(strengthDetail);
  }
  const deflection = check.deflection;
  add('Service deflection', deflection?.limitRatio ? `Deflection · L/${deflection.limitRatio}` : 'Deflection', deflection, deflection?.utilization, 'deflection');

  const failed = items.filter(item => item.utilization > 1).sort((a, b) => b.utilization - a.utilization);
  if (failed.length) return { status: 'fail', governing: failed[0], failed, items, unavailable };
  if (unavailable.length) return { status: 'incomplete', detail: strengthDetail ?? unavailable.join(' '), failed, items, unavailable };
  if (!items.length) return { status: 'incomplete', detail: 'The steel checks could not be evaluated.', failed, items, unavailable };
  return { status: 'pass', governing: items.reduce((a, b) => b.utilization > a.utilization ? b : a), failed, items, unavailable };
}

// Percent text that names what the ratio is measured against.
export function describeUtilization(item, deflection) {
  const of = item.kind === 'deflection' ? `of the L/${deflection?.limitRatio ?? '—'} deflection limit` : 'of allowable';
  return `${item.name} · ${formatUtilization(item.utilization)} ${of}`;
}

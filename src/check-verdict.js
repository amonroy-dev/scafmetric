// Summarize only the supported ASD checks, including a selected comparison.
// A missing result can never produce a pass.
export function summarizeChecks(check) {
  if (check.status === 'not_requested') return {status:'incomplete', detail:'Turn on the steel member checks and confirm the required assumptions, then calculate again.'};
  if (check.status === 'not_evaluated') return {status:'incomplete', detail:check.reason || 'Complete the required steel-check assumptions, then calculate again.'};
  if (check.status !== 'evaluated') return {status:'incomplete', detail:'The steel checks could not be evaluated.'};

  const items = [];
  const unavailable = [];
  const add = (name, result, flexure = false) => {
    const value = flexure ? result?.governingSegment?.utilization : result?.utilization;
    if (result?.status !== 'evaluated' || !Number.isFinite(value)) unavailable.push(`${name}: ${result?.reason || 'Not evaluated.'}`);
    else items.push({name, utilization:value});
  };
  add('Service bending', check.flexure, true);
  add('Service shear', check.shear);
  if (check.extra) {
    const name = check.comparisonSelection === 'four' ? '4:1 comparison' : 'Custom comparison';
    add(`${name} bending`, check.extra.bending, true);
    add(`${name} shear`, check.extra.shearing);
  }
  const failed = items.filter(item => item.utilization > 1).sort((a,b) => b.utilization-a.utilization);
  if (failed.length) return {status:'fail', governing:failed[0], unavailable};
  if (unavailable.length) return {status:'incomplete', detail:unavailable.join(' '), unavailable};
  if (!items.length) return {status:'incomplete', detail:'The steel checks could not be evaluated.'};
  return {status:'pass', governing:items.reduce((a,b) => b.utilization>a.utilization ? b : a), unavailable};
}

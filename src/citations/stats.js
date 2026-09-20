// Fixed-epoch summaries plus explicitly qualified sequential inference.
//
// Wilson intervals describe each precommitted fixed-n epoch. Supplemental
// confidence sequences and likelihood ratios have their own assumptions and
// multiplicity budgets; they do not authorize optional sample collection.
// Bayesian run-length outputs are exploratory model posteriors, not calibrated
// alarm probabilities or verified dates of a real-world change.
export const WILSON_Z = 1.959963985; // two-sided 95%

/** Wilson score interval for k successes in n rendered runs. null when n is 0. */
export function wilsonInterval(k, n, z = WILSON_Z) {
  if (!validCounts(k, n) || n === 0 || !Number.isFinite(z) || z <= 0) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** Laplace-smoothed rate. (k+1)/(n+2) never reports 0 or 1 from finite data. */
export function smoothedRate(k, n) {
  if (!validCounts(k, n) || n === 0) return null;
  return (k + 1) / (n + 2);
}

/**
 * Classify one epoch against the previous epoch's baseline.
 *
 * declined/grown require the intervals to separate entirely; overlap is reported as
 * not_distinguishable — the honest label, because claiming "stable" would assert
 * knowledge the noise forbids. Thin data is refused, not interpreted.
 */
export function classifyEpoch(current, baseline, limits) {
  const minN = limits?.minSamplesForInterpretation ?? 10;
  const maxWidth = limits?.maxCiWidth ?? 0.5;
  if (current.n < minN) return 'insufficient_data';
  const ci = wilsonInterval(current.k, current.n);
  if (!ci) return 'insufficient_data';
  if (ci[1] - ci[0] > maxWidth) return 'insufficient_data';
  if (!baseline || baseline.n < minN) return 'first_epoch';
  const baseCi = wilsonInterval(baseline.k, baseline.n);
  if (!baseCi) return 'first_epoch';
  if (ci[1] < baseCi[0]) return 'declined';
  if (ci[0] > baseCi[1]) return 'grown';
  return 'not_distinguishable';
}

/**
 * Tally rendered runs. Unknowns are excluded from the denominator and carried
 * alongside, because an errored run is a missing observation, not a miss — the same
 * honest-denominator rule the link verifier applies to blocked fetches.
 */
export function tallyOutcomes(outcomes) {
  let k = 0, n = 0, unknowns = 0, mentioned = 0;
  for (const outcome of outcomes) {
    if (outcome === 'unknown' || outcome === null) { unknowns += 1; continue; }
    if (!['cited','verified','mentioned','not_cited'].includes(outcome)) throw new RangeError('Unknown citation outcome');
    n += 1;
    if (outcome === 'cited' || outcome === 'verified') k += 1;
    if (outcome === 'mentioned') mentioned += 1;
  }
  return { k, n, unknowns, mentioned };
}

/**
 * The glossary, as a function. The tool never says a citation was "removed" or
 * "lost"; it states both rates with their intervals and sample sizes.
 */
export function describeChange(current, baseline) {
  if (current.rate === null || current.ci_low === null || current.ci_high === null) return 'insufficient data: citation rate unknown (no interpretable observations)';
  const fmt = (e) => `${e.rate.toFixed(2)} (${e.ci_low.toFixed(2)}–${e.ci_high.toFixed(2)}, n=${e.n})`;
  if (!baseline) return `first epoch: citation rate ${fmt(current)}`;
  return `citation rate moved from ${fmt(baseline)} to ${fmt(current)} between epochs`;
}

// Sequential contracts and derivations are recorded in DP-0045/statistics-spec.md.
function validCounts(k, n) { return Number.isSafeInteger(k) && Number.isSafeInteger(n) && n >= 0 && k >= 0 && k <= n; }
function probability(value, name) { if (!Number.isFinite(value) || value <= 0 || value >= 1) throw new RangeError(`${name} must lie strictly between zero and one`); }
function multiplicity(alpha, comparisons) {
  probability(alpha, 'alpha');
  if (!Number.isSafeInteger(comparisons) || comparisons < 1) throw new RangeError('comparisons must be a positive preregistered count');
  return alpha / comparisons;
}
function binary(value) {
  if (value === null || value === 'unknown') return null;
  if (value === 1 || value === 'cited' || value === 'verified') return 1;
  if (value === 0 || value === 'not_cited' || value === 'mentioned') return 0;
  throw new RangeError('Observations must be binary citation outcomes or explicit unknowns');
}
function boundedInterval(k, n, error) {
  const radius = Math.sqrt(Math.log(2 / error) / (2 * n));
  return [Math.max(0, k / n - radius), Math.min(1, k / n + radius)];
}

/** Anytime interval via Hoeffding plus alpha/[m*n*(n+1)] spending.
 * Independent Bernoulli observations with a constant mean are sufficient.
 * Unknown exclusion additionally assumes missingness does not select outcomes.
 * Union bounds cover every observed n and all m preregistered comparisons.
 * This conservative construction is not the variance-adaptive confseq algorithm.
 */
export function confidenceSequence(observations, { alpha = 0.05, comparisons = 1 } = {}) {
  const perCell = multiplicity(alpha, comparisons);
  let k = 0, n = 0, unknowns = 0, lower = 0, upper = 1;
  return observations.map(value => {
    const x = binary(value);
    if (x === null) unknowns += 1;
    else {
      n += 1; k += x;
      const current = boundedInterval(k, n, perCell / (n * (n + 1)));
      lower = Math.max(lower, current[0]); upper = Math.min(upper, current[1]);
    }
    return { k, n, unknowns, interval: n === 0 || lower > upper ? null : [lower, upper],
      status: n === 0 ? 'insufficient_data' : lower > upper ? 'model_conflict' : 'available',
      method: 'hoeffding-alpha-spending', alpha, comparisons };
  });
}

/** Conservative fixed-n two-epoch difference interval. Both means receive half
 * the per-comparison alpha. Repeated testing of many epoch pairs requires the
 * total comparison count to be allocated in advance; no perpetual-alert claim.
 */
export function compareEpochs(current, baseline, { alpha = 0.05, comparisons = 1 } = {}) {
  const error = multiplicity(alpha, comparisons) / 2;
  if (!current || !baseline || !validCounts(current.k,current.n) || !validCounts(baseline.k,baseline.n) || current.n === 0 || baseline.n === 0)
    return { verdict: 'insufficient_data', interval: null, alpha, comparisons, method: 'fixed-n-hoeffding-difference' };
  const now = boundedInterval(current.k,current.n,error), prior = boundedInterval(baseline.k,baseline.n,error);
  const interval = [Math.max(-1,now[0]-prior[1]),Math.min(1,now[1]-prior[0])];
  return { verdict: interval[1] < 0 ? 'declined' : interval[0] > 0 ? 'grown' : 'not_distinguishable', interval, alpha, comparisons, method: 'fixed-n-hoeffding-difference' };
}

/** Simple-hypothesis sequential likelihood ratio with conservative Ville
 * boundaries. p0/p1 must be selected before inspecting these observations;
 * inserting an estimated prior-epoch rate does not retain the stated guarantees.
 * A lower boundary supports p0 against p1; it does not establish stability.
 */
export function sprtDecline(k, n, baselineRate, declineRate = baselineRate * 0.5, alpha = 0.05, beta = 0.10) {
  if (!validCounts(k,n)) throw new RangeError('SPRT requires valid integer counts');
  probability(baselineRate,'baselineRate'); probability(declineRate,'declineRate'); probability(alpha,'alpha'); probability(beta,'beta');
  if (declineRate >= baselineRate) throw new RangeError('declineRate must be below the prespecified baselineRate');
  const evidence = k * Math.log(declineRate / baselineRate) + (n-k) * Math.log((1-declineRate)/(1-baselineRate));
  return { decision: evidence >= Math.log(1/alpha) ? 'decline' : evidence <= Math.log(beta) ? 'baseline_supported' : 'continue', evidence,
    upper: Math.log(1/alpha), lower: Math.log(beta), method: 'simple-hypothesis-likelihood-ratio' };
}

/** Exact Beta-Bernoulli BOCD filtering with constant hazard. The posterior is
 * conditional on this piecewise-iid model and the chosen prior/hazard. It is not
 * a confidence sequence, an FDR-controlled detector or ground-truth dating.
 * Indices refer to the supplied observation array, preserving unknown gaps.
 */
export function changepointPosterior(observations, { hazard = 0.01, priorAlpha = 1, priorBeta = 1, minSegment = 3, posteriorThreshold = 0.8, minEffect = 0.3 } = {}) {
  probability(hazard,'hazard'); probability(posteriorThreshold,'posteriorThreshold');
  if (![priorAlpha,priorBeta].every(x=>Number.isFinite(x)&&x>0) || !Number.isInteger(minSegment) || minSegment<2 || !Number.isFinite(minEffect) || minEffect<0 || minEffect>1)
    throw new RangeError('Invalid changepoint prior or selection parameters');
  const known = [];
  observations.forEach((value,index) => { const x=binary(value); if(x!==null)known.push({x,index}); });
  if(known.length>2000)throw new RangeError('Exact BOCD is bounded to 2000 known observations; select a disclosed analysis window');
  let posterior=[1], successes=[0], counts=[0];
  for(const {x} of known){
    const next=new Array(posterior.length+1).fill(0);
    for(let r=0;r<posterior.length;r++){
      const predictive=(x?priorAlpha+successes[r]:priorBeta+counts[r]-successes[r])/(priorAlpha+priorBeta+counts[r]);
      const joint=posterior[r]*predictive;
      next[0]+=joint*hazard;next[r+1]=joint*(1-hazard);
    }
    const sum=next.reduce((a,b)=>a+b,0);posterior=next.map(value=>value/sum);
    successes=[0,...successes.map(value=>value+x)];counts=[0,...counts.map(value=>value+1)];
  }
  const n=known.length, candidates=[];
  for(let r=minSegment;r<=n-minSegment;r++)candidates.push({split:n-r,index:known[n-r].index,probability:posterior[r]});
  const changeProbability=candidates.reduce((sum,row)=>sum+row.probability,0);
  const best=candidates.reduce((best,row)=>!best||row.probability>best.probability?row:best,null);
  let candidate=null;
  if(best && changeProbability>=posteriorThreshold){
    const before=known.slice(0,best.split),after=known.slice(best.split);
    const delta=smoothedRate(after.reduce((sum,row)=>sum+row.x,0),after.length)-smoothedRate(before.reduce((sum,row)=>sum+row.x,0),before.length);
    if(Math.abs(delta)>=minEffect && best.probability > posterior[n])candidate={index:best.index,known_split:best.split,delta};
  }
  // A conditional posterior location interval, never a frequentist date CI.
  let locationInterval=null;
  if(candidate && changeProbability>0){
    let sum=0,low=null,high=null;
    for(const row of candidates.slice().sort((a,b)=>a.index-b.index)){
      sum+=row.probability/changeProbability;
      if(low===null && sum>=0.025)low=row.index;
      if(high===null && sum>=0.975)high=row.index;
    }
    locationInterval=[low,high??candidates[0].index];
  }
  return { method:'beta-bernoulli-bocd', interpretation:'exploratory', n, unknowns:observations.length-n, hazard,
    run_length_posterior:posterior, candidate, location_interval:locationInterval, interior_change_probability:changeProbability,
    no_change_probability:posterior[n]??1 };
}

/** Compatibility helper: an exploratory boundary index, never an exact date. */
export function detectChangepoint(observations, options = {}) { return changepointPosterior(observations,options).candidate?.index ?? null; }

/** Descriptive Laplace rates over original-position windows. Unknowns occupy
 * time positions but contribute neither success nor denominator. */
export function rollingRate(observations, windowSize = 5) {
  if(!Number.isSafeInteger(windowSize)||windowSize<1)throw new RangeError('windowSize must be a positive integer');
  const values=observations.map(binary),rates=[];let k=0,n=0;
  for(let i=0;i<values.length;i++){
    if(values[i]!==null){n++;k+=values[i];}
    if(i>=windowSize && values[i-windowSize]!==null){n--;k-=values[i-windowSize];}
    rates.push(smoothedRate(k,n));
  }
  return rates;
}

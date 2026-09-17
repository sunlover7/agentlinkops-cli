// The statistics: closed-form and boring on purpose.
//
// Wilson intervals over fixed-n epochs. No bootstrap, no resampling, no early
// stopping — the IQRush finding that bootstrap CIs can be non-monotone in n is why
// the epoch size is committed before the epoch starts. Anything cleverer (confidence
// sequences, SPRT, changepoint dating) is a v2 design decision with its own gate,
// recorded in DP-0031's contract, and does not ship until it is validated against
// published data.
export const WILSON_Z = 1.959963985; // two-sided 95%

/** Wilson score interval for k successes in n rendered runs. null when n is 0. */
export function wilsonInterval(k, n, z = WILSON_Z) {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0 || k < 0 || k > n) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** Laplace-smoothed rate. (k+1)/(n+2) never reports 0 or 1 from finite data. */
export function smoothedRate(k, n) {
  if (n <= 0) return null;
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
    if (outcome === 'unknown') { unknowns += 1; continue; }
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
  const fmt = (e) => `${e.rate.toFixed(2)} (${e.ci_low.toFixed(2)}–${e.ci_high.toFixed(2)}, n=${e.n})`;
  if (!baseline) return `first epoch: citation rate ${fmt(current)}`;
  return `citation rate moved from ${fmt(baseline)} to ${fmt(current)} between epochs`;
}

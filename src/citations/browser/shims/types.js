// Shim for @oneglanse/types runtime exports used outside the excluded
// orchestration files. resolveAppMode upstream picks self-host vs cloud app
// modes; we always run the local (self-host) shape.
export function resolveAppMode() {
  return 'selfhost';
}

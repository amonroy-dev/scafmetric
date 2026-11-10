/** Section catalogue W is weight per foot in lb/ft. Return kip/ft. */
export function beamSelfWeight(section) {
  if (!section || !Number.isFinite(section.W) || section.W <= 0) {
    throw new Error('The selected section needs a valid weight per foot.');
  }
  return section.W / 1000;
}

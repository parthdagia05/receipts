/**
 * The Receipts mark, as data.
 *
 * One definition drives the React component and the favicon. The favicon is
 * generated from this file by `npm run favicon`, so the two cannot drift: edit
 * the shards here, re-run the script, and both update together.
 *
 * The mark is a shattered square. Eight irregular facets meet at four jittered
 * interior points, separated by the dark ground showing through as outlines.
 * Purple carries the brand, with yellow, pink and green as the accents that
 * keep it from reading as a single-hue gradient.
 */

export const MARK_SIZE = 32;
export const MARK_RADIUS = 6;

/** The ground, which also shows through the gaps as the shard outlines. */
export const MARK_GROUND = '#14131a';
export const MARK_STROKE = '#14131a';
export const MARK_STROKE_WIDTH = 1.3;

export interface Shard {
  readonly points: string;
  readonly fill: string;
}

export const MARK_SHARDS: readonly Shard[] = [
  { points: '0,0 14,0 8,6 0,11', fill: '#C9B8FF' }, // lavender, top-left
  { points: '14,0 32,0 32,6 21,12 8,6', fill: '#E0C64A' }, // yellow, top band
  { points: '0,11 8,6 14,19 0,20', fill: '#7C4DEE' }, // purple, left
  { points: '8,6 21,12 26,24 14,19', fill: '#ED97C0' }, // pink, centre
  { points: '21,12 32,6 32,19 26,24', fill: '#A78BFA' }, // lavender, right
  { points: '0,20 14,19 10,32 0,32', fill: '#7DAF68' }, // green, bottom-left
  { points: '14,19 26,24 24,32 10,32', fill: '#5B2FC4' }, // deep purple, bottom
  { points: '26,24 32,19 32,32 24,32', fill: '#8B5CF6' }, // purple, corner
];

/** The mark as a standalone SVG document, used for the favicon. */
export function markSvg(): string {
  const shards = MARK_SHARDS.map(
    (shard) => `    <polygon points="${shard.points}" fill="${shard.fill}" />`,
  ).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_SIZE} ${MARK_SIZE}">
  <clipPath id="c"><rect width="${MARK_SIZE}" height="${MARK_SIZE}" rx="${MARK_RADIUS}" /></clipPath>
  <g clip-path="url(#c)" stroke="${MARK_STROKE}" stroke-width="${MARK_STROKE_WIDTH}" stroke-linejoin="round">
    <rect width="${MARK_SIZE}" height="${MARK_SIZE}" fill="${MARK_GROUND}" stroke="none" />
${shards}
  </g>
</svg>
`;
}

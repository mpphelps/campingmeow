/**
 * Layered park-poster banner, in the flat screen-print style of the national
 * park print series — a small number of solid color fields stacked into depth,
 * no gradients doing the heavy lifting, no photographic detail.
 *
 * Deliberately a fixed palette rather than theme tokens: a print doesn't
 * restyle itself, and this is the one place the brand gets to be loud. It sits
 * behind the page title, so everything here is decorative and aria-hidden.
 */

const SKY = "#F2E4CC";
const SUN = "#E2703A";
const RIDGE_FAR = "#8FA9A0";
const RIDGE_MID = "#5B8266";
const RIDGE_NEAR = "#31543F";
const FOREST = "#1E3A2B";

/** Conifers along the foreground band — varied so it doesn't read as a pattern. */
const TREES = [
  [40, 46], [92, 34], [140, 52], [196, 38], [244, 44], [300, 30], [352, 48],
  [408, 36], [462, 42], [518, 52], [574, 34], [628, 46], [684, 38], [740, 50],
  [796, 32], [850, 44], [906, 40], [962, 52], [1018, 36], [1074, 46], [1132, 38],
  [1186, 48],
] as const;

export function ParkBanner({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1200 320"
      preserveAspectRatio="xMidYMax slice"
      role="presentation"
      aria-hidden="true"
      className={className}
    >
      <rect width="1200" height="320" fill={SKY} />

      {/* Sun low on the horizon, clipped by the ridges stacked over it. */}
      <circle cx="946" cy="150" r="58" fill={SUN} />
      {/* Screen-print banding across the sun — the printed-poster tell. */}
      <rect x="888" y="126" width="116" height="6" fill={SKY} opacity="0.75" />
      <rect x="888" y="150" width="116" height="5" fill={SKY} opacity="0.5" />

      <path
        d="M0,214 L120,186 L210,206 L330,166 L470,208 L600,178 L720,210 L840,182 L960,212 L1080,190 L1200,214 L1200,320 L0,320 Z"
        fill={RIDGE_FAR}
      />
      <path
        d="M0,246 L150,216 L280,242 L420,208 L560,240 L700,214 L860,244 L1000,218 L1130,242 L1200,230 L1200,320 L0,320 Z"
        fill={RIDGE_MID}
      />
      <path
        d="M0,276 L180,254 L340,278 L520,250 L700,280 L880,256 L1050,280 L1200,264 L1200,320 L0,320 Z"
        fill={RIDGE_NEAR}
      />

      {/* Foreground treeline. */}
      <rect x="0" y="292" width="1200" height="28" fill={FOREST} />
      {TREES.map(([x, h]) => (
        <polygon key={x} points={`${x},${292 - h} ${x - 13},292 ${x + 13},292`} fill={FOREST} />
      ))}
    </svg>
  );
}

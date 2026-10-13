/**
 * The Structure map's render, drawn the way transit maps and process
 * drawings are. Each structural route is one line of its own color from its
 * named origin (the names of the entrances it starts from, in full, stacked
 * one per line in the left margin, or "via" the first component it reaches,
 * marked derived) through its stations in order, left to right, never back
 * to a column it has left; routes that pass the same component meet at its
 * station and run side by side at fixed offsets, never merged. Every segment
 * is horizontal, vertical, or at 45 degrees. A route that stays in a column
 * drops straight down (or up) to the next station when it is the neighbour,
 * else turns in the column's lane. A core dependency is a rail along the
 * foot, labelled once, with the interface identifiers of its stubs drawn
 * once on it; each caller's stub runs to the rail and meets it, joining the
 * column's other stubs to that rail on one shared drop. A chokepoint or a
 * crossing is an interface identifier drawn on the pipe where it stands, one
 * button each, a crossing with a dashed trust boundary through it; its
 * meaning is in the inspector. A component interface on no route is drawn
 * faint, and only when a selection reaches it, unless an identifier stands
 * on it.
 *
 * At rest nothing is selected and every route is drawn: the whole system in
 * view, unless something is broken, when the broken component opens
 * selected. Red means broken and nothing else; the selection is a neutral
 * halo and weight, a color no route wears; attention that is not breakage
 * (nothing enforced, no traced control, not covered) is amber.
 *
 * Motion (the owner's rule): only the direction of work moves, and only on
 * what is selected. A selected route carries a slow, faint procession of
 * dashes from its entrance to its end, caller to callee, at one constant
 * speed, for as long as the selection holds; a selected component's lines
 * flow into it from its callers and out of it to its callees, one hop after
 * it lights; an identifier ticks each time a dash passes it. Clearing the
 * selection stops everything; broken marks never move. With reduced motion nothing animates and
 * small chevrons along the selected lines point caller to callee instead.
 *
 * Every piece of text has a priority and is placed only where it overlaps no
 * text and no station: station names first, then the named origins and rail
 * labels, the caption, identifiers, defect marks, and column captions. Lower
 * priority text is dropped, never overlapped, never truncated. Every
 * coordinate is computed here from the model on each render; no position is
 * stored or read.
 */

import { componentId, invariantId, latestOf, plural, relianceOf, type RelianceSite } from "./derive.ts";
import { candidateRulesOf, groupLine, notDetectedOf } from "./entrance-coverage.ts";
import { html, join, raw, slug, type Markup } from "./html.ts";
import { renderEnforcement, renderRefutation } from "./invariants-view.ts";
import type { LatestEntry, ShellState, StructurePreview } from "./model.ts";
import {
  CONTROL_WORDS,
  CORE_RULE,
  DEFAULT_RULE,
  NO_CONTROL_NEEDED,
  NO_TRACED_CONTROL,
  FLOW_CHANGE_ID,
  FLOW_HEALTH_KINDS,
  FLOW_NONE_ID,
  ROUTE_RULE,
  flowBoundaryId,
  flowBrokenId,
  flowHealthId,
  flowHealthMembers,
  flowLabelLines,
  flowName,
  flowOf,
  flowSelected,
  originLines,
  routeName,
  trustInWords,
  flowSelection,
  worstState,
  type FlowChokepoint,
  type FlowCrossing,
  type FlowEdge,
  type FlowEntrance,
  type FlowHealthKind,
  type FlowInvariantRef,
  type FlowLevel,
  type FlowModel,
  type FlowNode,
  type FlowRoute,
  type FlowSelection,
  type FlowState,
  flowBoundsText,
  unreadLanguagesText,
  flowPartialText,
} from "./structure-flow.ts";
import { textWidth } from "./structure-measure.ts";

/** The page's own system family: the map is UI, set in the face the inspector and the page use. */
const FLOW_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
/** Code-ish text on the map (a folder, an interface identifier) is set in IBM Plex Mono, embedded in the page, with a monospace fallback. */
const FLOW_MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';
/**
 * The map's type scale: three sizes and two weights, each with one role.
 * 13 medium: a component's name. 12 regular: the map's caption. 11 regular:
 * a component's role, a column caption, a rail's label, and, in Plex Mono,
 * a folder and an interface identifier (the page embeds Plex Mono's regular
 * weight only). 11 medium: the text in a token (a route's named origin, a
 * mark). Medium (500), never semibold:
 * the owner found semibold on the map too heavy. Numerals stay proportional
 * on the map. The measure's metrics are the system face's semibold for any
 * weight from medium up (the wider, so medium is never undershot) and Plex
 * Mono's fixed advance for mono text.
 */
const TYPE_NAME = 13;
const TYPE_LABEL = 12;
const TYPE_SMALL = 11;
const FLOW_WEIGHT = "500";
const FLOW_PAD = 16;
const FLOW_TOP = 58;
/** A row's height, unless a station's text needs a taller box: then the box and a gap of FLOW_ROW_GAP. */
const FLOW_ROW_H = 88;
const FLOW_ROW_GAP = 20;
/** The tallest its tracks make a station: they close up rather than grow past it. Its text may make it taller. */
const FLOW_BOX_MAX_H = 68;
/** A station holds at least four lines: its name, two of its role, its folder; a third role line adds one line. */
const FLOW_BOX_MIN_H = 64;
const FLOW_ROLE_LINE = 13;
/** The most lines a component's role wraps to on its box. */
const FLOW_ROLE_LINES = 3;
/** The width a component's role wraps at, unless its name or folder is wider; widened toward FLOW_ROLE_MAX_W only when the role would otherwise be cut mid-phrase. */
const FLOW_ROLE_W = 140;
const FLOW_ROLE_MAX_W = 220;
/**
 * The flow: its speed along a line, the length of each faint dash, and the
 * distance from one dash to the next. Slow enough to follow with the eye and
 * constant while the selection holds, so the reader has time to reason about
 * direction; one cycle is FLOW_PULSE_PERIOD / FLOW_PULSE_SPEED seconds.
 */
export const FLOW_PULSE_SPEED = 48;
const FLOW_PULSE_SEG = 12;
export const FLOW_PULSE_PERIOD = 96;
/** The delay per hop of a component's ripple, by the number of component interfaces from it. */
export const FLOW_HOP_DELAY = 0.1;
/** The fixed offset between parallel tracks. */
const FLOW_TRACK = 6;
const FLOW_CHAMFER = 8;
const FLOW_RAIL_GAP = 34;
/** The fixed offset between the drops of different rails beside one column. */
const FLOW_DROP_GAP = 5;
/** A gap between columns is never narrower than this. */
const FLOW_GAP_MIN = 96;
/** Named origins: the size of a name, the height of its line, the gap between routes, the terminus dot. */
const FLOW_NAME_SIZE = TYPE_SMALL;
const FLOW_NAME_LINE = 14;
const FLOW_NAME_GAP = 10;
/** The colored token behind a route's named origin: horizontal and vertical padding. */
const FLOW_TOKEN_PAD_X = 6;
const FLOW_TOKEN_PAD_Y = 3;
const FLOW_DOT_R = 5;
/**
 * The cut corners (the owner's ruling d-a5c6442d: glass, with Expanse's
 * token shapes): a station's and a token's top-left and bottom-right corners
 * are chamfered, a station's by FLOW_BOX_CUT and a token's by FLOW_TOKEN_CUT.
 */
const FLOW_BOX_CUT = 8;
const FLOW_TOKEN_CUT = 6;
/**
 * Pointer and stack (the owner's ruling d-e3abc2c8): an origin token's right
 * edge, where its route leaves into the system, is a point FLOW_TOKEN_POINT
 * deep (at most half the token's height), so a token reads "work enters here"
 * and never as a station, which keeps its flat edge; the route's line leaves
 * from the point's tip. A token that stands for several entrances is a stack
 * of up to FLOW_STACK_CARDS glass cards (one per entrance: two for two, three
 * for three or more), each card behind offset up and left by FLOW_STACK_DX
 * and FLOW_STACK_DY, into the token column's left pad and the gap above the
 * token, never toward its trust tag or its line. The gap above a token
 * (FLOW_NAME_GAP + FLOW_TRUST_ROOM, less the trust tag of the route above, its
 * gap and the token's padding: 6.5 px) is free to take but for
 * FLOW_STACK_CLEAR, so a three-card stack fits it and the map is no taller and
 * no wider; a stack that would rise further reserves the difference above its
 * token in the layout.
 */
const FLOW_TOKEN_POINT = 9;
const FLOW_STACK_CARDS = 3;
const FLOW_STACK_DX = 3;
const FLOW_STACK_DY = 2.5;
const FLOW_STACK_CLEAR = 1.5;
/**
 * The trust tag hangs beneath its token, right-aligned to the edge the route
 * leaves by: the room a route with one keeps below its token, its gap from
 * the token, and its hit box's padding.
 */
const FLOW_TRUST_ROOM = 12;
const FLOW_TRUST_GAP = 1.5;
const FLOW_TRUST_PAD = 3;
/** What a derived trust's tag falls back to when its level and label do not fit the margin. */
const FLOW_DERIVED_TAG = "derived";

/**
 * Route colors, light and dark: hues that never read as red, orange or
 * amber (red is broken, amber is attention, and the selection wears no
 * color at all); identity is also the name, never color alone. A route's
 * token is a tint of its color (FLOW_TOKEN_TINT) with its text in the map's
 * token ink, and the check measures that ink against every tint, light and
 * dark. (The colors were darkened for white text when tokens were solid; they
 * stay, so a line keeps its color.)
 */
export const FLOW_ROUTE_COLORS: [string, string][] = [
  ["#2874d0", "#1d73db"],
  ["#007c89", "#00808d"],
  ["#2e7d32", "#2f7d33"],
  ["#6a3fb5", "#7162e3"],
  ["#983a9e", "#a0409f"],
  ["#5a7414", "#5b7515"],
  ["#77594a", "#80604d"],
  ["#4053a8", "#5b6cc9"],
];
/** Rails: quiet, desaturated, and never brighter than a route. */
export const FLOW_RAIL_COLORS: [string, string][] = [
  ["#5f6b7a", "#7f8b9b"],
  ["#62705f", "#7f8e7b"],
  ["#6f6478", "#8f8398"],
  ["#56707a", "#76909a"],
];
/** The route past the eighth, drawn neutral and still named. */
export const FLOW_NEUTRAL_ROUTE: [string, string] = ["#6b7588", "#69758c"];

/**
 * An origin token, light and dark: the opaque base its fill tints (a
 * station's own fill), how much of the route's color the fill takes, how much
 * of it the border takes (the rest white in the dark, the color itself in the
 * light), and the ink of its text.
 */
export const FLOW_TOKEN_BASE: [string, string] = ["#ffffff", "#172036"];
export const FLOW_TOKEN_TINT: [number, number] = [0.12, 0.26];
export const FLOW_TOKEN_INK: [string, string] = ["#141a29", "#f3f6ff"];

/** WCAG relative luminance of a #rrggbb color. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** The WCAG contrast of two #rrggbb colors. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `share` of `a` mixed into `b`, channel by channel in sRGB, as CSS color-mix(in srgb) does. */
export function mixHex(a: string, b: string, share: number): string {
  const ch = (hex: string, i: number): number => parseInt(hex.slice(i, i + 2), 16);
  return `#${[1, 3, 5].map((i) => Math.round(ch(a, i) * share + ch(b, i) * (1 - share)).toString(16).padStart(2, "0")).join("")}`;
}

/** A token's fill and border for a route color, light (0) or dark (1): what the map paints and what the check measures. */
export function tokenPaint(color: [string, string], theme: 0 | 1): { fill: string; edge: string } {
  return { fill: mixHex(color[theme], FLOW_TOKEN_BASE[theme], FLOW_TOKEN_TINT[theme]), edge: theme === 0 ? color[0] : mixHex(color[1], "#ffffff", 0.7) };
}

function routeVars(): string {
  const vars = (theme: 0 | 1): string =>
    [
      ...FLOW_ROUTE_COLORS.map((c, i) => `--flow-route-${i}: ${c[theme]}; --flow-token-${i}: ${tokenPaint(c, theme).fill}; --flow-token-edge-${i}: ${tokenPaint(c, theme).edge};`),
      `--flow-token-neutral: ${tokenPaint(FLOW_NEUTRAL_ROUTE, theme).fill}; --flow-token-edge-neutral: ${tokenPaint(FLOW_NEUTRAL_ROUTE, theme).edge};`,
      ...FLOW_RAIL_COLORS.map((c, i) => `--flow-rail-${i}: ${c[theme]};`),
    ].join(" ");
  return `.flow-svg { ${vars(0)} }\n@media (prefers-color-scheme: dark) { .flow-svg { ${vars(1)} } }`;
}

/** A box with its top-left and bottom-right corners cut by `cut`: a station's or a token's outline. */
export function chamfer(box: FlowBox, cut: number): string {
  const { x, y, w, h } = box;
  const c = Math.min(cut, w / 4, h / 4);
  const pts: Point[] = [[x + c, y], [x + w, y], [x + w, y + h - c], [x + w - c, y + h], [x, y + h], [x, y + c]];
  return `M ${pts.map(([a, b]) => `${r1(a)} ${r1(b)}`).join(" L ")} Z`;
}

/** An origin token's card: `box` with its top-left corner cut and its right edge a point `depth` deep, tip at mid-height. */
function pointerPoints(box: FlowBox, depth: number): Point[] {
  const { x, y, w, h } = box;
  const c = Math.min(FLOW_TOKEN_CUT, w / 4, h / 4);
  return [[x + c, y], [x + w, y], [x + w + depth, y + h / 2], [x + w, y + h], [x, y + h], [x, y + c]];
}

function polygonD(pts: readonly Point[]): string {
  return `M ${pts.map(([a, b]) => `${r1(a)} ${r1(b)}`).join(" L ")} Z`;
}

/** How many cards an origin token stacks: one per entrance it stands for, up to three; a derived route stands for none, one card. */
export function tokenCards(route: Pick<FlowRoute, "names" | "derived">): number {
  return route.derived ? 1 : Math.max(1, Math.min(FLOW_STACK_CARDS, route.names.length));
}

/** The convex hull of points, counter-clockwise in screen coordinates (y down): monotone chain. */
function convexHull(points: readonly Point[]): Point[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Point, a: Point, b: Point): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Point[]): Point[] => {
    const out: Point[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half([...pts].reverse())];
}

/** A convex polygon grown outward by `d`: each edge moved out along its normal, corners mitered. */
function growConvex(pts: readonly Point[], d: number): Point[] {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) area += pts[i]![0] * pts[(i + 1) % n]![1] - pts[(i + 1) % n]![0] * pts[i]![1];
  const sign = area > 0 ? 1 : -1;
  const normal = (a: Point, b: Point): Point => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(sign * (b[1] - a[1])) / len, (-sign * (b[0] - a[0])) / len];
  };
  return pts.map((p, i) => {
    const n1 = normal(pts[(i - 1 + n) % n]!, p);
    const n2 = normal(p, pts[(i + 1) % n]!);
    const k = d / (1 + n1[0] * n2[0] + n1[1] * n2[1]);
    return [p[0] + (n1[0] + n2[0]) * k, p[1] + (n1[1] + n2[1]) * k] as Point;
  });
}

/**
 * The map's look (the owner's ruling d-a5c6442d): glass, with Expanse's token
 * shapes and styles. The canvas is a pane of the page's glass; stations and
 * origin tokens are opaque cut-corner cards on it, drawn with 1px hairlines
 * that stay 1px however wide the map is drawn (a station's in teal, an
 * entrance's heavier and brighter, a token's in its route's color over a tint
 * of it), each lifted by a soft shadow. Text never sits on anything
 * translucent: a token's ink is measured against its own tint. Red is broken
 * only, drawn darker where it is filled so white text on it reaches 4.5:1;
 * amber is attention; the selection is the ink, which no route wears.
 */
const FLOW_SVG_STYLE = `
.flow-svg {
  --flow-surface: #f7f9fc;
  --flow-glass: rgba(255, 255, 255, 0.62);
  --flow-ink: #141a29;
  --flow-role: #2c3547;
  --flow-muted: #4f5a70;
  --flow-node: #ffffff;
  --flow-node-border: rgba(15, 118, 110, 0.55);
  --flow-node-entry: #0f766e;
  --flow-quiet: #97a3bb;
  --flow-defect: #c32836;
  --flow-defect-fill: #c32836;
  --flow-defect-ink: #b3261e;
  --flow-proposed: #8b5e19;
  --flow-tag: #ffffff;
  --flow-hatch: #9aa5bd;
  --flow-boundary: #5c677d;
  --flow-select: #141a29;
  --flow-halo: rgba(20, 26, 41, 0.16);
  --flow-attention: #945400;
  --flow-verified: #1f3a5f;
  --flow-token-ink: ${FLOW_TOKEN_INK[0]};
  --flow-shadow: rgba(30, 41, 82, 0.14);
  --flow-neutral-route: ${FLOW_NEUTRAL_ROUTE[0]};
}
.flow-svg .flow-surface { fill: var(--flow-glass); }
.flow-svg text { font-family: ${FLOW_FONT}; fill: var(--flow-ink); }
.flow-svg text.flow-mono { font-family: ${FLOW_MONO}; }
.flow-svg .flow-caption { fill: var(--flow-muted); }
.flow-svg .flow-colcap { fill: var(--flow-muted); }
.flow-svg .flow-box { fill: var(--flow-node); stroke: var(--flow-node-border); stroke-width: 1px; vector-effect: non-scaling-stroke; stroke-linejoin: miter; filter: drop-shadow(0 4px 7px var(--flow-shadow)); }
.flow-svg .flow-station.flow-entry .flow-box { stroke: var(--flow-node-entry); stroke-width: 2px; }
.flow-svg .flow-station.flow-unconnected .flow-box { fill: var(--flow-surface); stroke-dasharray: 4 4; }
.flow-svg .flow-mass rect { fill: var(--flow-surface); stroke: var(--flow-quiet); stroke-width: 1px; vector-effect: non-scaling-stroke; stroke-dasharray: 4 4; }
.flow-svg .flow-station.flow-broken .flow-box { stroke: var(--flow-defect); }
.flow-svg .flow-station-folder { fill: var(--flow-muted); }
.flow-svg .flow-station-role { fill: var(--flow-role); }
.flow-svg .flow-state-bar { stroke: none; }
.flow-svg .flow-state-verified { fill: var(--flow-verified); }
.flow-svg .flow-state-requirement { fill: url(#flow-hatch); stroke: var(--flow-verified); stroke-width: 0.8; }
.flow-svg .flow-state-broken { fill: var(--flow-defect); }
.flow-svg .flow-state-bar.flow-state-hollow { fill: var(--flow-node); stroke: var(--flow-attention); stroke-width: 1.2; }
.flow-svg .flow-route { fill: none; stroke-width: 3.5; stroke-linejoin: round; stroke-linecap: butt; }
.flow-svg .flow-origin-token { stroke-width: 1px; vector-effect: non-scaling-stroke; stroke-linejoin: miter; filter: drop-shadow(0 3px 5px var(--flow-shadow)); }
.flow-svg .flow-origin-card { stroke-width: 1px; vector-effect: non-scaling-stroke; stroke-linejoin: miter; fill-opacity: 0.9; stroke-opacity: 0.6; filter: drop-shadow(0 2px 3px var(--flow-shadow)); }
.flow-svg .flow-origin-card-2 { fill-opacity: 0.8; stroke-opacity: 0.42; }
.flow-svg .flow-token-halo { fill: none; stroke: var(--flow-halo); stroke-width: 5px; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
.flow-svg .flow-derived .flow-origin-token, .flow-svg .flow-derived .flow-origin-card { stroke-dasharray: 4 3; }
.flow-svg .flow-origin, .flow-svg .flow-origin-more { fill: var(--flow-token-ink); }
.flow-svg .flow-trust .flow-trust-box { fill: transparent; stroke: none; }
.flow-svg .flow-trust text { fill: var(--flow-muted); }
.flow-svg .flow-trust.flow-trust-untraced text { fill: var(--flow-attention); }
.flow-svg .flow-trust[data-structure-select]:hover text { text-decoration: underline; }
.flow-svg .flow-trust:focus .flow-trust-box { stroke: var(--flow-select); stroke-width: 1px; vector-effect: non-scaling-stroke; }
.flow-svg .flow-faint { fill: none; stroke: var(--flow-quiet); stroke-width: 1.4; stroke-dasharray: 5 4; }
.flow-svg .flow-bearing-line { fill: none; stroke: var(--flow-quiet); stroke-width: 1.6; }
.flow-svg .flow-broken-line { stroke: var(--flow-defect); stroke-width: 2; stroke-dasharray: 6 3; }
.flow-svg .flow-rail-line { stroke-width: 6; stroke-linecap: round; }
.flow-svg .flow-stub { fill: none; stroke-width: 1.6; stroke-linejoin: round; }
.flow-svg .flow-joint { stroke: none; }
.flow-svg .flow-rail-label { fill: var(--flow-ink); }
.flow-svg .flow-station-name { fill: var(--flow-ink); }
.flow-svg .flow-tag .flow-tag-shape { stroke-width: 1px; vector-effect: non-scaling-stroke; }
.flow-svg .flow-tag-verified .flow-tag-shape { fill: var(--flow-verified); stroke: var(--flow-verified); }
.flow-svg .flow-tag-verified text { fill: #ffffff; }
.flow-svg .flow-tag-requirement .flow-tag-shape { fill: url(#flow-tag-hatch); stroke: var(--flow-verified); }
.flow-svg .flow-tag-requirement text { fill: var(--flow-ink); paint-order: stroke; stroke: var(--flow-tag); stroke-width: 2.5px; stroke-linejoin: round; }
.flow-svg .flow-tag-broken .flow-tag-shape { fill: var(--flow-defect-fill); stroke: var(--flow-defect); }
.flow-svg .flow-tag-broken text { fill: #ffffff; }
.flow-svg .flow-tag-mark .flow-tag-shape { fill: var(--flow-tag); stroke: var(--flow-defect); stroke-width: 1.5px; }
.flow-svg .flow-tag-mark text { fill: var(--flow-defect-ink); }
.flow-svg .flow-tag-boundary .flow-tag-shape { fill: var(--flow-tag); stroke: var(--flow-muted); }
.flow-svg .flow-tag-boundary text { fill: var(--flow-ink); }
.flow-svg .flow-tag-tick .flow-tag-shape { fill: transparent; stroke: none; }
.flow-svg .flow-tag-attention .flow-tag-shape { fill: var(--flow-tag); stroke: var(--flow-attention); }
.flow-svg .flow-tag-attention text { fill: var(--flow-attention); }
.flow-svg .flow-tag-repeat .flow-tag-shape { stroke-width: 1.5px; }
.flow-svg .flow-tag.is-selected .flow-tag-halo { fill: none; stroke: var(--flow-halo); stroke-width: 5px; vector-effect: non-scaling-stroke; }
.flow-svg .flow-tag:focus .flow-tag-shape, .flow-svg .flow-tag.is-selected .flow-tag-shape { stroke: var(--flow-select); stroke-width: 2px; }
.flow-svg .flow-boundary { stroke: var(--flow-boundary); stroke-width: 2; stroke-dasharray: 3 2; }
.flow-svg .flow-caption, .flow-svg .flow-colcap, .flow-svg .flow-rail-label, .flow-svg .flow-trust-text { paint-order: stroke; stroke: var(--flow-surface); stroke-width: 3px; stroke-linejoin: round; }
.flow-svg .structure-edge.structure-proposed { fill: none; stroke: var(--flow-proposed); stroke-width: 2; stroke-dasharray: 9 6; }
.flow-svg .structure-proposed-word { fill: var(--flow-proposed); }
.flow-svg [data-structure-select], .flow-svg [data-structure-expand] { cursor: pointer; }
.flow-svg [data-structure-select]:focus { outline: none; }
.flow-svg .flow-halo { fill: none; stroke: var(--flow-halo); stroke-width: 6px; vector-effect: non-scaling-stroke; }
.flow-svg .flow-station:focus .flow-box, .flow-svg .flow-station.is-selected .flow-box { stroke: var(--flow-select); stroke-width: 2px; }
.flow-svg .flow-station.is-lit .flow-box, .flow-svg .flow-station.is-caller .flow-box { stroke: var(--flow-select); stroke-width: 1.5px; }
.flow-svg .flow-station.is-callee .flow-box { stroke: var(--flow-select); stroke-width: 1.5px; stroke-dasharray: 5 3; }
.flow-svg .flow-tag.is-lit .flow-tag-shape { stroke: var(--flow-select); stroke-width: 1.5px; }
.flow-svg .flow-faint.is-lit, .flow-svg .flow-bearing-line.is-lit { stroke: var(--flow-select); stroke-opacity: 0.85; }
.flow-svg .flow-faint.is-in, .flow-svg .flow-bearing-line.is-in { stroke-dasharray: none; stroke-width: 1.8; }
.flow-svg .flow-faint.is-out, .flow-svg .flow-bearing-line.is-out { stroke-dasharray: 5 3; stroke-width: 1.6; }
.flow-svg .flow-route-group.is-lit .flow-route { stroke-width: 5; }
.flow-svg .flow-route-group.is-dim .flow-route { opacity: 0.16; }
.flow-svg .flow-route-group.is-dim .flow-route { stroke-width: 2; }
.flow-svg .flow-route-group.is-dim .flow-origin-token, .flow-svg .flow-route-group.is-dim .flow-origin-card { opacity: 0.8; filter: none; }
.flow-svg .is-dim { opacity: 0.16; }
.flow-svg .flow-route-group.is-dim { opacity: 1; }
.flow-svg .flow-station.is-dim { opacity: 1; }
.flow-svg .flow-station.is-dim .flow-box { stroke-opacity: 0.2; filter: none; }
.flow-svg .flow-station.is-dim text, .flow-svg .flow-station.is-dim .flow-state-bar { opacity: 0.25; }
.flow-svg .flow-tag.is-dim { opacity: 0.3; }
.flow-svg .flow-tag.flow-tag-tick .flow-tag-shape { fill: transparent; stroke: none; }
.flow-svg .flow-pulse { fill: none; stroke-linecap: round; stroke-width: 2.5; opacity: 0.7; pointer-events: none; animation-name: flow-pulse; animation-timing-function: linear; animation-iteration-count: infinite; animation-fill-mode: backwards; }
.flow-svg .flow-tick { animation-name: flow-tick; animation-timing-function: ease-out; animation-iteration-count: infinite; }
.flow-svg .flow-station.is-reach .flow-box { animation: flow-reach 0.35s ease-out both; }
.flow-svg .flow-chevron { display: none; fill: none; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
@keyframes flow-pulse { from { stroke-dashoffset: 0; } to { stroke-dashoffset: var(--pulse-end); } }
@keyframes flow-tick { 0% { filter: brightness(1.35) drop-shadow(0 0 2px var(--flow-halo)); } 18%, 100% { filter: none; } }
@keyframes flow-reach { from { stroke-opacity: 0.2; } to { stroke-opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .flow-svg .flow-pulse { display: none; animation: none; }
  .flow-svg .flow-tick, .flow-svg .flow-station.is-reach .flow-box { animation: none; }
  .flow-svg .flow-chevron { display: inline; }
}
@media (prefers-color-scheme: dark) {
  .flow-svg {
    --flow-surface: #121a2c;
    --flow-glass: rgba(18, 26, 44, 0.8);
    --flow-ink: #f3f6ff;
    --flow-role: #dde3f0;
    --flow-muted: #aab5cc;
    --flow-node: #1b2438;
    --flow-node-border: rgba(94, 214, 196, 0.5);
    --flow-node-entry: #7ff0de;
    --flow-quiet: #6f7c96;
    --flow-defect: #ff5c63;
    --flow-defect-fill: #c4262e;
    --flow-defect-ink: #ff8f8f;
    --flow-proposed: #f2bd68;
    --flow-tag: #121a2c;
    --flow-hatch: #6f7c96;
    --flow-boundary: #b5bfd3;
    --flow-select: #f3f6ff;
    --flow-halo: rgba(243, 246, 255, 0.24);
    --flow-attention: #f0b04a;
    --flow-verified: #c9d6f2;
    --flow-token-ink: ${FLOW_TOKEN_INK[1]};
    --flow-shadow: rgba(0, 0, 0, 0.5);
    --flow-neutral-route: ${FLOW_NEUTRAL_ROUTE[1]};
  }
  .flow-svg .flow-tag-verified text { fill: #111827; }
}`;

/* --------------------------------------------------------------- layout */

export interface FlowBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A station: a component's box, its seat (left edge and row center) a function of its column and rows. */
export interface FlowStation extends FlowBox {
  folder: string;
  seat: { x: number; y: number };
}

type Point = [number, number];

/** One drawn line: its points (every segment 0, 45 or 90 degrees), and the legs identifiers may stand on. */
interface FlowPolyline {
  points: Point[];
  legs: { a: Point; b: Point }[];
}

interface FlowRouteDraw {
  route: FlowRoute;
  color: string;
  path: Point[];
  /** The dot the line starts from, and each name line beside it. */
  terminus: Point;
  /** Per interface id along the route: the legs of its segment. */
  segments: Map<string, FlowPolyline>;
  /** The line from its origin token toward its first station: where work enters, and where an entrance's own chokepoint stands. */
  entry: { a: Point; b: Point };
}

interface FlowLineDraw {
  edge: FlowEdge;
  kind: "bearing" | "faint";
  line: FlowPolyline;
}

/** A stub: from its caller's station to the rail, meeting it; a column's stubs to one rail share their drop. */
interface FlowStubDraw {
  edge: FlowEdge;
  rail: number;
  points: Point[];
  /** Where it joins the shared drop, and where the drop meets the rail. */
  joints: Point[];
}

interface FlowRailDraw {
  folder: string;
  index: number;
  y: number;
  x0: number;
  x1: number;
}

/** A piece of canvas text, placed or dropped by priority. */
export interface FlowText {
  key: string;
  text: string;
  x: number;
  y: number;
  size: number;
  bold: boolean;
  align: "start" | "middle" | "end";
  cls: string;
  priority: number;
  within?: string;
  /** Set in IBM Plex Mono: a folder or an interface identifier. */
  mono?: boolean;
}

/**
 * One token on the map: an interface identifier (a button on its pipe, on an
 * entrance line, or once on a rail for a core dependency's stubs; drawn in
 * full once, and as a dot wherever it stands again), a bypass mark or a
 * count on a pipe, or a component's broken, boundary or not-covered mark,
 * attached to its box. (A route's trust, and its no-traced-control mark, is the
 * tag beneath its origin token, not one of these.)
 */
export interface FlowTagDraw {
  /** The identifier text (C3, X7), a bypass mark, a count of identifiers that did not fit, or a component mark's words. */
  text: string;
  kind: "identifier" | "bypass" | "more" | "broken" | "boundary" | "uncovered";
  /** For an identifier: whether it is drawn in full elsewhere, so here it is a dot that selects the same identifier. */
  repeat: boolean;
  /** For an identifier: a crossing's (X, pointed ends) or a plain chokepoint's (C, rounded). */
  shape: "chokepoint" | "crossing" | undefined;
  /** The state it is drawn in: an identifier's or boundary mark's verdict; a bypass or broken mark is broken. */
  state: FlowState | "mark";
  /** The route whose entrance line it stands on, for an identifier where work enters. */
  route: string | undefined;
  /** The component a broken or boundary mark is attached to. */
  node: string | undefined;
  /** The chokepoint it selects, for an identifier. */
  chokepoint: string | undefined;
  /** The invariant it names, for the accessible name. */
  name: string;
  /** The pipe it stands on, or the rail. */
  edge: FlowEdge | undefined;
  rail: string | undefined;
  edges: string[];
  broken: boolean;
  box: FlowBox;
  boundary: { x1: number; y1: number; x2: number; y2: number } | undefined;
}

/**
 * A route's origin token (pointer and stack, d-e3abc2c8): its front card's
 * body (the box its names sit in, the point not included), the point's depth
 * past the body's right edge, its tip (where the route's line starts), and
 * every card's outline, back to front, the front card last.
 */
export interface FlowTokenDraw {
  route: string;
  box: FlowBox;
  depth: number;
  tip: Point;
  cards: Point[][];
}

export interface FlowLayout {
  width: number;
  height: number;
  stations: Map<string, FlowStation>;
  rails: FlowRailDraw[];
  routes: FlowRouteDraw[];
  /** Each route's origin token, measured with its point and its stack. */
  tokens: FlowTokenDraw[];
  lines: FlowLineDraw[];
  stubs: FlowStubDraw[];
  tags: FlowTagDraw[];
  /** Each entrance route's trust tag, beneath its origin token and right-aligned to it: its hit box, and the levels its entrances carry in (none: unknown). */
  trustTags: { route: string; box: FlowBox; levels: string[] }[];
  texts: FlowText[];
  /** Text a priority dropped: what did not fit, by key. */
  dropped: string[];
  mass: FlowBox | undefined;
}

/**
 * What a route's trust tag says: "no traced control" when it is untrusted and
 * no control is traced on it (decisions d-7d36881b, d-ba18b0fd, d-127ab8e4),
 * else its trust: a declared level alone, a derived one marked derived, or
 * unknown.
 */
export function trustTagWords(route: Pick<FlowRoute, "trust" | "trustSource" | "noTracedControl" | "noControl">): string {
  return route.noControl ? NO_CONTROL_NEEDED : route.noTracedControl ? NO_TRACED_CONTROL : trustInWords(route);
}

/** The tag's tooltip: what its words mean for this route. */
function trustTagTitle(route: FlowRoute, levels: readonly FlowLevel[]): string {
  if (route.noControl) return `No control needed: its ${route.entrances.length === 1 ? "entrance declares" : "entrances declare"} control: none, with a reason; trust in: ${trustInWords(route)}. A stated claim, not a traced control.`;
  const outside = route.trust.filter((name) => levels.find((level) => level.name === name)?.outside === true);
  if (route.noTracedControl) {
    const why = route.trust.length === 0
      ? "its trust is unknown, so it is treated as untrusted"
      : outside.length > 0
        ? `${outside.join(", ")} comes from outside the system's control`
        : `${route.trust.join(", ")} is no declared trust level`;
    return `No traced control: no verified chokepoint or totality oracle was traced on this route, and ${why}. Not a demonstrated bypass.`;
  }
  if (route.trust.length === 0) return "Trust in: unknown, neither declared nor derived; treated as untrusted.";
  return route.trustSource === "declared" ? `Trust in: ${route.trust.join(", ")} (declared).` : `Trust in: ${route.trust.join(", ")} (derived), from the crossing on its handler.`;
}

/** The length of a polyline. */
export function polylineLength(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  return sum;
}

/** How far along a polyline the point nearest `p` lies. */
function alongPolyline(points: readonly Point[], p: Point): { at: number; distance: number } {
  let best = { at: 0, distance: Infinity };
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / (length * length)));
    const distance = Math.hypot(a[0] + (b[0] - a[0]) * t - p[0], a[1] + (b[1] - a[1]) * t - p[1]);
    if (distance < best.distance) best = { at: walked + length * t, distance };
    walked += length;
  }
  return best;
}

function r1(value: number): number {
  return Math.round(value * 10) / 10;
}

function intersects(a: FlowBox, b: FlowBox, margin = 1): boolean {
  return a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;
}

function textBox(t: Pick<FlowText, "text" | "x" | "y" | "size" | "bold" | "align" | "mono">): FlowBox {
  const w = textWidth(t.text, t.size, t.bold, 0, t.mono === true);
  const x = t.align === "middle" ? t.x - w / 2 : t.align === "end" ? t.x - w : t.x;
  return { x, y: t.y - t.size * 0.78, w, h: t.size };
}

/** An octilinear path from `a` to `b` turning in the lane at `lane`: horizontal, a 45-degree chamfer, vertical, a chamfer, horizontal. */
function lanePath(a: Point, lane: number, b: Point): FlowPolyline {
  const dy = b[1] - a[1];
  if (Math.abs(dy) < 0.05) return { points: [a, b], legs: [{ a, b }] };
  const sy = Math.sign(dy);
  const sx0 = Math.sign(lane - a[0]) || 1;
  const sx1 = Math.sign(b[0] - lane) || 1;
  const c = Math.min(FLOW_CHAMFER, Math.abs(dy) / 2, Math.abs(lane - a[0]), Math.abs(b[0] - lane));
  const p1: Point = [lane - sx0 * c, a[1]];
  const p2: Point = [lane, a[1] + sy * c];
  const p3: Point = [lane, b[1] - sy * c];
  const p4: Point = [lane + sx1 * c, b[1]];
  const points: Point[] = [a, p1, p2, p3, p4, b].map(([x, y]) => [r1(x), r1(y)] as Point);
  return { points, legs: [{ a: points[0]!, b: points[1]! }, { a: points[2]!, b: points[3]! }, { a: points[4]!, b: points[5]! }] };
}

function dedupe(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last === undefined || Math.abs(last[0] - p[0]) > 0.01 || Math.abs(last[1] - p[1]) > 0.01) out.push(p);
  }
  return out;
}

function pathD(points: Point[]): string {
  return dedupe(points).map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x} ${y}`).join(" ");
}

/** A rail's label, longest first: its name, what it is, and how many call it. */
function railForms(name: string, callers: number, others: number): string[] {
  return [`${name}: core dependency, called by ${callers} of ${others}`, `${name}: core dependency`, name];
}

/**
 * A component's role on its box: its spec's intent in at most three lines of
 * `width`, shortened when it does not fit at a clause (a colon, a semicolon,
 * a comma, a dash, or before "and", "that", "with", "through", "for",
 * "whose", "where", "which") of three words or more, else to the words that
 * fit, never ending on a word that only leads into the next; never an
 * ellipsis. The layout widens a column (up to FLOW_ROLE_MAX_W) before it
 * lets a role fall to the last case, which cuts mid-phrase (roleCut). The
 * whole intent is in the inspector and the box's title.
 */
export function roleLines(intent: string, width: number, most = FLOW_ROLE_LINES): string[] {
  return roleCut(intent, width, most).lines;
}

/** A role's lines, and how it was shortened: not at all, at a clause, or at a word, which is mid-phrase. */
export function roleCut(intent: string, width: number, most = FLOW_ROLE_LINES): { lines: string[]; cut: "whole" | "clause" | "word" } {
  const whole = intent.trim().replace(/[.:;,]+$/, "");
  const wrap = (text: string): string[] => {
    const lines: string[] = [];
    for (const word of text.split(" ")) {
      const last = lines[lines.length - 1];
      if (last !== undefined && textWidth(`${last} ${word}`, TYPE_SMALL, false) <= width) lines[lines.length - 1] = `${last} ${word}`;
      else lines.push(word);
    }
    return lines;
  };
  const fits = (text: string): boolean => {
    const lines = wrap(text);
    return lines.length <= most && lines.every((line) => textWidth(line, TYPE_SMALL, false) <= width);
  };
  if (whole === "") return { lines: [], cut: "whole" };
  if (fits(whole)) return { lines: wrap(whole), cut: "whole" };
  const cuts: number[] = [];
  for (const m of whole.matchAll(/[:;,]\s| \u2014 | (?:and|that|with|through|for|whose|where|which) /g)) cuts.push(m.index);
  const clause = cuts.map((at) => whole.slice(0, at).replace(/[.:;,]+$/, "")).filter((text) => text.split(" ").length >= 3 && fits(text)).pop();
  if (clause !== undefined) return { lines: wrap(clause), cut: "clause" };
  const words = whole.split(" ");
  let count = 0;
  while (count < words.length && fits(words.slice(0, count + 1).join(" "))) count += 1;
  const kept = words.slice(0, Math.max(1, count));
  while (kept.length > 1 && /^(?:a|an|the|as|of|to|and|or|for|with|by|in|on|at|that|through|from|into|one|its|their)$/i.test(kept[kept.length - 1]!.replace(/[.:;,]+$/, ""))) kept.pop();
  return { lines: wrap(kept.join(" ").replace(/[.:;,]+$/, "")), cut: "word" };
}

/** The narrowest width from `from` up to FLOW_ROLE_MAX_W at which a role is whole or cut at a clause, else FLOW_ROLE_MAX_W. */
function roleWidth(intent: string, from: number): number {
  for (let width = from; width < FLOW_ROLE_MAX_W; width += 10) if (roleCut(intent, width).cut !== "word") return width;
  return Math.max(from, FLOW_ROLE_MAX_W);
}

type Side = "left" | "right" | "top" | "bottom";

/** How one step between two stations is drawn: into the next column, down or up to the neighbour, round the column's lane, or back. */
type HopKind = "forward" | "adjacent" | "bracket" | "back";

interface Hop {
  key: string;
  from: FlowNode;
  to: FlowNode;
  kind: HopKind;
  /** The route's place, or past the routes for a load-bearing interface: orders parallel tracks. */
  order: number;
}

/**
 * Every coordinate of the map, from the model and the selection. A
 * station's seat is a function of its column and rows; the selection only
 * adds faint lines, never moves a station or a route.
 */
export function flowLayout(model: FlowModel, selection: FlowSelection = flowSelection(model, undefined), previews: readonly StructurePreview[] = []): FlowLayout {
  const byFolder = new Map(model.nodes.map((node) => [node.folder, node]));
  const edgeById = new Map(model.edges.map((edge) => [edge.id, edge]));
  const placed = model.nodes.filter((node) => !node.core);
  const columns = Math.max(1, ...placed.map((node) => node.column + 1));
  const inColumn = (c: number): FlowNode[] => placed.filter((node) => node.column === c).sort((a, b) => a.row - b.row);
  // A row is FLOW_ROW_H tall unless a station's text needs a taller box (set below, once the boxes are sized).
  let rowH = FLOW_ROW_H;
  const cy = (node: FlowNode): number => FLOW_TOP + (node.row + node.span / 2) * rowH;
  const neighbours = (a: FlowNode, b: FlowNode): boolean => {
    const list = inColumn(a.column);
    return Math.abs(list.indexOf(a) - list.indexOf(b)) === 1;
  };
  const kindOf = (from: FlowNode, to: FlowNode): HopKind => (to.column > from.column ? "forward" : to.column < from.column ? "back" : neighbours(from, to) ? "adjacent" : "bracket");

  // The hops: every step of every route, then every load-bearing or broken interface on no route.
  const drawn = model.routes.filter((route) => route.stops.every((stop) => byFolder.has(stop) && !byFolder.get(stop)!.core));
  const atRest = (edge: FlowEdge): boolean => (edge.loadBearing || edge.bypasses.length > 0) && edge.routes.length === 0 && !edge.stub;
  const bearing = model.edges.filter((edge) => atRest(edge) && !byFolder.get(edge.from)!.core);
  const hops: Hop[] = [];
  drawn.forEach((route, index) => route.stops.slice(1).forEach((stop, i) => {
    const from = byFolder.get(route.stops[i]!)!;
    const to = byFolder.get(stop)!;
    hops.push({ key: `${route.id} ${i}`, from, to, kind: kindOf(from, to), order: index });
  }));
  bearing.forEach((edge, index) => {
    const from = byFolder.get(edge.from)!;
    const to = byFolder.get(edge.to)!;
    hops.push({ key: edge.id, from, to, kind: kindOf(from, to), order: drawn.length + index });
  });

  // Ports: each station side lists the tracks by it, ordered so parallel tracks do not cross.
  interface Port { key: string; other: number; order: number }
  const sides = new Map<string, Port[]>();
  const addPort = (folder: string, side: Side, port: Port): void => {
    const key = `${folder}\u0000${side}`;
    sides.set(key, [...(sides.get(key) ?? []), port]);
  };
  const exits = (hop: Hop): { out: Side; in: Side } =>
    hop.kind === "forward" ? { out: "right", in: "left" }
      : hop.kind === "back" ? { out: "left", in: "right" }
        : hop.kind === "bracket" ? { out: "right", in: "right" }
          : hop.to.row > hop.from.row ? { out: "bottom", in: "top" } : { out: "top", in: "bottom" };
  const starts = new Map<string, FlowRoute[]>();
  drawn.forEach((route, index) => {
    const first = byFolder.get(route.stops[0]!)!;
    starts.set(first.folder, [...(starts.get(first.folder) ?? []), route]);
    addPort(first.folder, "left", { key: `term ${route.id}`, other: -1e6 + index, order: index });
  });
  for (const hop of hops) {
    const side = exits(hop);
    // A vertical pair's tracks are ordered the same at both ends so they run straight: by route, then key.
    const vertical = side.out === "top" || side.out === "bottom";
    addPort(hop.from.folder, side.out, { key: `out ${hop.key}`, other: vertical ? hop.order : cy(hop.to), order: hop.order });
    addPort(hop.to.folder, side.in, { key: `in ${hop.key}`, other: vertical ? hop.order : cy(hop.from), order: hop.order });
  }
  for (const ports of sides.values()) ports.sort((a, b) => a.other - b.other || a.order - b.order || a.key.localeCompare(b.key));

  // Station sizes: one width per column from the widest name, folder, or role in it (a role wraps to three lines at
  // FLOW_ROLE_W, and its column widens toward FLOW_ROLE_MAX_W only when it would otherwise be cut mid-phrase); a height
  // from the tracks it carries and the lines of its text, never under four lines.
  const folderText = (node: FlowNode): string => (node.folder === "." ? "project root" : node.folder);
  const ownW = (node: FlowNode): number => Math.max(textWidth(flowName(node), TYPE_NAME, true) + (node.children > 0 ? 18 : 0), textWidth(folderText(node), TYPE_SMALL, false, 0, true));
  const roleW = (node: FlowNode): number => Math.min(textWidth(node.intent.trim().replace(/[.:;,]+$/, ""), TYPE_SMALL, false), roleWidth(node.intent, Math.ceil(Math.max(FLOW_ROLE_W, ownW(node)))));
  const nameW = (node: FlowNode): number => Math.ceil(Math.max(ownW(node), roleW(node)) + 24);
  const verticalTracks = (node: FlowNode): number => Math.max(sides.get(`${node.folder}\u0000top`)?.length ?? 0, sides.get(`${node.folder}\u0000bottom`)?.length ?? 0);
  const colW = Array.from({ length: columns }, (_, c) => Math.max(90, ...inColumn(c).map((node) => Math.max(nameW(node), verticalTracks(node) * FLOW_TRACK + 40))));
  const roleOf = (node: FlowNode): string[] => roleLines(node.intent, (node.core ? FLOW_ROLE_W : colW[node.column]!) - 24);
  const textH = (node: FlowNode): number => FLOW_BOX_MIN_H + Math.max(0, roleOf(node).length - 2) * FLOW_ROLE_LINE;
  const boxH = (node: FlowNode): number => {
    const tracks = Math.max(sides.get(`${node.folder}\u0000left`)?.length ?? 0, sides.get(`${node.folder}\u0000right`)?.length ?? 0);
    return Math.max(textH(node), Math.min(FLOW_BOX_MAX_H, Math.max(FLOW_BOX_MIN_H, tracks * FLOW_TRACK + 12)));
  };
  rowH = Math.max(FLOW_ROW_H, ...placed.map((node) => boxH(node) + FLOW_ROW_GAP));

  // Stubs: per column and rail one shared drop beside the column; the side with fewer tracks to cross.
  const railIndex = new Map(model.coreDependencies.map((core, index) => [core.folder, index]));
  const dropSide = new Map<number, "left" | "right">();
  const railsBy = new Map<number, number[]>();
  for (let c = 0; c < columns; c++) {
    const callers = inColumn(c).filter((node) => model.edges.some((edge) => edge.stub && edge.from === node.folder));
    const rails = [...new Set(model.edges.filter((edge) => edge.stub && callers.some((n) => n.folder === edge.from)).map((edge) => railIndex.get(edge.to)!))].sort((a, b) => a - b);
    railsBy.set(c, rails);
    if (callers.length === 0) continue;
    const below = inColumn(c).filter((node) => node.row > callers[0]!.row);
    const count = (side: Side): number => below.reduce((sum, node) => sum + (sides.get(`${node.folder}\u0000${side}`)?.length ?? 0), 0);
    dropSide.set(c, count("right") < count("left") ? "right" : "left");
  }
  const dropsLeft = (c: number): number => (dropSide.get(c) === "left" ? railsBy.get(c)!.length : 0);
  const dropsRight = (c: number): number => (dropSide.get(c) === "right" ? railsBy.get(c)!.length : 0);

  // Lanes: how many vertical runs each gap carries, so each gap is as wide as its tracks need.
  const inGap = (c: number, kind: HopKind): Hop[] => hops.filter((hop) => hop.kind === kind && (kind === "back" ? hop.from.column - 1 === c : hop.from.column === c));
  const channel = (drops: number): number => (drops === 0 ? 0 : drops * FLOW_DROP_GAP + 10);
  const gapW = (c: number): number => Math.max(FLOW_GAP_MIN, 14 + channel(dropsRight(c)) + inGap(c, "bracket").length * FLOW_TRACK + 12 + inGap(c, "forward").length * FLOW_TRACK + 12 + inGap(c, "back").length * FLOW_TRACK + 12 + channel(c + 1 < columns ? dropsLeft(c + 1) : 0) + 14);

  // The left margin: the widest named origin, its dot, and room for the lines to fan into their stations. An entrance
  // route's trust tag hangs beneath its token, right-aligned to the edge the route leaves by (the owner's ruling
  // d-a5c6442d), so a trust level's name never widens the margin: a tag that does not fit is dropped, and the route's
  // inspector states it. The margin is only ever as narrow as the fixed words "no traced control" and "unknown" allow, so
  // the attention a route with no traced control carries is never the tag that drops.
  /** A name line set quiet (regular, not medium): a derived route's last line, or the count of names a token does not show. */
  const quietLine = (route: FlowRoute, j: number): boolean => {
    const n = originLines(route).length;
    return j === n - 1 && (route.derived || route.names.length > n);
  };
  const lineW = (route: FlowRoute, j: number): number => textWidth(originLines(route)[j]!, FLOW_NAME_SIZE, !quietLine(route, j));
  // A derived trust whose tag does not fit falls back to the fixed word "derived" (d-ba18b0fd), which the margin also allows.
  const fixedWords = [
    ...(drawn.some((route) => !route.derived && (route.noTracedControl || route.trust.length === 0)) ? [NO_TRACED_CONTROL] : []),
    ...(drawn.some((route) => !route.derived && route.noControl) ? [NO_CONTROL_NEEDED] : []),
    ...(drawn.some((route) => !route.derived && !route.noTracedControl && route.trust.length > 0 && route.trustSource === "derived") ? [FLOW_DERIVED_TAG] : []),
  ];
  const fixedTag = Math.max(0, ...fixedWords.map((words) => textWidth(words, TYPE_SMALL, false, 0, true)));
  const termW = Math.max(0, fixedTag + 3 - (FLOW_PAD + 2 * FLOW_TOKEN_PAD_X + 8 - 6), ...drawn.flatMap((route) => originLines(route).map((_, j) => lineW(route, j))));
  /** The room a route keeps beneath its token for its trust tag: an entrance route has one, a derived route none. */
  const trustRoom = (route: FlowRoute): number => (route.derived ? 0 : FLOW_TRUST_ROOM);
  // Identifiers where work enters stand on the line from the origin: the margin leaves them room.
  const tagW = (text: string): number => Math.ceil(textWidth(text, TYPE_SMALL, false, 0, true) + 8 + (text.startsWith("X") ? 6 : 0));
  const markW = (text: string): number => Math.ceil(textWidth(text, TYPE_SMALL, true) + 10);
  const entryRoom = Math.max(0, ...drawn.map((route) => (route.entry.length === 0 ? 0 : route.entry.reduce((sum, text) => sum + tagW(text) + 3, 0) + 12)));
  // A token's right edge, where its route leaves, is dotX - FLOW_DOT_R - 6: FLOW_PAD + termW + 2 * FLOW_TOKEN_PAD_X + 8 - 6.
  const dotX = r1(FLOW_PAD + termW + 2 * FLOW_TOKEN_PAD_X + 8 + FLOW_DOT_R);
  // Each group: its route, its name lines, where its names start, and its dot; beneath the names, room for its trust tag.
  const blocks = new Map<string, { top: number; groups: { route: FlowRoute; lines: string[]; top: number; y0: number; dot: number }[] }>();
  // A stack's back cards rise (FLOW_STACK_DY each) into the gap above its token: between the trust tag of the route
  // above and a token's top card there are FLOW_NAME_GAP + FLOW_TRUST_ROOM, less the tag (its gap and its line) and the
  // token's own padding beyond its lines (3 px), and all of that is free but FLOW_STACK_CLEAR. A stack that would rise
  // further reserves the rest above its token, so its cards always clear the text above them.
  const stackFree = FLOW_NAME_GAP + FLOW_TRUST_ROOM - FLOW_TRUST_GAP - TYPE_SMALL - 3 - FLOW_STACK_CLEAR;
  const rise = (route: FlowRoute): number => (tokenCards(route) - 1) * FLOW_STACK_DY;
  const reserve = (route: FlowRoute): number => Math.max(0, rise(route) - stackFree);
  let fan = 0;
  // Each station's block of tokens is centered on it, and blocks from different stations never overlap: where two would,
  // they move apart evenly, the upper one up and the lower one down, so every name and trust tag keeps its room.
  const stacked = [...starts].map(([folder, routes]) => {
    const heights = routes.map((route) => originLines(route).length * FLOW_NAME_LINE);
    const blockH = heights.reduce((a, b) => a + b, 0) + routes.reduce((sum, route) => sum + reserve(route) + trustRoom(route), 0) + (routes.length - 1) * FLOW_NAME_GAP;
    return { folder, routes, heights, blockH, top: cy(byFolder.get(folder)!) - blockH / 2 };
  }).sort((a, b) => a.top - b.top || a.folder.localeCompare(b.folder));
  for (let pass = 0; pass < 40; pass++) {
    let moved = false;
    for (let i = 1; i < stacked.length; i++) {
      const above = stacked[i - 1]!;
      const below = stacked[i]!;
      const overlap = above.top + above.blockH + FLOW_NAME_GAP - below.top;
      if (overlap <= 0.01) continue;
      // A block moves up no higher than FLOW_TOP / 2, its first token's back cards included, clear of the caption.
      const up = Math.min(overlap / 2, Math.max(0, above.top - FLOW_TOP / 2 - rise(above.routes[0]!)));
      above.top -= up;
      below.top += overlap - up;
      moved = true;
    }
    if (!moved) break;
  }
  for (const { folder, routes, heights, top } of stacked) {
    const node = byFolder.get(folder)!;
    let y = top;
    const groups = routes.map((route, i) => {
      y += reserve(route);
      const group = { route, lines: originLines(route), top: y, y0: y, dot: r1(y + heights[i]! / 2) };
      y += heights[i]! + trustRoom(route) + FLOW_NAME_GAP;
      return group;
    });
    blocks.set(folder, { top, groups });
    const h = boxH(node);
    const ports = sides.get(`${folder}\u0000left`)!;
    const spacing = ports.length < 2 ? FLOW_TRACK : Math.min(FLOW_TRACK, (h - 12) / (ports.length - 1));
    groups.forEach((group) => {
      const index = ports.findIndex((port) => port.key === `term ${group.route.id}`);
      const portY = cy(node) + (index - (ports.length - 1) / 2) * spacing;
      fan = Math.max(fan, Math.abs(portY - group.dot));
    });
  }
  // Each origin token, measured before any text is placed: its body holds its name lines, centered on its route's line,
  // right-aligned to tokenRight; its point reaches past that edge onto the start of its own line, into the room between
  // the token column and the first entrance identifier, so the map is no wider; its back cards step up and left, into
  // the column's left pad (the widest token's body starts FLOW_PAD + 2 from the canvas edge) and the gap reserved above.
  const tokenRight = r1(dotX - FLOW_DOT_R - 6);
  const tokens = new Map<string, FlowTokenDraw>();
  for (const block of blocks.values()) {
    for (const group of block.groups) {
      const n = group.lines.length;
      const h = n * FLOW_NAME_LINE + 3;
      const w = Math.max(...group.lines.map((_, j) => lineW(group.route, j))) + 2 * FLOW_TOKEN_PAD_X;
      const box: FlowBox = { x: r1(tokenRight - w), y: r1(group.dot - h / 2), w: r1(w), h };
      const depth = Math.min(FLOW_TOKEN_POINT, h / 2);
      const count = tokenCards(group.route);
      const cards = Array.from({ length: count }, (_, i) => {
        const back = count - 1 - i;
        return pointerPoints({ ...box, x: box.x - back * FLOW_STACK_DX, y: box.y - back * FLOW_STACK_DY }, depth).map(([a, b]): Point => [r1(a), r1(b)]);
      });
      tokens.set(group.route.id, { route: group.route.id, box, depth, tip: [r1(tokenRight + depth), group.dot], cards });
    }
  }
  const colX: number[] = [];
  colX[0] =r1(dotX + FLOW_DOT_R + 16 + entryRoom + fan + 12 + channel(dropsLeft(0)));
  for (let c = 1; c < columns; c++) colX[c] = r1(colX[c - 1]! + colW[c - 1]! + gapW(c - 1));
  const last = columns - 1;
  const trailing = 14 + channel(dropsRight(last)) + inGap(last, "bracket").length * FLOW_TRACK + 24;

  // Rows and the rails at the foot.
  const mass = model.unowned !== undefined && model.unowned.files > 0;
  const massRow = Math.max(0, ...inColumn(0).map((node) => node.row + node.span));
  const rows = Math.max(1, ...placed.map((node) => node.row + node.span), mass ? massRow + 1 : 0);
  const railTop = FLOW_TOP + rows * rowH + 12;
  const railLabels = model.coreDependencies.map((core) => textWidth(railForms(byFolder.get(core.folder)!.name, core.callers.length, model.nodes.length - 1)[0]!, TYPE_SMALL, false));
  const width = Math.ceil(Math.max(colX[last]! + colW[last]! + trailing, FLOW_PAD * 2 + Math.max(0, ...railLabels) + 160, 560));
  const height = railTop + model.coreDependencies.length * FLOW_RAIL_GAP + FLOW_PAD;

  // Stations.
  const stations = new Map<string, FlowStation>();
  for (const node of placed) {
    const h = boxH(node);
    const seat = { x: colX[node.column]!, y: r1(cy(node)) };
    stations.set(node.folder, { folder: node.folder, seat, x: seat.x, y: r1(seat.y - h / 2), w: colW[node.column]!, h });
  }
  const portAt = (folder: string, side: Side, key: string): Point => {
    const station = stations.get(folder)!;
    const ports = sides.get(`${folder}\u0000${side}`)!;
    const index = ports.findIndex((port) => port.key === key);
    if (side === "top" || side === "bottom") {
      const x = station.x + station.w / 2 + (index - (ports.length - 1) / 2) * FLOW_TRACK;
      return [r1(x), side === "top" ? station.y : r1(station.y + station.h)];
    }
    const spacing = ports.length < 2 ? FLOW_TRACK : Math.min(FLOW_TRACK, (station.h - 12) / (ports.length - 1));
    const y = station.seat.y + (index - (ports.length - 1) / 2) * spacing;
    return [side === "left" ? station.x : station.x + station.w, r1(y)];
  };

  // Lanes: every vertical run in a gap gets its own track, ordered so parallel runs do not cross.
  const ends = new Map<string, { a: Point; b: Point }>();
  for (const hop of hops) {
    const side = exits(hop);
    ends.set(hop.key, { a: portAt(hop.from.folder, side.out, `out ${hop.key}`), b: portAt(hop.to.folder, side.in, `in ${hop.key}`) });
  }
  const lanes = new Map<string, number>();
  for (let c = 0; c < columns; c++) {
    const edge = colX[c]! + colW[c]!;
    let x = edge + 14 + channel(dropsRight(c));
    // Brackets nearest the column, the shortest innermost, so nested brackets never cross.
    const brackets = inGap(c, "bracket").sort((a, b) => Math.abs(ends.get(a.key)!.b[1] - ends.get(a.key)!.a[1]) - Math.abs(ends.get(b.key)!.b[1] - ends.get(b.key)!.a[1]) || a.order - b.order || a.key.localeCompare(b.key));
    brackets.forEach((hop, i) => lanes.set(hop.key, r1(x + i * FLOW_TRACK)));
    x += brackets.length * FLOW_TRACK + 12;
    const forward = inGap(c, "forward");
    const up = forward.filter((hop) => ends.get(hop.key)!.b[1] < ends.get(hop.key)!.a[1]).sort((a, b) => ends.get(a.key)!.a[1] - ends.get(b.key)!.a[1] || a.order - b.order || a.key.localeCompare(b.key));
    const down = forward.filter((hop) => ends.get(hop.key)!.b[1] >= ends.get(hop.key)!.a[1]).sort((a, b) => ends.get(b.key)!.a[1] - ends.get(a.key)!.a[1] || a.order - b.order || a.key.localeCompare(b.key));
    [...down, ...up].forEach((hop, i) => lanes.set(hop.key, r1(x + i * FLOW_TRACK)));
    x += forward.length * FLOW_TRACK + 12;
    const back = inGap(c, "back").sort((a, b) => ends.get(a.key)!.a[1] - ends.get(b.key)!.a[1] || a.key.localeCompare(b.key));
    back.forEach((hop, i) => lanes.set(hop.key, r1(x + i * FLOW_TRACK)));
  }
  const hopLine = (hop: Hop): FlowPolyline => {
    const { a, b } = ends.get(hop.key)!;
    if (hop.kind === "adjacent") return { points: [a, b], legs: [{ a, b }] };
    return lanePath(a, lanes.get(hop.key)!, b);
  };

  // Routes: one path each, from the terminus through every station in order.
  const routes: FlowRouteDraw[] = drawn.map((route) => {
    const color = route.slot === undefined ? "var(--flow-neutral-route)" : `var(--flow-route-${route.slot})`;
    const first = stations.get(route.stops[0]!)!;
    const startPort = portAt(first.folder, "left", `term ${route.id}`);
    const group = blocks.get(first.folder)!.groups.find((g) => g.route === route)!;
    // The route starts at the tip of its origin token's point: the line leaves where the token points into the system.
    const terminus: Point = tokens.get(route.id)!.tip;
    const dy = Math.abs(terminus[1] - startPort[1]);
    const bend = r1(startPort[0] - 10 - channel(byFolder.get(first.folder)!.column === 0 ? dropsLeft(0) : 0));
    const path: Point[] = [terminus, [r1(bend - dy), terminus[1]], [bend, startPort[1]], startPort];
    const segments = new Map<string, FlowPolyline>();
    let entry: Point = startPort;
    let entrySide: Side = "left";
    route.stops.forEach((stop, i) => {
      const station = stations.get(stop)!;
      const cx = r1(station.x + station.w / 2);
      const through = (x: Point, xSide: Side | undefined): Point[] => {
        // Hidden under the box: to its middle, across, and out by the exit's side. An interchange.
        const inside: Point[] = [];
        if (entrySide === "top" || entrySide === "bottom") inside.push([entry[0], station.seat.y], [cx, station.seat.y]);
        else inside.push([cx, entry[1]]);
        if (xSide === undefined) return inside;
        if (xSide === "top" || xSide === "bottom") inside.push([cx, station.seat.y], [x[0], station.seat.y]);
        else inside.push([cx, x[1]]);
        return [...inside, x];
      };
      if (i === route.stops.length - 1) {
        path.push(...through(entry, undefined));
        return;
      }
      const hop = hops.find((h) => h.key === `${route.id} ${i}`)!;
      const side = exits(hop);
      const leg = ends.get(hop.key)!;
      path.push(...through(leg.a, side.out));
      const line = hopLine(hop);
      segments.set(route.edges[i]!, line);
      path.push(...line.points.slice(1));
      entry = leg.b;
      entrySide = side.in;
    });
    return { route, color, path: dedupe(path), terminus, segments, entry: { a: terminus, b: [r1(bend - dy), terminus[1]] as Point } };
  });

  const lines: FlowLineDraw[] = bearing.map((edge) => ({ edge, kind: "bearing", line: hopLine(hops.find((hop) => hop.key === edge.id)!) }));

  // Rails along the foot.
  const rails: FlowRailDraw[] = model.coreDependencies.map((core, index) => ({ folder: core.folder, index, y: railTop + index * FLOW_RAIL_GAP + 18, x0: FLOW_PAD, x1: width - FLOW_PAD }));

  // Faint: a plain interface on no route, drawn only when the selection reaches it; from a rail it rises from the rail.
  let faintIndex = 0;
  for (const edge of model.edges) {
    const fromRail = byFolder.get(edge.from)!.core;
    if (edge.routes.length > 0 || edge.stub || (atRest(edge) && !fromRail) || (!atRest(edge) && !selection.edges.has(edge.id))) continue;
    const from = byFolder.get(edge.from)!;
    const to = byFolder.get(edge.to)!;
    const b = stations.get(to.folder)!;
    const a = stations.get(from.folder);
    if (a === undefined) {
      const rail = rails.find((candidate) => candidate.folder === from.folder)!;
      const x = r1(b.x - 24 - faintIndex * 4);
      faintIndex += 1;
      const pb: Point = [b.x, r1(b.y + b.h - 4)];
      lines.push({ edge, kind: atRest(edge) ? "bearing" : "faint", line: { points: [[x, rail.y], [x, r1(pb[1] + 8)], [r1(x + 8), pb[1]], pb], legs: [{ a: [x, rail.y], b: [x, r1(pb[1] + 8)] }] } });
      continue;
    }
    const forward = to.column > from.column;
    const same = to.column === from.column;
    const pa: Point = [forward || same ? a.x + a.w : a.x, r1(a.y + a.h - 4)];
    const pb: Point = [forward ? b.x : b.x + b.w, r1(b.y + 4)];
    const lane = forward || same
      ? colX[from.column]! + colW[from.column]! + 14 + channel(dropsRight(from.column)) + 4 + faintIndex * 4
      : colX[from.column]! - 20 - channel(dropsLeft(from.column)) - faintIndex * 4;
    faintIndex += 1;
    lines.push({ edge, kind: "faint", line: lanePath(pa, r1(lane), pb) });
  }

  // Stubs: from each caller's station down beside its column to the rail, meeting it.
  const stubs: FlowStubDraw[] = [];
  for (const core of model.coreDependencies) {
    const index = railIndex.get(core.folder)!;
    const rail = rails[index]!;
    for (const id of core.stubs) {
      const edge = edgeById.get(id)!;
      const station = stations.get(edge.from);
      if (station === undefined) {
        const caller = rails.find((candidate) => candidate.folder === edge.from);
        if (caller === undefined) continue;
        const x = r1(width - FLOW_PAD - 60 + index * 9);
        stubs.push({ edge, rail: index, points: [[x, caller.y], [x, rail.y]], joints: [[x, rail.y]] });
        continue;
      }
      const node = byFolder.get(edge.from)!;
      const side = dropSide.get(node.column) ?? "left";
      const slot = railsBy.get(node.column)!.indexOf(index);
      const dropX = side === "left" ? r1(station.x - 8 - slot * FLOW_DROP_GAP) : r1(station.x + station.w + 8 + slot * FLOW_DROP_GAP);
      const tapX = side === "left" ? r1(station.x + 6 + slot * 5) : r1(station.x + station.w - 6 - slot * 5);
      const tapY = r1(station.y + station.h + 5 + slot * 4);
      stubs.push({ edge, rail: index, points: [[tapX, r1(station.y + station.h)], [tapX, tapY], [dropX, tapY], [dropX, rail.y]], joints: [[dropX, tapY], [dropX, rail.y]] });
    }
  }

  const massBox = mass ? { x: colX[0]!, y: r1(FLOW_TOP + massRow * rowH + rowH / 2 - 17), w: 120, h: 34 } : undefined;

  // Text by priority: each piece is placed at its first candidate that overlaps no placed text and no station, else dropped.
  const obstacles: FlowBox[] = [...stations.values()].map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h }));
  if (massBox !== undefined) obstacles.push(massBox);
  const placedText: FlowBox[] = [];
  const texts: FlowText[] = [];
  const dropped: string[] = [];
  const canvas: FlowBox = { x: 2, y: 2, w: width - 4, h: height - 4 };
  const inCanvas = (box: FlowBox): boolean => box.x >= canvas.x && box.y >= canvas.y && box.x + box.w <= canvas.x + canvas.w && box.y + box.h <= canvas.y + canvas.h;
  // Drawn lines: text prefers a place no line runs through.
  const segments: [Point, Point][] = [
    ...routes.flatMap((draw) => draw.path.slice(1).map((p, i): [Point, Point] => [draw.path[i]!, p])),
    ...lines.flatMap((draw) => draw.line.points.slice(1).map((p, i): [Point, Point] => [draw.line.points[i]!, p])),
    ...stubs.flatMap((stub) => stub.points.slice(1).map((p, i): [Point, Point] => [stub.points[i]!, p])),
  ];
  const crossesLine = (box: FlowBox): boolean => segments.some(([a, b]) => {
    const x0 = Math.min(a[0], b[0]);
    const x1 = Math.max(a[0], b[0]);
    const y0 = Math.min(a[1], b[1]);
    const y1 = Math.max(a[1], b[1]);
    if (x1 < box.x - 2 || x0 > box.x + box.w + 2 || y1 < box.y - 2 || y0 > box.y + box.h + 2) return false;
    if (Math.abs(a[0] - b[0]) < 0.05 || Math.abs(a[1] - b[1]) < 0.05) return true;
    for (let t = 0; t <= 1; t += 0.1) {
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      if (x >= box.x - 2 && x <= box.x + box.w + 2 && y >= box.y - 2 && y <= box.y + box.h + 2) return true;
    }
    return false;
  });
  const tryPlace = (candidates: Omit<FlowText, "key" | "priority" | "cls">[], key: string, priority: number, cls: string, avoidStations = true): FlowText | undefined => {
    const ordered = avoidStations ? [...candidates.filter((c) => !crossesLine(textBox(c))), ...candidates.filter((c) => crossesLine(textBox(c)))] : candidates;
    for (const candidate of ordered) {
      const box = textBox(candidate);
      if (!inCanvas(box) || placedText.some((other) => intersects(box, other)) || (avoidStations && obstacles.some((other) => intersects(box, other, 0)))) continue;
      placedText.push(box);
      const text: FlowText = { ...candidate, key, priority, cls };
      texts.push(text);
      return text;
    }
    dropped.push(key);
    return undefined;
  };

  // 1. Station names, roles, and folders, inside their boxes, which were sized to hold them.
  for (const node of model.nodes) {
    const station = stations.get(node.folder);
    if (station === undefined) continue;
    const within = `${node.id}-box`;
    const x = station.x + 12;
    // The text block (name, up to three role lines, folder) sits centered in the box, which was sized to hold it.
    const role = roleOf(node);
    const need = textH(node);
    const top = station.y + (station.h - need) / 2;
    tryPlace([{ text: flowName(node), x, y: r1(top + 15), size: TYPE_NAME, bold: true, align: "start", within }], `name ${node.folder}`, 1, "flow-station-name", false);
    role.forEach((line, i) => {
      tryPlace([{ text: line, x, y: r1(top + 29 + i * FLOW_ROLE_LINE), size: TYPE_SMALL, bold: false, align: "start", within }], `role ${node.folder} ${i}`, 3, "flow-station-role", false);
    });
    tryPlace([{ text: folderText(node), x, y: r1(top + need - 8), size: TYPE_SMALL, bold: false, align: "start", within, mono: true }], `folder ${node.folder}`, 4, "flow-station-folder flow-mono", false);
  }
  if (massBox !== undefined && model.unowned !== undefined) {
    tryPlace([{ text: "No component", x: massBox.x + 10, y: massBox.y + 15, size: TYPE_NAME, bold: true, align: "start", within: "structure--mass-box" }], "mass name", 1, "flow-station-name", false);
    tryPlace([{ text: `${plural(model.unowned.files, "file", "files")}, ${plural(model.unowned.lines, "line", "lines")}`, x: massBox.x + 10, y: massBox.y + 29, size: TYPE_SMALL, bold: false, align: "start", within: "structure--mass-box" }], "mass size", 4, "flow-station-folder", false);
  }
  // 2. Named origins, one line each, right-aligned in their token's body and centered on its route's line: at most four
  // names and a count of the rest.
  for (const block of blocks.values()) {
    for (const group of block.groups) {
      const n = group.lines.length;
      group.lines.forEach((line, j) => {
        const quiet = quietLine(group.route, j);
        // A line's text box (FLOW_NAME_SIZE tall, its top 0.78 of the size above the baseline) centered on its slot.
        const baseline = group.dot + (j - (n - 1) / 2) * FLOW_NAME_LINE + FLOW_NAME_SIZE * (0.78 - 0.5);
        tryPlace([{ text: line, x: tokenRight - FLOW_TOKEN_PAD_X, y: r1(baseline), size: FLOW_NAME_SIZE, bold: !quiet, align: "end" }], `origin ${group.route.id} ${j}`, 2, quiet ? "flow-origin-more" : "flow-origin", false);
      });
    }
  }
  // Every card of every token, its point included, is placed ahead of the text that follows, so nothing is set over it.
  for (const token of tokens.values()) {
    for (const card of token.cards) {
      const xs = card.map((p) => p[0]);
      const ys = card.map((p) => p[1]);
      placedText.push({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
    }
  }
  // 2. Each entrance route's trust tag: a subscript beneath its origin token, right-aligned under its body's right edge,
  // the base of the point its route leaves by, so it lines up with the names above it. Placed like any text: never over
  // text, a token or a station, else dropped (its inspector states it).
  const trustTags: FlowLayout["trustTags"] = [];
  for (const block of blocks.values()) {
    for (const group of block.groups) {
      if (group.route.derived) continue;
      const token = tokens.get(group.route.id)!;
      const bottom = token.box.y + token.box.h;
      const words = trustTagWords(group.route);
      // A derived level too wide for the margin still says it is derived: the fixed word, its level in the tooltip and inspector.
      const fallback = !group.route.noTracedControl && !group.route.noControl && group.route.trust.length > 0 && group.route.trustSource === "derived" ? [FLOW_DERIVED_TAG] : [];
      const placedTag = tryPlace([words, ...fallback].map((text) => ({ text, x: r1(tokenRight), y: r1(bottom + FLOW_TRUST_GAP + TYPE_SMALL * 0.78), size: TYPE_SMALL, bold: false, align: "end" as const, mono: true })), `trust ${group.route.id}`, 2, "flow-trust-text flow-mono");
      if (placedTag === undefined) continue;
      const text = textBox(placedTag);
      const box: FlowBox = { x: r1(text.x - FLOW_TRUST_PAD), y: r1(text.y - 1), w: r1(text.w + FLOW_TRUST_PAD), h: r1(text.h + 2) };
      trustTags.push({ route: group.route.id, box, levels: group.route.trust });
    }
  }
  // 2. Rail labels, once each.
  for (const rail of rails) {
    const node = byFolder.get(rail.folder)!;
    const callers = model.coreDependencies[rail.index]!.callers.length;
    // Along the rail, at its start first, else wherever no stub runs through it; never dropped while a shorter form fits.
    const forms = railForms(node.name, callers, model.nodes.length - 1);
    const starts = [rail.x0, ...Array.from({ length: Math.max(0, Math.floor((rail.x1 - rail.x0) / 40)) }, (_, i) => rail.x0 + 40 * (i + 1))];
    tryPlace(forms.flatMap((text) => starts.map((x) => ({ text, x, y: rail.y - 8, size: TYPE_SMALL, bold: false, align: "start" as const }))), `rail ${rail.folder}`, 2, "flow-rail-label", true);
  }

  // 3. Tokens: a padded box around one line of text. A token never overlaps text, another token, or a station.
  const tags: FlowTagDraw[] = [];
  const TAG_H = 14;
  const fits = (box: FlowBox): boolean => inCanvas(box) && !placedText.some((other) => intersects(box, other)) && !obstacles.some((other) => intersects(box, other, 0));
  const tokenText = (key: string, text: string, box: FlowBox, mono: boolean, cls: string): void => {
    // Mono text is set regular: the page embeds Plex Mono's regular weight only.
    texts.push({ key, text, x: r1(box.x + box.w / 2), y: r1(box.y + box.h / 2 + 3.9), size: TYPE_SMALL, bold: !mono, align: "middle", cls, priority: 5, ...(mono ? { mono: true } : {}) });
  };

  // 3. A component's broken mark, attached to its box: it selects its broken chokepoints and their bypass sites.
  const attached = (station: FlowStation, w: number, h: number): FlowBox[] => [
    { x: r1(station.x + station.w - 1), y: r1(station.y + 3), w, h },
    { x: r1(station.x + station.w - 8 - w), y: r1(station.y - h + 1), w, h },
    { x: r1(station.x + 8), y: r1(station.y - h + 1), w, h },
    { x: r1(station.x + station.w - 8 - w), y: r1(station.y + station.h - 1), w, h },
    { x: r1(station.x + 8), y: r1(station.y + station.h - 1), w, h },
    { x: r1(station.x + station.w / 2 - w / 2), y: r1(station.y - h + 1), w, h },
    { x: r1(station.x + station.w / 2 - w / 2), y: r1(station.y + station.h - 1), w, h },
  ];
  // A token attached to a box overlaps its border by one pixel, so the station itself is not an obstacle to it.
  const fitsAttached = (box: FlowBox, own: FlowStation): boolean => inCanvas(box) && !placedText.some((other) => intersects(box, other)) && !obstacles.some((other) => !(other.x === own.x && other.y === own.y) && intersects(box, other, 0));
  for (const node of model.nodes) {
    const station = stations.get(node.folder);
    if (station === undefined || node.defects.length === 0) continue;
    const text = `✕ ${node.defects.length} broken`;
    const w = Math.ceil(textWidth(text, TYPE_SMALL, true) + 10);
    const box = attached(station, w, TAG_H + 2).find((candidate) => fitsAttached(candidate, station));
    if (box === undefined) {
      dropped.push(`broken ${node.folder}`);
      continue;
    }
    placedText.push(box);
    tags.push({ text, kind: "broken", repeat: false, shape: undefined, state: "broken", route: undefined, node: node.folder, chokepoint: undefined, name: node.defects.map((d) => d.name).join(", "), edge: undefined, rail: undefined, edges: [], broken: true, box, boundary: undefined });
    tokenText(`mark broken ${node.folder}`, text, box, false, "flow-tag-text");
  }
  // 3. A component no enforcement covers carries a not-covered mark on its box, in the attention color, never red.
  const NOT_COVERED = "not covered";
  for (const node of model.nodes) {
    const station = stations.get(node.folder);
    if (station === undefined || node.covered) continue;
    const w = markW(NOT_COVERED);
    const order = attached(station, w, TAG_H);
    const box = [order[1]!, order[2]!, order[5]!, order[3]!, order[4]!, order[6]!, order[0]!].find((candidate) => fitsAttached(candidate, station));
    if (box === undefined) {
      dropped.push(`uncovered ${node.folder}`);
      continue;
    }
    placedText.push(box);
    tags.push({ text: NOT_COVERED, kind: "uncovered", repeat: false, shape: undefined, state: "mark", route: undefined, node: node.folder, chokepoint: undefined, name: `${node.name} is not covered`, edge: undefined, rail: undefined, edges: [], broken: false, box, boundary: undefined });
    tokenText(`mark uncovered ${node.folder}`, NOT_COVERED, box, false, "flow-tag-text");
  }

  // 4. The caption: how the routes were followed.
  const root = byFolder.get(".");
  const entranceCount = model.entrances.filter((e) => e.reachable).length;
  const captions =
    model.routesFrom === "root interfaces"
      ? [`${plural(model.routes.length, "structural route", "structural routes")} by reference weight from ${root === undefined ? "the root component" : root.name}'s interfaces, not flow: no entrance is declared`, `${plural(model.routes.length, "structural route", "structural routes")} by reference weight: no entrance is declared`]
      : model.routesFrom === "entrances"
        ? [`${plural(model.routes.length, "structural route", "structural routes")} from ${plural(entranceCount, "entrance", "entrances")}`]
        : ["No entrance is declared and there is no root component: no structural route is drawn"];
  tryPlace(captions.map((text) => ({ text, x: FLOW_PAD, y: 22, size: TYPE_LABEL, bold: false, align: "start" as const })), "caption", 3, "flow-caption");

  // 4. A component's boundary mark, on its box's edge: the crossings standing inside it, on no interface or entrance line.
  for (const node of model.nodes) {
    const station = stations.get(node.folder);
    if (station === undefined || node.boundary.length === 0) continue;
    const text = plural(node.boundary.length, "crossing", "crossings");
    const w = Math.ceil(textWidth(text, TYPE_SMALL, true) + 10);
    const order = attached(station, w, TAG_H);
    const box = [order[4]!, order[3]!, order[6]!, order[2]!, order[1]!, order[5]!, order[0]!].find((candidate) => fitsAttached(candidate, station));
    if (box === undefined) {
      dropped.push(`boundary ${node.folder}`);
      continue;
    }
    placedText.push(box);
    // The boundary runs along the edge the mark sits on: the box's own border, dashed, a trust boundary on the component.
    // Its place is kept under every selection; the count shows only when a trust level, the component or the boundary
    // is selected, and at rest the dashed edge alone is the mark.
    const side = box.x >= station.x + station.w - 1 ? "right" : box.y < station.y ? "top" : "bottom";
    const edgeY = side === "top" ? station.y : r1(station.y + station.h);
    const boundary = side === "right"
      ? { x1: r1(station.x + station.w), y1: r1(box.y - 5), x2: r1(station.x + station.w), y2: r1(box.y + box.h + 5) }
      : { x1: r1(box.x - 6), y1: edgeY, x2: r1(box.x + box.w + 6), y2: edgeY };
    tags.push({ text, kind: "boundary", repeat: false, shape: undefined, state: worstState(node.boundary.map((c) => c.verdict.state)) ?? "requirement", route: undefined, node: node.folder, chokepoint: undefined, name: `${plural(node.boundary.length, "crossing", "crossings")} inside ${node.name}`, edge: undefined, rail: undefined, edges: [], broken: false, box, boundary });
    if (boundaryShown(selection, node.folder)) tokenText(`mark boundary ${node.folder}`, text, box, false, "flow-tag-text");
  }

  // 5. Interface identifiers: one button each, on the pipe where it stands, on the entrance line where work enters through
  // it, and a core dependency's once, on its rail. Each is drawn in its invariant's state, and in full once: wherever it
  // stands again it is a dot of its shape and state that selects the same identifier. A crossing's identifier (X) has
  // pointed ends, a plain chokepoint's (C) is rounded. The entrance lines come first, where work enters.
  const identifierOf = (text: string): { chokepoint: string; name: string; crossing: boolean; state: FlowState } => {
    const found = model.identifiers.find((identifier) => identifier.text === text)!;
    return { chokepoint: found.chokepoint, name: found.name, crossing: found.crossing !== undefined, state: found.verdict.state };
  };
  const boundaryOf = (box: FlowBox, vertical: boolean): FlowTagDraw["boundary"] => {
    const mid: Point = [box.x + box.w / 2, box.y + box.h / 2];
    return vertical ? { x1: r1(box.x - 5), y1: r1(mid[1]), x2: r1(box.x + box.w + 5), y2: r1(mid[1]) } : { x1: r1(mid[0]), y1: r1(box.y - 9), x2: r1(mid[0]), y2: r1(box.y + box.h + 9) };
  };
  const DOT = 10;
  const full = new Set<string>();
  const isIdentifier = (text: string): boolean => /^[CX]\d+$/.test(text);
  const shapeOf = (text: string): FlowTagDraw["shape"] => (isIdentifier(text) ? (identifierOf(text).crossing ? "crossing" : "chokepoint") : undefined);
  /** A box on a line centered at (cx, cy): a dot is square and smaller than a token. */
  const tokenBox = (x: number, cyy: number, w: number): FlowBox => (w === DOT ? { x: r1(x), y: r1(cyy - DOT / 2), w: DOT, h: DOT } : { x: r1(x), y: r1(cyy - TAG_H / 2), w, h: TAG_H });
  const identifierTag = (text: string, box: FlowBox, where: Pick<FlowTagDraw, "route" | "edge" | "rail" | "edges" | "broken">, vertical: boolean, key: string): void => {
    const found = identifierOf(text);
    const repeat = box.w === DOT;
    tags.push({ text, kind: "identifier", repeat, shape: shapeOf(text), state: found.state, node: undefined, chokepoint: found.chokepoint, name: found.name, ...where, box, boundary: found.crossing && !repeat ? boundaryOf(box, vertical) : undefined });
    if (!repeat) {
      full.add(text);
      tokenText(key, text, box, true, "flow-tag-text");
    }
  };
  const widthOf = (text: string): number => (text.startsWith("✕") || text.startsWith("+") ? Math.ceil(textWidth(text, TYPE_SMALL, true) + 8) : full.has(text) ? DOT : tagW(text));
  for (const draw of routes) {
    const row = draw.route.entry;
    if (row.length === 0) continue;
    const widths = row.map(widthOf);
    const total = widths.reduce((a, b) => a + b, 0) + (widths.length - 1) * 3;
    const { a, b } = draw.entry;
    let placedEntry = false;
    for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
      const cx = r1(a[0] + (b[0] - a[0]) * t);
      let x = cx - total / 2;
      const boxes = widths.map((w) => {
        const box = tokenBox(x, a[1], w);
        x += w + 3;
        return box;
      });
      if (boxes[0]!.x < a[0] + 2 || boxes[boxes.length - 1]!.x + boxes[boxes.length - 1]!.w > b[0] - 2 || !boxes.every(fits)) continue;
      row.forEach((text, i) => {
        const box = boxes[i]!;
        placedText.push(box);
        identifierTag(text, box, { route: draw.route.id, edge: undefined, rail: undefined, edges: [], broken: identifierOf(text).state === "broken" }, false, `tag entry ${draw.route.id} ${text}`);
      });
      placedEntry = true;
      break;
    }
    if (!placedEntry) dropped.push(`tag entry ${draw.route.id}`);
  }
  const identified = model.edges.filter((edge) => !edge.stub && (edge.identifiers.length > 0 || edge.bypasses.length > 0)).sort((a, b) => b.bypasses.length - a.bypasses.length || b.identifiers.length - a.identifiers.length || a.id.localeCompare(b.id));
  for (const edge of identified) {
    const legs: { a: Point; b: Point }[] = [];
    const onRoute = routes.find((draw) => draw.segments.has(edge.id));
    if (onRoute !== undefined) legs.push(...[...onRoute.segments.get(edge.id)!.legs].reverse());
    const line = lines.find((candidate) => candidate.edge.id === edge.id);
    if (line !== undefined) legs.push(...[...line.line.legs].reverse());
    const broken = edge.bypasses.length > 0;
    const marks = edge.bypasses.length > 0 ? [`✕${edge.bypasses.length}`] : [];
    // All identifiers side by side; when they do not fit, the first and a count that selects the interface.
    const rows = [[...edge.identifiers, ...marks], ...(edge.identifiers.length > 1 ? [[edge.identifiers[0]!, `+${edge.identifiers.length - 1}`, ...marks]] : [])];
    let done = false;
    for (const row of rows) {
      const widths = row.map(widthOf);
      const total = widths.reduce((a, b) => a + b, 0) + (row.length - 1) * 3;
      for (const leg of legs) {
        const length = Math.hypot(leg.b[0] - leg.a[0], leg.b[1] - leg.a[1]);
        if (length < 6) continue;
        const vertical = Math.abs(leg.a[0] - leg.b[0]) < 0.05;
        for (const t of [0.5, 0.3, 0.7, 0.15, 0.85, 0.4, 0.6, 0.22, 0.78, 0.08, 0.92]) {
          const cx = r1(leg.a[0] + (leg.b[0] - leg.a[0]) * t);
          const cyy = r1(leg.a[1] + (leg.b[1] - leg.a[1]) * t);
          let x = cx - total / 2;
          const boxes = widths.map((w) => {
            const box = tokenBox(x, cyy, w);
            x += w + 3;
            return box;
          });
          if (!boxes.every(fits)) continue;
          row.forEach((text, i) => {
            const box = boxes[i]!;
            placedText.push(box);
            if (isIdentifier(text)) {
              identifierTag(text, box, { route: undefined, edge, rail: undefined, edges: [edge.id], broken }, vertical, `tag ${edge.id} ${text}`);
              return;
            }
            const kind: FlowTagDraw["kind"] = text.startsWith("✕") ? "bypass" : "more";
            tags.push({ text, kind, repeat: false, shape: undefined, state: "mark", route: undefined, node: undefined, chokepoint: undefined, name: "", edge, rail: undefined, edges: [edge.id], broken, box, boundary: undefined });
            tokenText(`tag ${edge.id} ${text}`, text, box, false, "flow-tag-text");
          });
          done = true;
          break;
        }
        if (done) break;
      }
      if (done) break;
    }
    if (!done) dropped.push(`tag ${edge.id}`);
  }
  for (const core of model.coreDependencies) {
    const rail = rails[railIndex.get(core.folder)!]!;
    const stubEdges = core.stubs.map((id) => edgeById.get(id)!);
    const texts2 = [...new Set(stubEdges.flatMap((edge) => edge.identifiers))];
    const label = texts.find((t) => t.key === `rail ${core.folder}`);
    let x = label === undefined ? rail.x0 + 8 : r1(textBox(label).x + textBox(label).w + 14);
    const onRail = (w: number, h: number): FlowBox | undefined => {
      for (let tries = 0; tries < 120; tries++, x += 12) {
        const candidate: FlowBox = { x: r1(x), y: r1(rail.y - h / 2), w, h };
        if (candidate.x + candidate.w > rail.x1) return undefined;
        const drop = stubs.some((stub) => stub.points.some((p) => p[0] >= candidate.x - 4 && p[0] <= candidate.x + candidate.w + 4 && p[1] >= rail.y - 20));
        if (fits(candidate) && !drop) return candidate;
      }
      return undefined;
    };
    for (const text of texts2) {
      const w = widthOf(text);
      const box = onRail(w, w === DOT ? DOT : TAG_H);
      if (box === undefined) {
        dropped.push(`tag rail ${core.folder} ${text}`);
        continue;
      }
      placedText.push(box);
      x = box.x + box.w + 6;
      identifierTag(text, box, { route: undefined, edge: undefined, rail: core.folder, edges: stubEdges.filter((edge) => edge.identifiers.includes(text)).map((edge) => edge.id), broken: stubEdges.some((edge) => edge.identifiers.includes(text) && edge.bypasses.length > 0) }, false, `tag rail ${core.folder} ${text}`);
    }
    // A core dependency's own marks stand on its rail: its broken chokepoints, the crossings inside it, and not covered.
    const railNode = byFolder.get(core.folder)!;
    const marks: { kind: "broken" | "boundary" | "uncovered"; text: string }[] = [
      ...(railNode.defects.length > 0 ? [{ kind: "broken" as const, text: `✕ ${railNode.defects.length} broken` }] : []),
      ...(railNode.covered ? [] : [{ kind: "uncovered" as const, text: NOT_COVERED }]),
      ...(railNode.boundary.length > 0 ? [{ kind: "boundary" as const, text: plural(railNode.boundary.length, "crossing", "crossings") }] : []),
    ];
    for (const mark of marks) {
      const box = onRail(markW(mark.text), TAG_H);
      if (box === undefined) {
        dropped.push(`${mark.kind} ${core.folder}`);
        continue;
      }
      placedText.push(box);
      x = box.x + box.w + 6;
      tags.push({
        text: mark.text,
        kind: mark.kind,
        repeat: false,
        shape: undefined,
        state: mark.kind === "broken" ? "broken" : mark.kind === "uncovered" ? "mark" : worstState(railNode.boundary.map((c) => c.verdict.state)) ?? "requirement",
        route: undefined,
        node: core.folder,
        chokepoint: undefined,
        name: mark.kind === "broken" ? railNode.defects.map((d) => d.name).join(", ") : mark.kind === "uncovered" ? `${railNode.name} is not covered` : `${plural(railNode.boundary.length, "crossing", "crossings")} inside ${railNode.name}`,
        edge: undefined,
        rail: undefined,
        edges: [],
        broken: mark.kind === "broken",
        box,
        boundary: mark.kind === "boundary" ? boundaryOf(box, false) : undefined,
      });
      if (mark.kind !== "boundary" || boundaryShown(selection, core.folder)) tokenText(`mark ${mark.kind} ${core.folder}`, mark.text, box, false, "flow-tag-text");
    }
  }

  // 7. Proposals from a scaffold preview, named beside their station.
  previews.forEach((preview, index) => {
    const station = stations.get(preview.component) ?? [...stations.values()][0];
    if (station === undefined) return;
    const text = `proposed preview · ${preview.name}`;
    tryPlace([
      { text, x: station.x + station.w + 14 + index * 8, y: r1(station.y + 10 + index * 12), size: TYPE_SMALL, bold: true, align: "start" },
      { text, x: station.x, y: r1(station.y - 4 - index * 12), size: TYPE_SMALL, bold: true, align: "start" },
      { text, x: station.x, y: r1(station.y + station.h + 12 + index * 12), size: TYPE_SMALL, bold: true, align: "start" },
    ], `proposal ${index}`, 6, "structure-proposed-word");
  });
  // 8. Column captions.
  for (let c = 0; c < columns; c++) {
    const text = c === 0 ? "Where work enters" : `${plural(c, "step", "steps")} from an entrance`;
    tryPlace([{ text, x: colX[c]!, y: 44, size: TYPE_SMALL, bold: false, align: "start" }], `column ${c}`, 7, "flow-colcap");
  }

  return { width, height, stations, rails, routes, tokens: [...tokens.values()], lines, stubs, tags, trustTags, texts, dropped, mass: massBox };
}

/** Whether a component's crossing count shows: only while a trust level, the component, or its boundary is selected. */
function boundaryShown(selection: FlowSelection, folder: string): boolean {
  return (selection.kind === "level" || selection.kind === "component" || selection.kind === "boundary") && selection.marks.has(folder);
}

/* --------------------------------------------------------------- render */

function flowLit(selection: FlowSelection, lit: boolean): string {
  if (selection.kind === "none" || selection.kind === "change") return "";
  return lit ? "is-lit" : "is-dim";
}

/**
 * The token behind a route's named origin (pointer and stack, d-e3abc2c8): its cards back to front, each a card with its
 * top-left corner cut and its right edge a point into the system, a tint of the route's color with a hairline border in
 * it (FLOW_TOKEN_TINT; the check measures the ink against the front card's fill, the only one text sits on). A card
 * behind is Glass's layering: the same tint, fainter, with a softer shadow.
 */
function originToken(token: FlowTokenDraw, route: FlowRoute): Markup {
  const slot = route.slot === undefined ? "neutral" : String(route.slot);
  const cards = token.cards.length;
  return html`${token.cards.map((card, i) => {
    const back = cards - 1 - i;
    return back === 0
      ? html`<path class="flow-origin-token" d="${polygonD(card)}" fill="var(--flow-token-${slot})" stroke="var(--flow-token-edge-${slot})" data-cards="${String(cards)}"/>`
      : html`<path class="flow-origin-card flow-origin-card-${String(back)}" d="${polygonD(card)}" fill="var(--flow-token-${slot})" stroke="var(--flow-token-edge-${slot})" aria-hidden="true"/>`;
  })}`;
}

/**
 * A selected route's token halo: one outline around the whole stack, its point included (the convex hull of its cards,
 * grown 3 px), drawn beneath every route so it never covers the text beside it.
 */
function tokenHalo(token: FlowTokenDraw): Markup {
  return html`<path class="flow-token-halo" data-halo="${token.route}" d="${polygonD(growConvex(convexHull(token.cards.flat()), 3))}"/>`;
}

function renderText(t: FlowText): Markup {
  // Every text is set from its left edge: middle and end alignment are resolved here from the embedded metrics.
  const box = textBox(t);
  return html`<text class="${t.cls}" x="${r1(box.x)}" y="${t.y}" font-size="${t.size}"${t.bold ? raw(` font-weight="${FLOW_WEIGHT}"`) : null}${t.within === undefined ? null : raw(` data-within="${t.within}"`)}>${t.text}</text>`;
}

/** A component's verdicts in words, for its title and accessible name. */
function stateWords(node: FlowNode): string {
  if (node.invariants.length === 0) return node.covered ? "declares no invariant" : "declares no invariant; not covered";
  const count = (state: FlowState): number => node.invariants.filter((i) => i.verdict.state === state).length;
  const words = [count("verified") > 0 ? `${count("verified")} verified` : "", count("requirement") > 0 ? `${plural(count("requirement"), "requirement", "requirements")} not enforced` : "", count("broken") > 0 ? `${count("broken")} broken` : ""].filter(Boolean).join(", ");
  return node.covered ? words : `${words}; not covered`;
}

/** How a neighbor stands to a selected component: a caller depends on it (work travels in), a callee is what it uses (work travels out). */
type Standing = "caller" | "callee" | undefined;

function renderStation(node: FlowNode, station: FlowStation, texts: FlowText[], selection: FlowSelection, selected: string | undefined, model: FlowModel, standing: Standing): Markup {
  const own = selected === node.id;
  const classes = [
    "flow-station",
    node.declaresEntrance ? "flow-entry" : "",
    node.unconnected ? "flow-unconnected" : "",
    node.defects.length > 0 ? "flow-broken" : "",
    selection.kind === "component" ? (own ? "" : standing === "caller" ? "is-caller is-reach" : standing === "callee" ? "is-callee is-reach" : "is-dim") : flowLit(selection, selection.nodes.has(node.folder)),
    own ? "is-selected is-pulse-source" : "",
  ].filter(Boolean).join(" ");
  const routes = model.routes.filter((route) => route.stops.includes(node.folder)).map(routeName);
  const mine = texts.filter((t) => t.key === `name ${node.folder}` || t.key.startsWith(`role ${node.folder} `) || t.key === `folder ${node.folder}`);
  const state = node.state;
  // A component nothing covers carries a hollow bar, unless it is broken: red stays.
  const hollow = !node.covered && state !== "broken";
  // The bar starts below the cut top-left corner, clear of its diagonal.
  const barY = r1(station.y + FLOW_BOX_CUT);
  const barH = r1(station.h - FLOW_BOX_CUT - 6);
  const bar = hollow
    ? html`<rect class="flow-state-bar flow-state-hollow" data-state-bar="${state ?? "none"}" data-covered="false" x="${r1(station.x + 3.5)}" y="${barY}" width="4" height="${barH}" rx="2"/>`
    : state === undefined ? null : html`<rect class="flow-state-bar flow-state-${state}" data-state-bar="${state}" x="${r1(station.x + 3.5)}" y="${barY}" width="4" height="${barH}" rx="2"/>`;
  const standingWords = standing === "caller" ? "; calls the selected component" : standing === "callee" ? "; the selected component calls it" : "";
  return html`<g class="${classes}" id="${node.id}" data-folder="${node.folder}" data-row="${String(node.row)}" data-column="${String(node.column)}" data-seat="${`${station.seat.x} ${station.seat.y}`}" data-state="${state ?? "none"}" data-covered="${node.covered ? "true" : "false"}"${standing === undefined ? null : raw(` data-standing="${standing}"`)} data-structure-select="${node.id}" role="button" tabindex="0" aria-pressed="${own ? "true" : "false"}" aria-label="${flowName(node)}, ${node.folder}: ${node.intent} ${stateWords(node)}; calls ${node.out}, called by ${node.in}${routes.length === 0 ? "" : `, on routes ${routes.join("; ")}`}${standingWords}">
    <title>${flowName(node)} · ${node.folder} · ${node.intent} · ${stateWords(node)} · calls ${node.out} · called by ${node.in}${routes.length === 0 ? "" : ` · routes: ${routes.join("; ")}`}</title>
    ${own ? html`<path class="flow-halo" d="${chamfer({ x: station.x - 4, y: station.y - 4, w: station.w + 8, h: station.h + 8 }, FLOW_BOX_CUT + 2)}"/>` : null}
    <path class="flow-box" id="${node.id}-box" d="${chamfer(station, FLOW_BOX_CUT)}"${standing === undefined ? null : raw(` style="animation-delay: ${FLOW_HOP_DELAY}s"`)}/>
    ${bar}
    ${mine.map(renderText)}
    ${node.children > 0 ? html`<g data-structure-expand="${node.folder}"><rect class="flow-expand" x="${station.x + station.w - 16}" y="${station.y + 2}" width="14" height="14" rx="3" fill="transparent" stroke="none"/><path class="flow-expand-mark" d="${node.expanded ? `M ${station.x + station.w - 13} ${station.y + 9} L ${station.x + station.w - 5} ${station.y + 9}` : `M ${station.x + station.w - 13} ${station.y + 9} L ${station.x + station.w - 5} ${station.y + 9} M ${station.x + station.w - 9} ${station.y + 5} L ${station.x + station.w - 9} ${station.y + 13}`}" stroke="var(--flow-muted)" stroke-width="1.5"/><title>${node.expanded ? `Close its ${plural(node.children, "component", "components")}` : `Open its ${plural(node.children, "component", "components")} in place`}</title></g>` : null}
  </g>`;
}

/** One line that moves when its selection is made: its points caller to callee, its color, and when its pulse starts. */
export interface FlowPulse {
  /** The interface or route it runs along. */
  on: string;
  points: Point[];
  color: string;
  /** Its length in px, and its cycle: FLOW_PULSE_PERIOD over FLOW_PULSE_SPEED, the same on every line, so every dash moves at one speed. */
  length: number;
  duration: number;
  delay: number;
}

/**
 * What moves under a selection, and only under one: a selected route's (or
 * entrance's) path, from its origin token to where it ends; a selected
 * component's interfaces, into it from each caller and out of it to each
 * callee, one hop after it lights. Every point list runs caller to callee,
 * so a pulse never runs backwards. Nothing moves at rest.
 */
export function flowPulses(model: FlowModel, selection: FlowSelection, layout: FlowLayout): FlowPulse[] {
  const pulse = (on: string, points: Point[], color: string, delay: number): FlowPulse => {
    const clean = dedupe(points);
    const length = r1(polylineLength(clean));
    return { on, points: clean, color, length, duration: Math.round((FLOW_PULSE_PERIOD / FLOW_PULSE_SPEED) * 1000) / 1000, delay };
  };
  if (selection.kind === "route" || selection.kind === "entrance") {
    return layout.routes.filter((draw) => selection.routes.has(draw.route.id)).map((draw) => pulse(draw.route.id, draw.path, draw.color, 0));
  }
  if (selection.kind !== "component") return [];
  const out: FlowPulse[] = [];
  for (const id of [...selection.into, ...selection.outOf].sort()) {
    const onRoute = layout.routes.find((draw) => draw.segments.has(id));
    const line = layout.lines.find((draw) => draw.edge.id === id);
    const stub = layout.stubs.find((draw) => draw.edge.id === id);
    const points = onRoute?.segments.get(id)?.points ?? line?.line.points ?? stub?.points;
    if (points === undefined || points.length < 2) continue;
    out.push(pulse(id, points, onRoute?.color ?? (stub !== undefined ? `var(--flow-rail-${stub.rail % FLOW_RAIL_COLORS.length})` : "var(--flow-select)"), FLOW_HOP_DELAY));
  }
  void model;
  return out;
}

/** The bright tint a pulse wears: its line's own color, lightened, never a new hue. */
function pulseTint(color: string): string {
  return `color-mix(in srgb, ${color} 45%, #ffffff)`;
}

function renderPulse(p: FlowPulse): Markup {
  // Dashes one period apart, shifted forward one period per cycle: a seamless procession caller to callee.
  const style = `stroke-dasharray: ${FLOW_PULSE_SEG} ${FLOW_PULSE_PERIOD - FLOW_PULSE_SEG}; stroke-dashoffset: 0; --pulse-end: -${FLOW_PULSE_PERIOD}px; animation-duration: ${p.duration}s; animation-delay: ${p.delay}s`;
  return html`<path class="flow-pulse" data-pulse="${p.on}" data-pulse-length="${String(p.length)}" data-pulse-duration="${String(p.duration)}" data-pulse-period="${String(FLOW_PULSE_PERIOD)}" d="${pathD(p.points)}" stroke="${pulseTint(p.color)}" style="${style}"/>`;
}

/** Small static chevrons along a pulse's line, pointing caller to callee: what reduced motion shows instead of the pulse. */
function renderChevrons(p: FlowPulse): Markup {
  const marks: string[] = [];
  const lengths = p.points.slice(1).map((b, i) => Math.hypot(b[0] - p.points[i]![0], b[1] - p.points[i]![1]));
  // Every leg long enough carries one; a line of short legs carries one on its longest.
  const longest = Math.max(...lengths);
  for (let i = 1; i < p.points.length; i++) {
    const a = p.points[i - 1]!;
    const b = p.points[i]!;
    const length = lengths[i - 1]!;
    if (length < 28 && !(longest < 28 && length === longest && length >= 8)) continue;
    const u: Point = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    const n: Point = [-u[1], u[0]];
    const tip: Point = [a[0] + u[0] * (length / 2 + 3), a[1] + u[1] * (length / 2 + 3)];
    const arm = (s: number): Point => [r1(tip[0] - u[0] * 4 + s * n[0] * 4), r1(tip[1] - u[1] * 4 + s * n[1] * 4)];
    marks.push(`M ${arm(1).join(" ")} L ${r1(tip[0])} ${r1(tip[1])} L ${arm(-1).join(" ")}`);
  }
  return marks.length === 0 ? html`` : html`<path class="flow-chevron" data-chevrons="${p.on}" d="${marks.join(" ")}" stroke="${p.color}"/>`;
}

/** The pointed outline of a crossing's identifier (X), or its dot: a diamond. A plain chokepoint's (C) is a rounded box, or a round dot. */
function tagShape(tag: FlowTagDraw): Markup {
  const { x, y, w, h } = tag.box;
  if (tag.kind === "identifier" && tag.repeat) {
    const cx = r1(x + w / 2);
    const cyy = r1(y + h / 2);
    return tag.shape === "crossing"
      ? html`<path class="flow-tag-shape" d="${`M ${cx} ${r1(cyy - 5)} L ${r1(cx + 5)} ${cyy} L ${cx} ${r1(cyy + 5)} L ${r1(cx - 5)} ${cyy} Z`}"/>`
      : html`<circle class="flow-tag-shape" cx="${cx}" cy="${cyy}" r="4.2"/>`;
  }
  if (tag.kind === "identifier" && tag.shape === "crossing") {
    return html`<path class="flow-tag-shape" d="${`M ${r1(x + 5)} ${y} L ${r1(x + w - 5)} ${y} L ${r1(x + w)} ${r1(y + h / 2)} L ${r1(x + w - 5)} ${r1(y + h)} L ${r1(x + 5)} ${r1(y + h)} L ${x} ${r1(y + h / 2)} Z`}"/>`;
  }
  return html`<rect class="flow-tag-shape" x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/>`;
}

/** The deterministic SVG of the map for a model, what is selected (already resolved: undefined is nothing), and any ephemeral proposals. */
export function renderFlowSvg(model: FlowModel, selected: string | undefined, previews: readonly StructurePreview[] = []): Markup {
  const selection = flowSelection(model, selected);
  const layout = flowLayout(model, selection, previews);
  const active = selection.kind !== "none" && selection.kind !== "change";
  const tracing = selection.kind === "entrance" || selection.kind === "route";
  const routeClass = (route: FlowRoute): string => [!active ? "" : selection.routes.has(route.id) ? (tracing ? "is-lit" : "") : "is-dim", tracing && selection.routes.has(route.id) ? "is-pulse-source" : ""].filter(Boolean).join(" ");
  const byFolder = new Map(model.nodes.map((node) => [node.folder, node]));
  const texts = (prefix: string): FlowText[] => layout.texts.filter((t) => t.key.startsWith(prefix));
  const edgeOf = new Map(model.edges.map((edge) => [edge.id, edge]));
  const callers = new Set([...selection.into].map((id) => edgeOf.get(id)!.from));
  const callees = new Set([...selection.outOf].map((id) => edgeOf.get(id)!.to));
  const standingOf = (folder: string): Standing => (selection.kind !== "component" ? undefined : callers.has(folder) ? "caller" : callees.has(folder) ? "callee" : undefined);
  const lineDirection = (id: string): string => (selection.into.has(id) ? " is-in" : selection.outOf.has(id) ? " is-out" : "");

  // Motion: the pulses of the selection, and the ticks of the identifiers each pulse passes. Broken marks never move.
  const pulses = flowPulses(model, selection, layout);
  const ticks = new Map<FlowTagDraw, { duration: number; delay: number }>();
  for (const tag of layout.tags) {
    if (tag.kind !== "identifier" || tag.state === "broken") continue;
    const center: Point = [tag.box.x + tag.box.w / 2, tag.box.y + tag.box.h / 2];
    for (const p of pulses) {
      const on = p.on === tag.route || p.on === tag.edge?.id || (tag.edge !== undefined && model.routes.find((r) => r.id === p.on)?.edges.includes(tag.edge.id) === true);
      if (!on) continue;
      const along = alongPolyline(p.points, center);
      if (along.distance > 12) continue;
      // A dash reaches this point once per cycle, at its distance along the line modulo one period.
      ticks.set(tag, { duration: p.duration, delay: Math.round((p.delay + (along.at % FLOW_PULSE_PERIOD) / FLOW_PULSE_SPEED) * 1000) / 1000 });
      break;
    }
  }

  const tagClass = (tag: FlowTagDraw): string => {
    // An identifier lights exactly when the selection names its chokepoint; a component's mark when it names the component.
    const lit = tag.kind === "identifier"
      ? selection.chokepoints.has(tag.chokepoint!)
      : tag.kind === "broken" || tag.kind === "boundary" || tag.kind === "uncovered"
        ? selection.marks.has(tag.node!)
        : tag.edges.some((id) => selection.edges.has(id));
    const quiet = selection.kind === "route" || selection.kind === "entrance" || selection.kind === "component";
    // A component's mark on a lit component stays: it belongs to what the story passes.
    const onLit = tag.node !== undefined && selection.nodes.has(tag.node);
    const look = tag.kind === "boundary"
      ? `flow-tag-boundary${boundaryShown(selection, tag.node!) ? "" : " flow-tag-tick"}`
      : tag.kind === "uncovered"
        ? "flow-tag-attention"
        : `flow-tag-${tag.state === "mark" ? "mark" : tag.state}${tag.kind === "broken" ? " flow-tag-broken-mark" : ""}`;
    return [
      "flow-tag",
      look,
      tag.kind === "identifier" && tag.repeat ? "flow-tag-repeat" : "",
      active && lit && !quiet ? "is-lit" : active && !lit && !onLit ? "is-dim" : "",
      (tag.chokepoint !== undefined && tag.chokepoint === selected) || (tag.kind === "broken" && selected === flowBrokenId(tag.node!)) || (tag.kind === "boundary" && selected === flowBoundaryId(tag.node!)) ? "is-selected" : "",
      ticks.has(tag) ? "flow-tick" : "",
    ].filter(Boolean).join(" ");
  };
  return html`<svg class="flow-svg" xmlns="http://www.w3.org/2000/svg" role="group" aria-labelledby="flow-svg-title" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" style="${`min-width: ${layout.width}px`}" data-selected="${selection.id ?? ""}" data-dropped="${layout.dropped.join("|")}">
    <title id="flow-svg-title">Structure: ${plural(model.routes.length, "structural route", "structural routes")} through ${plural(model.nodes.length, "component", "components")}, ${plural(model.coreDependencies.length, "core dependency", "core dependencies")} drawn as rails</title>
    <style>${raw(FLOW_SVG_STYLE)}${raw(routeVars())}</style>
    <defs>
      <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--flow-quiet)"/></marker>
      <pattern id="flow-hatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="3" fill="var(--flow-node)"/><rect width="1.4" height="3" fill="var(--flow-verified)"/></pattern>
      <pattern id="flow-tag-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" fill="var(--flow-tag)"/><rect width="1.6" height="4" fill="var(--flow-hatch)"/></pattern>
    </defs>
    <rect class="flow-surface" x="0" y="0" width="${layout.width}" height="${layout.height}"/>
    ${texts("caption").map(renderText)}
    ${texts("column").map(renderText)}
    ${layout.rails.map((rail) => {
      const node = byFolder.get(rail.folder)!;
      const own = selected === node.id;
      return html`<g class="flow-rail ${flowLit(selection, selection.nodes.has(rail.folder))}${own ? " is-selected is-pulse-source" : ""}" id="${node.id}" data-folder="${rail.folder}" data-core="true" data-state="${node.state ?? "none"}" data-covered="${node.covered ? "true" : "false"}" data-structure-select="${node.id}" role="button" tabindex="0" aria-pressed="${own ? "true" : "false"}" aria-label="${node.name}, core dependency, called by ${model.coreDependencies[rail.index]!.callers.length} components; ${stateWords(node)}">
        <title>${node.name} · ${node.folder} · ${node.intent} · ${stateWords(node)} · core dependency: ${CORE_RULE}</title>
        ${own ? html`<line class="flow-halo" x1="${rail.x0}" y1="${rail.y}" x2="${rail.x1}" y2="${rail.y}" stroke-width="12"/>` : null}
        <line class="flow-line flow-rail-line" data-line="${`rail ${rail.folder}`}" x1="${rail.x0}" y1="${rail.y}" x2="${rail.x1}" y2="${rail.y}" stroke="var(--flow-rail-${rail.index % FLOW_RAIL_COLORS.length})"/>
        ${texts(`rail ${rail.folder}`).map(renderText)}
      </g>`;
    })}
    ${layout.stubs.map((stub) => html`<g class="flow-stub-group ${flowLit(selection, selection.edges.has(stub.edge.id))}" data-stub="${stub.edge.id}" data-from="${stub.edge.from}" data-to="${stub.edge.to}"><path class="flow-line flow-stub" data-line="${`stub ${stub.edge.id}`}" d="${pathD(stub.points)}" stroke="var(--flow-rail-${stub.rail % FLOW_RAIL_COLORS.length})"/>${stub.joints.map(([x, y]) => html`<circle class="flow-joint" cx="${x}" cy="${y}" r="2.6" fill="var(--flow-rail-${stub.rail % FLOW_RAIL_COLORS.length})"/>`)}</g>`)}
    ${layout.lines.map((draw) => html`<g class="flow-interface ${flowLit(selection, selection.edges.has(draw.edge.id))}" id="${draw.edge.id}" data-from="${draw.edge.from}" data-to="${draw.edge.to}" data-drawn="${draw.kind}" data-structure-select="${draw.edge.id}" role="button" tabindex="0" aria-label="${draw.edge.from} to ${draw.edge.to}, on no structural route"><title>${draw.edge.from} → ${draw.edge.to}: on no structural route</title><path class="flow-line ${draw.kind === "faint" ? "flow-faint" : "flow-bearing-line"}${draw.edge.bypasses.length > 0 ? " flow-broken-line" : ""}${selection.edges.has(draw.edge.id) ? ` is-lit${lineDirection(draw.edge.id)}` : ""}" data-line="${draw.edge.id}" data-edge="${draw.edge.id}" d="${pathD(draw.line.points)}" marker-end="url(#flow-arrow)"/></g>`)}
    ${layout.tokens.filter((token) => token.route === selection.id && texts(`origin ${token.route} `).length > 0).map(tokenHalo)}
    ${layout.routes.map((draw) => {
      const trustTag = layout.trustTags.find((b) => b.route === draw.route.id);
      const level = trustTag === undefined || trustTag.levels.length !== 1 ? undefined : model.levels.find((l) => l.name === trustTag.levels[0]);
      return html`<g class="flow-route-group ${routeClass(draw.route)}" id="${draw.route.id}" data-names="${draw.route.names.join(", ")}" data-derived="${draw.route.derived ? "true" : "false"}" data-stops="${draw.route.stops.join(" ")}" data-edges="${draw.route.edges.join(" ")}"${draw.route.rail === undefined ? null : raw(` data-rail="${draw.route.rail}"`)} data-trust="${draw.route.trust.join(" ")}" data-controls="${draw.route.controls.join(" ")}" data-structure-select="${draw.route.id}" role="button" tabindex="0" aria-pressed="${selection.id === draw.route.id ? "true" : "false"}" aria-label="${routeName(draw.route)}: ${draw.route.stops.map((stop) => flowName(byFolder.get(stop)!)).join(", ")}${draw.route.derived ? "" : `; trust ${trustInWords(draw.route)}`}${draw.route.noTracedControl ? `; ${NO_TRACED_CONTROL}` : ""}${draw.route.noControl ? `; ${NO_CONTROL_NEEDED}` : ""}">
      <title>${routeName(draw.route)}: ${draw.route.stops.map((stop) => flowName(byFolder.get(stop)!)).join(" → ")}${draw.route.rail === undefined ? "" : ` → ${byFolder.get(draw.route.rail)!.name} (rail)`}${draw.route.derived ? "" : ` · trust in: ${trustInWords(draw.route)}`}</title>
      <path class="flow-line flow-route" data-line="${draw.route.id}" d="${pathD(draw.path)}" stroke="${draw.color}"/>
      <g class="flow-token${draw.route.derived ? " flow-derived" : ""}">${texts(`origin ${draw.route.id} `).length === 0 ? null : originToken(layout.tokens.find((t) => t.route === draw.route.id)!, draw.route)}</g>
      ${trustTag === undefined ? null : html`<g class="flow-trust${draw.route.noTracedControl ? " flow-trust-untraced" : draw.route.noControl ? " flow-trust-unneeded" : trustTag.levels.length === 0 ? " flow-trust-unknown" : ""}" data-trust-tag="${trustTagWords(draw.route)}" data-no-traced-control="${draw.route.noTracedControl ? "true" : "false"}"${level === undefined ? null : raw(` data-structure-select="${level.id}" role="button" tabindex="0" aria-label="trust level ${level.name}: ${level.meaning.replace(/"/g, "&quot;")}"`)} data-trust-source="${draw.route.trust.length === 0 ? "unknown" : draw.route.trustSource}"${draw.route.noControl ? raw(' data-no-control="true"') : null}><title>${trustTagTitle(draw.route, model.levels)}</title><rect class="flow-trust-box" x="${trustTag.box.x}" y="${trustTag.box.y}" width="${trustTag.box.w}" height="${trustTag.box.h}"/>${texts(`trust ${draw.route.id}`).map(renderText)}</g>`}
      <g class="flow-terminus${draw.route.derived ? " flow-derived" : ""}">${texts(`origin ${draw.route.id} `).map(renderText)}</g>
    </g>`;
    })}
    <g class="flow-motion" aria-hidden="true">${pulses.map(renderPulse)}${pulses.map(renderChevrons)}</g>
    ${[...layout.stations.entries()].map(([folder, station]) => renderStation(byFolder.get(folder)!, station, layout.texts, selection, selected, model, standingOf(folder)))}
    ${layout.tags.map((tag) => {
      const where = tag.rail !== undefined ? raw(` data-rail="${tag.rail}"`) : tag.route !== undefined ? raw(` data-entry="${tag.route}"`) : tag.node !== undefined ? raw(` data-node="${tag.node}"`) : raw(` data-edge="${tag.edge!.id}"`);
      const route = tag.route === undefined ? undefined : model.routes.find((r) => r.id === tag.route);
      const on = tag.rail !== undefined ? `the ${byFolder.get(tag.rail)!.name} rail` : route !== undefined ? `the entrance line of ${routeName(route)}` : tag.node !== undefined ? byFolder.get(tag.node)!.name : `${tag.edge!.from} to ${tag.edge!.to}`;
      const verdict = tag.chokepoint === undefined ? undefined : model.identifiers.find((i) => i.chokepoint === tag.chokepoint)?.verdict.label;
      const repeat = tag.kind === "identifier" && tag.repeat ? "; drawn in full elsewhere" : "";
      const what = tag.kind === "identifier"
        ? raw(` data-identifier="${tag.text}" data-state="${tag.state}"${tag.rail !== undefined ? ` data-edges="${tag.edges.join(" ")}"` : ""} data-structure-select="${tag.chokepoint}" role="button" tabindex="0" aria-label="${tag.text}: ${tag.name.replace(/"/g, "&quot;")}, ${verdict ?? ""}${repeat}" data-shape="${tag.shape}" data-repeat="${tag.repeat ? "true" : "false"}"`)
        : tag.kind === "broken"
          ? raw(` data-mark="broken" data-state="broken" data-structure-select="${flowBrokenId(tag.node!)}" role="button" tabindex="0" aria-label="${tag.text} in ${on}: ${tag.name.replace(/"/g, "&quot;")}"`)
          : tag.kind === "boundary"
            ? raw(` data-mark="boundary" data-state="${tag.state}" data-structure-select="${flowBoundaryId(tag.node!)}" role="button" tabindex="0" aria-label="${tag.name.replace(/"/g, "&quot;")}"`)
            : tag.kind === "uncovered"
              ? raw(` data-mark="uncovered" data-structure-select="${flowHealthId("uncovered")}" role="button" tabindex="0" aria-label="${on}: not covered, no enforcement covers it"`)
              : raw(` data-mark="${tag.kind}" data-structure-select="${tag.edge!.id}" role="button" tabindex="0" aria-label="${tag.kind === "bypass" ? `${plural(tag.edge!.bypasses.length, "bypass", "bypasses")}` : `${tag.edge!.identifiers.length - 1} more interface identifiers`} on ${on}"`);
      const key = tag.kind === "broken" || tag.kind === "boundary" || tag.kind === "uncovered" ? `mark ${tag.kind} ${tag.node}` : tag.rail !== undefined ? `tag rail ${tag.rail} ${tag.text}` : tag.route !== undefined ? `tag entry ${tag.route} ${tag.text}` : `tag ${tag.edge!.id} ${tag.text}`;
      const title = tag.kind === "identifier"
        ? `${tag.text}: ${tag.name}, ${verdict ?? ""} · on ${on}${tag.repeat ? " · drawn in full elsewhere; select to see where it stands" : ""}`
        : tag.kind === "bypass" ? `broken: ${plural(tag.edge!.bypasses.length, "bypass", "bypasses")} on ${on}`
          : tag.kind === "broken" ? `${on}: broken chokepoints ${tag.name}`
            : tag.kind === "boundary" ? `${tag.name}: trust boundaries on no drawn interface`
              : tag.kind === "uncovered" ? `${on} is not covered: no chokepoint stands on an interface it exposes or where work enters it, and none of its invariants is verified by a totality oracle`
                : `${tag.edge!.identifiers.join(", ")} on ${on}`;
      const tick = ticks.get(tag);
      const style = tick === undefined ? null : raw(` style="animation-duration: ${tick.duration}s; animation-delay: ${tick.delay}s"`);
      const selectedTag = tagClass(tag).includes("is-selected");
      return html`<g class="${tagClass(tag)}"${where}${what}${style}>
        <title>${title}</title>
        ${selectedTag ? html`<rect class="flow-tag-halo" x="${r1(tag.box.x - 3)}" y="${r1(tag.box.y - 3)}" width="${r1(tag.box.w + 6)}" height="${r1(tag.box.h + 6)}" rx="5"/>` : null}
        ${tag.boundary === undefined ? null : html`<line class="flow-boundary" x1="${tag.boundary.x1}" y1="${tag.boundary.y1}" x2="${tag.boundary.x2}" y2="${tag.boundary.y2}"/>`}
        ${tagShape(tag)}
        ${layout.texts.filter((t) => t.key === key).map((t) => renderText({ ...t, cls: `${t.cls}${t.mono === true ? " flow-mono" : ""}` }))}
      </g>`;
    })}
    ${layout.mass === undefined ? null : html`<g class="flow-mass" data-mass="unowned"><rect id="structure--mass-box" x="${layout.mass.x}" y="${layout.mass.y}" width="${layout.mass.w}" height="${layout.mass.h}" rx="7"/>${texts("mass").map(renderText)}</g>`}
    ${renderFlowProposals(model, layout, previews)}
  </svg>`;
}
function renderFlowProposals(model: FlowModel, layout: FlowLayout, previews: readonly StructurePreview[]): Markup {
  return join(previews.map((preview, index) => {
    const folder = model.nodes.find((node) => node.folder === preview.component)?.folder ?? model.nodes[0]?.folder;
    const box = folder === undefined ? undefined : layout.stations.get(folder);
    if (box === undefined) return html``;
    const x = box.x + box.w + 8 + index * 8;
    return html`<g class="flow-proposal" data-proposed="true">
      <path class="structure-edge structure-proposed" d="M ${x} ${box.y} L ${x} ${box.y + box.h}"/>
      <title>proposed preview · ${preview.name}</title>
      ${layout.texts.filter((t) => t.key === `proposal ${index}`).map(renderText)}
    </g>`;
  }));
}

/* ------------------------------------------------------------ inspector */

/*
 * The inspector reads like a product sidebar, not a page: what kind of thing
 * is selected, its name, one line saying what it is, then rows of labelled
 * facts and lists of rows to select next. One verdict per invariant, dated;
 * what an agent needs (test commands, per-enforcement records, the two
 * options) folds beneath it, closed. Monospace only for code identifiers and
 * paths; counts in tabular numerals; long explanations fold.
 */

/** Terms the map uses that the lexicon does not define: defined here, in the key, and on hover where they appear. */
const LOCAL_TERMS: Record<string, string> = {
  bypass: "a reference to a chokepoint's protected thing from outside the chokepoint: one is enough to break it",
  derived: "a route drawn by reference weight from the root component's interfaces because no entrance is declared: not the path work takes",
  "reference weight": "how many reference sites a component interface carries: what a derived route follows, which is not flow",
};

/** A term linked to its lexicon definition (its title carries the definition), or defined in place when the lexicon has none. */
function termLink(state: ShellState, name: string, text: string = name): Markup {
  const layer = state.lexicon.layers.find((l) => l.kind === "present" && l.id === "coherence");
  const concept = layer?.kind === "present" ? layer.lexicon.concepts.find((c) => c.name === name) : undefined;
  if (concept !== undefined) return html`<a class="flow-term" href="#coherence-${slug(name)}" title="${concept.definition}">${text}</a>`;
  return html`<dfn class="flow-term" title="${LOCAL_TERMS[name] ?? name}">${text}</dfn>`;
}

function flowPick(id: string, text: string | Markup, elementId?: string): Markup {
  return html`<button type="button" class="flow-pick" data-structure-select="${id}"${elementId === undefined ? null : raw(` id="${elementId}"`)}>${text}</button>`;
}

/** One selectable row: an optional lead (a route swatch), the pick, and its meta, a count at the right or a line below. */
function flowRow(pick: Markup, meta: Markup | string | null = null, kind: "count" | "line" = "line", lead: Markup | null = null): Markup {
  return html`<li class="flow-row${kind === "count" ? " flow-row-count" : ""}">${lead}${pick}${meta === null || meta === "" ? null : html`<span class="flow-meta">${meta}</span>`}</li>`;
}

/** Labelled facts: a label and its value per row. */
function flowFacts(rows: readonly (readonly [string | Markup, Markup | string] | null)[]): Markup {
  const shown = rows.filter((row): row is readonly [string | Markup, Markup | string] => row !== null);
  return shown.length === 0 ? html`` : html`<dl class="flow-facts">${shown.map(([label, value]) => html`<dt>${label}</dt><dd>${value}</dd>`)}</dl>`;
}

/** A code identifier or path in monospace; prose (anything with a space) stays in the text face. */
function codeOrText(value: string): Markup {
  return /\s/.test(value.trim()) ? html`${value}` : html`<code>${value}</code>`;
}

/** The start of an inspector: what kind of thing, its name, and a one-line summary. */
function flowHead(kind: Markup | string, heading: Markup, id?: string, summary: Markup | string | null = null): Markup {
  return html`<p class="flow-kind">${kind}</p>
    <h3${id === undefined ? null : raw(` id="${id}"`)}>${heading}</h3>
    ${summary === null || summary === "" ? null : html`<p class="flow-sub">${summary}</p>`}`;
}

/** An invariant's one verdict, drawn as the map draws it: a swatch in its state and the verdict in words, dated. */
function verdictMark(ref: Pick<FlowInvariantRef, "verdict">): Markup {
  return html`<span class="flow-verdict" data-verdict-state="${ref.verdict.state}"><span class="flow-verdict-swatch" aria-hidden="true"></span>${ref.verdict.label}</span>`;
}

/** One invariant as a row: its name (selecting its chokepoint when it has one, else linking its card) and its one verdict. */
function invariantRow(model: FlowModel, ref: FlowInvariantRef, where = false): Markup {
  const chokepoint = model.chokepoints.find((c) => c.component === ref.component && c.name === ref.name);
  const identifier = chokepoint === undefined ? undefined : model.identifiers.find((i) => i.chokepoint === chokepoint.id);
  const pick = chokepoint === undefined ? html`<a class="flow-pick" href="#${invariantId(ref.component, ref.name)}">${ref.name}</a>` : flowPick(chokepoint.id, ref.name);
  const lead = identifier === undefined ? null : html`<span class="flow-ident" data-verdict-state="${ref.verdict.state}">${identifier.text}</span>`;
  return html`<li class="flow-row" data-invariant="${ref.name}" data-verdict-state="${ref.verdict.state}">${lead}${pick}<span class="flow-meta">${verdictMark(ref)}${where ? html` · ${ref.component === "." ? "the root" : ref.component}` : null}</span></li>`;
}

/**
 * The sites the page's window counted and did not list, said with where they
 * are: the live page loads them from its server, and a snapshot names the
 * query that lists every one.
 */
function renderSitesLeft(state: ShellState, entry: LatestEntry, chokepoint: string, left: number): Markup {
  const by = new Map<string, number>();
  for (const tally of entry.sitesLeft ?? []) by.set(tally.component ?? "", (by.get(tally.component ?? "") ?? 0) + tally.count);
  const where = [...by.entries()].map(([folder, count]) => `${count} in ${folder === "" ? "no declared component" : folder === "." ? "the root" : folder}`).join(", ");
  const said = `${plural(left, "more site is", "more sites are")} counted and not listed (${where})`;
  return state.connection?.mode === "live"
    ? html`<p class="flow-note" data-field="sites-left" data-left="${left}">${said}. <button type="button" class="history-load" data-load-sites="${entry.at}~${entry.session}" data-component="${entry.component}" data-name="${entry.name}">Load the other ${left}</button></p>`
    : html`<p class="flow-note" data-field="sites-left" data-left="${left}">${said}: <code>query relies-on ${chokepoint}</code> lists every one, from the run under <code>.coherence/runs</code>.</p>`;
}

function flowSite(site: RelianceSite): Markup {
  const role = site.target === "protected" && site.siteClass === "bypass"
    ? "protected thing · bypass (not a legal chokepoint reference)"
    : site.target === "chokepoint" && site.siteClass === "chokepoint-reference"
      ? "chokepoint · reference (runtime call not established)"
      : site.siteClass === "exempt"
        ? "protected thing · exempt (from where the chokepoint does not govern; never a bypass)"
      : site.siteClass === "inside"
        ? `${site.target === "protected" ? "protected thing" : "chokepoint"} · inside chokepoint`
        : `${site.target === "protected" ? "protected thing" : "chokepoint"} · ${site.siteClass}`;
  return html`<li data-class="${site.siteClass}" data-target="${site.target}" data-test="${site.test ? "true" : "false"}" data-owner="${site.owner ? "true" : "false"}"><code>${site.file}:${site.line}</code> in <code>${site.symbol}</code> <span class="flow-meta">${site.component?.folder ?? "outside declared components"}</span> <span class="site-role">${role}</span>${site.form === undefined ? null : html` <span class="label">${site.form}</span>`}${site.owner ? html` <span class="label">owner</span>` : null}${site.test ? html` <span class="label">test</span>` : null}</li>`;
}

/** The two honest options for a broken chokepoint: advice for the agent that repairs it, folded. */
function renderFlowOptions(component: string, name: string, chokepoints: readonly string[]): Markup {
  return html`<details class="flow-more flow-agent"><summary>What an agent does next</summary><h5>The two options</h5><ol class="options" data-field="options">
    <li data-option="route"><strong>Route through the chokepoint.</strong> Move each bypass inside ${join(chokepoints.map((c, i) => html`<code>${c}</code>${i < chokepoints.length - 1 ? ", " : ""}`))} so the protected thing is reached through it and nowhere else; the next run turns the verdict green.</li>
    <li data-option="retire"><strong>Escalate a retirement.</strong> Record the decision with preservation as the rejected alternative, <code>escalate</code> it, and let a human <code>acknowledge</code> with the reliance of <a href="#${invariantId(component, name)}">${name}</a> in view. The invariant stands, and alarms, until then.</li>
  </ol></details>`;
}

/** The evidence the map stands on, in one line. */
function renderEvidence(model: FlowModel): Markup {
  const bounded = flowBoundsText(model);
  const partial = flowPartialText(model);
  return html`${partial === undefined ? null : html`<p class="flow-evidence flow-partial" data-field="partial" data-partial="${model.partial!.limit}">${partial[0]!.toUpperCase()}${partial.slice(1)}.</p>`}<p class="flow-evidence" data-field="evidence">Evidence: ${model.evidence === "language adapter"
    ? `resolved references from the ${model.language} language adapter${bounded === undefined ? "" : `, ${bounded}`}${unreadLanguagesText(model)}; declared entrances, and invariants`
    : html`the references the latest runs recorded to chokepoints and protected things, declared entrances, and invariants; plain component interfaces are unknown (${model.unread})`}. Observed runtime behavior is not shown.</p>`;
}

function routeSwatch(route: FlowRoute): Markup {
  const slot = route.slot === undefined ? "var(--flow-key-neutral)" : `var(--flow-key-route-${route.slot})`;
  return html`<span class="flow-swatch${route.derived ? " flow-swatch-derived" : ""}" data-route="${route.id}" aria-hidden="true" style="${`background: ${slot}`}"></span>`;
}

/** The page's own copies of the route colors, light and dark, for swatches and the key outside the map. */
function keyVars(): string {
  const light = FLOW_ROUTE_COLORS.map(([l], i) => `--flow-key-route-${i}: ${l};`).join(" ");
  const dark = FLOW_ROUTE_COLORS.map(([, d], i) => `--flow-key-route-${i}: ${d};`).join(" ");
  const lightRails = FLOW_RAIL_COLORS.map(([l], i) => `--flow-key-rail-${i}: ${l};`).join(" ");
  const darkRails = FLOW_RAIL_COLORS.map(([, d], i) => `--flow-key-rail-${i}: ${d};`).join(" ");
  return `.flow { ${light} ${lightRails} --flow-key-neutral: ${FLOW_NEUTRAL_ROUTE[0]}; }\n@media (prefers-color-scheme: dark) { .flow { ${dark} ${darkRails} --flow-key-neutral: ${FLOW_NEUTRAL_ROUTE[1]}; } }`;
}

function routeStops(model: FlowModel, route: FlowRoute): string {
  const name = (folder: string): string => {
    const node = model.nodes.find((n) => n.folder === folder);
    return node === undefined ? folder : flowName(node);
  };
  return `${route.stops.map(name).join(" → ")}${route.rail === undefined ? "" : ` → ${name(route.rail)} (rail)`}`;
}

function routeRow(model: FlowModel, route: FlowRoute): Markup {
  const trust = route.derived ? "" : ` · trust ${trustInWords(route)}${route.noTracedControl ? ` · ${NO_TRACED_CONTROL}` : ""}${route.noControl ? ` · ${NO_CONTROL_NEEDED}` : ""}`;
  return flowRow(flowPick(route.id, routeName(route)), `${routeStops(model, route)}${trust}`, "line", routeSwatch(route));
}

/** A route's trust and its controls, in one short block: what the security reader asks of every route first. */
function renderRouteTrust(state: ShellState, model: FlowModel, route: FlowRoute): Markup {
  if (route.derived) return html``;
  const waived = route.noControl ? model.entrances.filter((e) => route.entrances.includes(e.id) && e.noControl !== undefined) : [];
  return html`${flowFacts([
    [html`${termLink(state, "trust level", "Trust")} in`, route.trust.length === 0
      ? html`<span data-field="trust">unknown</span> <span class="flow-meta">its entrances declare no trust level and no crossing's chokepoint is their handler; treated as untrusted</span>`
      : route.trustSource === "declared"
        ? html`<span data-field="trust">${route.trust.join(", ")}</span> <span class="flow-meta" data-field="trust-source">(declared)</span>`
        : html`<span data-field="trust">${route.trust.join(", ")}</span> <span class="flow-meta" data-field="trust-source">(derived) the entering side of the crossing whose chokepoint is its entrances' handler; they declare none</span>`],
    ["Controls on it", route.noControl
      ? html`<span data-field="controls" data-no-control="true">${NO_CONTROL_NEEDED}</span> <span class="flow-meta">its entrances declare control: none, each with its reason; a stated claim a reader can challenge, never a traced control</span><ul class="flow-rows" data-field="no-control">${waived.map((e) => html`<li class="flow-row" data-entrance="${e.name}">${flowPick(e.id, e.name)}<span class="flow-meta" data-field="no-control-reason">${e.noControl!}</span></li>`)}</ul>${route.traced.length === 0 ? null : html`<ul class="flow-rows" data-field="controls-traced">${route.traced.map((control) => html`<li class="flow-row" data-control="${control.kind}" data-invariant="${control.name}"><a class="flow-pick" href="#${invariantId(control.component, control.name)}">${control.name}</a><span class="flow-meta">${CONTROL_WORDS[control.kind]} · ${verdictMark(control)}</span></li>`)}</ul>`}`
      : route.noTracedControl
      ? html`<span class="flow-attention" data-field="controls">${NO_TRACED_CONTROL}</span> <span class="flow-meta">what it carries in is untrusted, and no verified chokepoint or totality oracle was traced on it: none stands on its lines, wraps its handler, stands inside a component on it where its reach meets the protected thing, or covers its trust at a component on it. Not a demonstrated bypass</span>`
      : route.traced.length === 0
        ? html`<span data-field="controls">none</span> <span class="flow-meta">no control was traced on it, and it carries in a trust level inside the system's control</span>`
        : html`<ul class="flow-rows" data-field="controls">${route.traced.map((control) => html`<li class="flow-row" data-control="${control.kind}" data-invariant="${control.name}"${control.declared ? raw(' data-declared="true"') : null}>${control.identifier === undefined ? null : html`<span class="flow-ident" data-verdict-state="${control.verdict.state}">${control.identifier}</span>`}<a class="flow-pick" href="#${invariantId(control.component, control.name)}">${control.name}</a><span class="flow-meta">${control.kind === "wrapper" && control.declared ? `${CONTROL_WORDS.wrapper}, declared by its guard: line` : CONTROL_WORDS[control.kind]} · ${verdictMark(control)}</span></li>`)}</ul>`],
    route.partial.length === 0 ? null : ["Passed by some", html`<ul class="flow-rows" data-field="partial-controls">${route.partial.map((control) => html`<li class="flow-row" data-control="${control.kind}" data-invariant="${control.name}" data-entrances="${String(control.entrances)}"><a class="flow-pick" href="#${invariantId(control.component, control.name)}">${control.name}</a><span class="flow-meta">${control.kind === "wrapper" && control.declared ? `${CONTROL_WORDS.wrapper}, declared by its guard: line` : CONTROL_WORDS[control.kind]}, on ${control.entrances} of its ${route.entrances.length} entrances; not counted, since every entrance on a route must pass a control · ${verdictMark(control)}</span></li>`)}</ul>`],
  ])}`;
}

function edgeName(edge: FlowEdge): string {
  return `${edge.from === "." ? "root" : edge.from} → ${edge.to === "." ? "root" : edge.to}`;
}

/** The words each health count carries, for the strip and its inspector. */
function healthWords(kind: FlowHealthKind, count: number): string {
  switch (kind) {
    case "verified":
      return `${count} ${count === 1 ? "invariant" : "invariants"} enforced and verified`;
    case "requirements":
      return `${count} ${count === 1 ? "requirement" : "requirements"}, not yet enforced`;
    case "defects":
      return plural(count, "structural defect", "structural defects");
    case "bypassed":
      return `${count} ${count === 1 ? "requirement" : "requirements"} with a broken chokepoint`;
    case "broken":
      return `${count} broken: structural defects and requirements with a broken chokepoint`;
    case "uncovered":
      return `${count} ${count === 1 ? "component" : "components"} not covered`;
    case "escalations":
      return `${count} ${count === 1 ? "escalation" : "escalations"} awaiting a human`;
  }
}

/** The part of a trust level's meaning before its first colon or full stop: its definition in one line. */
function levelLine(meaning: string): string {
  const cut = /^(.+?)(?::\s|\.\s|\.$|;\s)/.exec(meaning.trim());
  return (cut?.[1] ?? meaning).trim();
}

/**
 * The health strip at the top of the map: every count is a selection, and its
 * inspector lists the set. A broken count that sits in one component selects
 * that component's broken mark, which the page scrolls into view. Beneath it,
 * the trust-level key: each level a selection, defined in one line, and what
 * an unknown trust means.
 */
function renderHealthStrip(model: FlowModel, selected: string | undefined): Markup {
  const counts: Record<FlowHealthKind, number> = { verified: model.health.verified.length, requirements: model.health.requirements.length, defects: model.health.defects.length, bypassed: model.health.bypassed.length, broken: flowHealthMembers(model, "broken").length, uncovered: model.health.uncovered.length, escalations: model.health.escalations.length };
  const shown = FLOW_HEALTH_KINDS.filter((kind) => kind !== "broken" && (kind === "verified" || kind === "requirements" || kind === "defects" || counts[kind] > 0));
  const nothingEnforced = counts.verified === 0 && counts.requirements > 0;
  // A broken count held by one component selects that component's broken mark: the map's one broken place, one click away.
  const target = (kind: FlowHealthKind): string => {
    if ((kind !== "defects" && kind !== "bypassed") || counts[kind] === 0) return flowHealthId(kind);
    const members = new Set(flowHealthMembers(model, kind).map((m) => `${m.component}\u0000${m.name}`));
    const holders = model.nodes.filter((node) => node.invariants.some((i) => members.has(`${i.component}\u0000${i.name}`)));
    return holders.length === 1 && holders[0]!.defects.length > 0 ? flowBrokenId(holders[0]!.folder) : flowHealthId(kind);
  };
  const derived = model.routes.some((route) => !route.derived);
  return html`<div class="flow-health" data-field="health" role="group" aria-label="Health">
    ${shown.map((kind) => html`<button type="button" class="flow-health-count" data-health="${kind}" data-count="${String(counts[kind])}" data-structure-select="${target(kind)}" aria-pressed="${selected === target(kind) || selected === flowHealthId(kind) ? "true" : "false"}"><span class="flow-health-swatch" aria-hidden="true"></span><strong>${String(counts[kind])}</strong> ${healthWords(kind, counts[kind]).replace(/^\d+ /, "")}</button>`)}
    ${nothingEnforced ? html`<p class="flow-health-note" data-field="nothing-enforced">Nothing is enforced yet: every declared invariant is still a requirement, so no identifier on this map is a working control.</p>` : null}
    ${model.levels.length === 0 ? null : html`<div class="flow-trust-key" data-field="trust-key">
      <p class="flow-trust-key-title">Trust levels <span class="flow-meta">the tag beneath each entrance route's token says which it carries in; select one to see where its crossings stand</span></p>
      <ul>${model.levels.map((level) => html`<li><button type="button" class="flow-trust-level" data-structure-select="${level.id}" aria-pressed="${selected === level.id ? "true" : "false"}" title="${level.meaning}"><code>${level.name}</code></button> <span>${levelLine(level.meaning)}</span>${level.outside ? html` <span class="flow-meta" data-outside="true">outside the system's control</span>` : null}</li>`)}${derived ? html`<li data-level="derived"><span class="flow-trust-tag"><code>(derived)</code></span> <span>read from the crossing on its handler</span></li><li data-level="unknown"><span class="flow-trust-tag flow-trust-unknown"><code>unknown</code></span> <span>neither declared nor derived: untrusted</span></li><li data-level="no-traced-control"><span class="flow-trust-tag flow-trust-untraced"><code>no traced control</code></span> <span>untrusted, and no verified chokepoint or totality oracle was traced on the route; not a demonstrated bypass</span></li>` : null}${renderNoControlKey(model)}</ul>
    </div>`}
    ${renderCoverage(model)}
  </div>`;
}

/**
 * Entrance coverage beneath the trust key (c-3760638e): one line, how many
 * entrances are declared and how much of the detected surface they cover,
 * the undeclared count in attention, and, opened, each grouped entrance with
 * what it stands for, every undeclared detected entrance with why it was
 * detected, and what the rules do not see. Nothing when the reading detected
 * nothing to measure against.
 */
function renderCoverage(model: FlowModel): Markup {
  const coverage = model.coverage;
  if (coverage === undefined) return html``;
  const covered = coverage.individually + coverage.grouped;
  // Each language read, by its own rules.
  const languages = model.languages?.read ?? [model.language ?? ""];
  const rules = languages.flatMap((language) => candidateRulesOf(language));
  return html`<details class="flow-coverage" data-field="entrance-coverage" data-detected="${String(coverage.detected)}" data-covered="${String(covered)}" data-undeclared="${String(coverage.uncovered.length)}">
    <summary><span class="flow-coverage-title">Entrances</span> ${String(coverage.declared)} declared, covering ${String(covered)} of ${plural(coverage.detected, "detected entrance", "detected entrances")}${coverage.groups.length === 0 ? "" : `, ${coverage.grouped} of them through ${plural(coverage.groups.length, "grouped entrance", "grouped entrances")}`}; <span class="${coverage.uncovered.length === 0 ? "flow-meta" : "flow-attention"}" data-field="undeclared">${String(coverage.uncovered.length)} undeclared</span></summary>
    ${coverage.groups.length === 0 ? null : html`<ul class="flow-rows" data-field="coverage-groups">${coverage.groups.map((g) => html`<li class="flow-row" data-entrance="${g.name}" data-covers="${String(g.covers)}"><span>${groupLine(g)}</span></li>`)}</ul>`}
    ${coverage.uncovered.length === 0 ? null : html`<ul class="flow-rows" data-field="coverage-undeclared">${coverage.uncovered.map((c) => html`<li class="flow-row" data-rule="${c.rule}"><code>${c.file}:${String(c.line)}</code>${c.symbol === "" ? null : html` <span>${c.symbol}</span>`}<span class="flow-meta">${c.rule}: ${c.why}</span></li>`)}</ul>`}
    <p class="flow-meta" data-field="coverage-rules">${coverage.beyond === 0 ? "" : `${plural(coverage.beyond, "declared entrance covers", "declared entrances cover")} nothing detected: declared where the rules do not reach, or finer than they detect. `}Detected by ${rules.length === 0 ? "no rule for this language" : rules.map((r) => r.rule).join(", ")}; ${languages.map((l) => notDetectedOf(l) ?? "").filter((t) => t !== "").join("; ")}.</p>
  </details>`;
}

/**
 * Every entrance that declares control: none, in the trust key where a human
 * reads the map's words: the count, and each entrance with its reason, so a
 * claim that no control is needed stays visible and can be challenged
 * (d-a1095ef2). Nothing when no entrance declares one.
 */
function renderNoControlKey(model: FlowModel): Markup {
  const waived = model.entrances.filter((e) => e.noControl !== undefined);
  if (waived.length === 0) return html``;
  return html`<li data-level="no-control-needed" data-count="${String(waived.length)}"><span class="flow-trust-tag flow-trust-unneeded"><code>${NO_CONTROL_NEEDED}</code></span> <details class="flow-no-control" data-field="no-control-key"><summary>${waived.length === 1 ? "1 entrance needs no control" : `${waived.length} entrances need no control`}, by its spec's word: control: none and a reason</summary><ul class="flow-rows">${waived.map((e) => html`<li class="flow-row" data-entrance="${e.name}">${flowPick(e.id, e.name)}<span class="flow-meta">${e.declaredBy === "." ? "the root" : e.declaredBy}: ${e.noControl!}</span></li>`)}</ul></details></li>`;
}

function renderHealthInspector(state: ShellState, model: FlowModel, kind: FlowHealthKind): Markup {
  if (kind === "escalations") {
    return html`<div class="flow-inspect" data-kind="health" data-health="${kind}">
      ${flowHead("Health", html`${healthWords(kind, model.health.escalations.length)}`, `${flowHealthId(kind)}-heading`, "Each waits for a human to acknowledge it.")}
      <ul class="flow-rows" data-field="members">${model.health.escalations.map((e) => html`<li class="flow-row"><a class="flow-pick" href="#journal-${slug(e.id)}">${e.id}</a><span class="flow-meta">${e.what}</span></li>`)}</ul>
    </div>`;
  }
  if (kind === "uncovered") {
    const nodes = model.health.uncovered.map((folder) => model.nodes.find((n) => n.folder === folder)!);
    return html`<div class="flow-inspect" data-kind="health" data-health="${kind}">
      ${flowHead("Health", html`${healthWords(kind, nodes.length)}`, `${flowHealthId(kind)}-heading`, html`No ${termLink(state, "chokepoint")} stands on a ${termLink(state, "component interface")} it exposes or where work enters it, and none of its invariants is verified by a ${termLink(state, "totality oracle")}. Each carries a hollow bar and a not-covered mark.`)}
      ${nodes.length === 0 ? html`<p class="flow-note">None: every component is covered.</p>` : html`<ul class="flow-rows" data-field="members">${nodes.map((node) => html`<li class="flow-row" data-component="${node.folder}">${flowPick(node.id, flowName(node))}<span class="flow-meta">${node.core ? `core dependency, called by ${node.in}` : `called by ${node.in}`}; ${node.invariants.length === 0 ? "declares no invariant" : stateWords(node).replace(/; not covered$/, "")}</span></li>`)}</ul>`}
    </div>`;
  }
  const members = flowHealthMembers(model, kind);
  const summary = kind === "verified"
    ? html`Each is an ${termLink(state, "invariant")}: enforced, its enforcement seen to fire, and verified by the latest run that checked it.`
    : kind === "requirements"
      ? html`Each is a ${termLink(state, "requirement")}: declared, and nothing yet detects its violation, so it is not enforced. Its identifier on the map is hatched, not solid.`
      : kind === "defects"
        ? html`Each is a ${termLink(state, "structural defect")}: an invariant whose enforcement no longer holds.`
        : kind === "broken"
          ? html`Each is broken: a ${termLink(state, "structural defect")}, or a ${termLink(state, "requirement")} whose ${termLink(state, "chokepoint")} check found a ${termLink(state, "bypass")}.`
          : html`Each is a ${termLink(state, "requirement")} whose ${termLink(state, "chokepoint")} check found a ${termLink(state, "bypass")}: broken, though never enforced.`;
  const byComponent = [...new Set(members.map((m) => m.component))];
  return html`<div class="flow-inspect" data-kind="health" data-health="${kind}">
    ${flowHead("Health", html`${healthWords(kind, members.length)}`, `${flowHealthId(kind)}-heading`, summary)}
    ${members.length === 0 ? html`<p class="flow-note">None.</p>` : join(byComponent.map((component) => {
      const holder = model.nodes.find((n) => n.invariants.some((i) => i.component === component) && n.defects.length > 0);
      return html`<h4>${component === "." ? "The root" : component} <span class="flow-count">${members.filter((m) => m.component === component).length}</span>${(kind === "broken" || kind === "bypassed" || kind === "defects") && holder !== undefined ? html` ${flowPick(flowBrokenId(holder.folder), "see the bypass sites")}` : null}</h4><ul class="flow-rows" data-field="members">${members.filter((m) => m.component === component).map((m) => invariantRow(model, m))}</ul>`;
    }))}
  </div>`;
}

function renderFlowSummary(state: ShellState, model: FlowModel, previews: readonly StructurePreview[]): Markup {
  const bearing = model.edges.filter((edge) => edge.loadBearing).length;
  const broken = model.edges.filter((edge) => edge.bypasses.length > 0).length;
  const onRoutes = model.edges.filter((edge) => edge.routes.length > 0).length;
  const stubs = model.edges.filter((edge) => edge.stub).length;
  return html`<div class="flow-summary">
    ${flowHead("Nothing selected", html`The whole system`, undefined, `${plural(model.nodes.length, "component", "components")} and ${plural(model.edges.length, "component interface", "component interfaces")}. Select anything to trace it; the rest dims.`)}
    ${model.sitesUnknown.length === 0 ? null : html`<p class="flow-note" data-field="sites-unknown">Run sites unknown for ${model.sitesUnknown.length === 1 ? "one chokepoint" : `${model.sitesUnknown.length} chokepoints`}, so their interfaces are not drawn: ${model.sitesUnknown.join("; ")}</p>`}
    ${model.edges.length === 0 ? html`<p class="empty" data-field="no-interfaces">No component interface is known: ${model.evidence === "run sites only" ? "no latest run records a reference from one component into another's chokepoint or protected thing, and the language adapter was not asked." : "no component's code references another's."}</p>` : null}
    <h4>Where work enters</h4>
    ${model.routesFrom === "root interfaces" ? html`<p class="flow-note" data-field="derived-routes">No spec declares an entrance. Each route is ${termLink(state, "derived")} from one of the root component's component interfaces by ${termLink(state, "reference weight")}, not flow, and named for the first component it reaches.</p>` : null}
    ${model.entrances.length === 0 && model.routesFrom !== "root interfaces" ? html`<p class="flow-note" data-field="no-entrances">No spec declares an entrance, and there is no root component to derive routes from.</p>` : null}
    <ul class="flow-rows" data-field="routes">${model.routes.map((route) => routeRow(model, route))}</ul>
    ${model.entrances.length === 0 ? null : html`<details class="flow-entrances"><summary>Entrances <span class="flow-count">${model.entrances.length}</span></summary><ul class="flow-rows">${model.entrances.map((e) => flowRow(flowPick(e.id, e.name, e.id), e.reachable ? `starts in ${e.start === "." ? "the root" : e.start}${e.trust.length === 0 ? ", trust unknown" : `, carries ${trustInWords(e)}`}` : e.reason ?? ""))}</ul></details>`}
    <h4>Component interfaces</h4>
    ${flowFacts([
      ["On routes", `${onRoutes}`],
      [html`Stubs to ${termLink(state, "core dependency", "core dependencies")}`, `${stubs}`],
      ["Load-bearing", html`${bearing} <span class="flow-meta">a ${termLink(state, "chokepoint")} or a ${termLink(state, "crossing")} stands there</span>`],
      broken > 0 ? ["Broken", html`<span class="flow-bad">${broken}</span>`] : null,
      ["Others", html`${model.edges.length - onRoutes - stubs} <span class="flow-meta">drawn faint when a selection reaches them</span>`],
    ])}
    ${model.coreDependencies.length === 0 ? null : html`<h4>Core dependencies</h4><p class="flow-note" data-field="core-rule">A ${termLink(state, "core dependency")} is ${CORE_RULE}. Drawn as a rail; each caller's stub runs down to it.</p><ul class="flow-rows">${model.coreDependencies.map((core) => {
      const node = model.nodes.find((n) => n.folder === core.folder)!;
      return flowRow(flowPick(node.id, node.name), `called by ${core.callers.map((c) => (c === "." ? "the root" : c)).join(", ")}`);
    })}</ul>`}
    <h4>Interface identifiers</h4>
    ${model.identifiers.length === 0 ? html`<p class="flow-note">No chokepoint stands on a component interface or an entrance line.</p>` : html`<ul class="flow-rows" data-field="identifiers">${model.identifiers.map((identifier) => flowRow(flowPick(identifier.chokepoint, identifier.name), html`${verdictMark(identifier)} · ${identifier.component}${identifier.crossing === undefined ? "" : `, crossing ${identifier.crossing.from} → ${identifier.crossing.to}`}`, "line", html`<span class="flow-ident" data-verdict-state="${identifier.verdict.state}">${identifier.text}</span>`))}</ul>`}
    <h4>Where data goes, by trust level</h4>
    <ul class="flow-rows">${model.levels.map((level) => {
      const drawn = model.crossings.filter((c) => c.from === level.name || c.to === level.name).length;
      return flowRow(flowPick(level.id, level.name, level.id), plural(drawn, "crossing", "crossings"), "count");
    })}</ul>
    <h4>What changed</h4>
    <ul class="flow-rows">${flowRow(flowPick(FLOW_CHANGE_ID, "What this change touches and weakens", FLOW_CHANGE_ID), "comparison with the previous commit")}</ul>
    <details class="flow-chokepoints"><summary>Chokepoints <span class="flow-count">${model.chokepoints.length}</span></summary>
      <ul class="flow-rows">${model.chokepoints.map((c) => flowRow(flowPick(c.id, c.name, c.id), html`${verdictMark(c)} · <code>${c.chokepoint}</code> in ${c.component}`))}</ul>
    </details>
    ${previews.length === 0 ? null : html`<h4>Proposed</h4><ul>${previews.map((p) => html`<li data-proposed="true">proposed preview · ${p.name}: ${p.crossing.from} → ${p.crossing.to} in ${p.component}. Reliance unknown: a proposal has no run evidence. This dashed edge exists only in the ephemeral preview.</li>`)}</ul>`}
  </div>`;
}

/** A route's stops as rows: each component interface it takes, with its identifiers or its site count. */
function renderRouteBody(state: ShellState, model: FlowModel, route: FlowRoute, named: boolean): Markup {
  return html`${named ? html`<p class="flow-sub">${routeSwatch(route)} <strong>${routeName(route)}</strong>: ${routeStops(model, route)}</p>` : null}
    ${renderRouteTrust(state, model, route)}
    ${route.entry.length === 0 ? null : html`<p class="flow-note" data-field="entry">Where work enters, its handler is itself a ${termLink(state, "chokepoint")}: ${route.entry.join(" ")} stand on the line from its entrances${route.trust.length === 0 ? "" : `, carrying ${route.trust.join(", ")} in`}.</p>`}
    <h4>Interfaces along it <span class="flow-count">${route.edges.length}</span></h4>
    ${route.edges.length === 0 ? html`<p class="flow-note">None: its handler's reach calls no other component except core dependencies${route.rail === undefined ? "" : `; it ends in the ${route.rail} rail`}.</p>` : html`<ul class="flow-rows">${route.edges.map((id) => model.edges.find((edge) => edge.id === id)!).map((edge) => flowRow(flowPick(edge.id, edgeName(edge)), edge.identifiers.length === 0 ? plural(edge.sites, "site", "sites") : `${edge.identifiers.join(" ")} · ${plural(edge.sites, "site", "sites")}`, "count"))}</ul>`}
    <details class="flow-more"><summary>How a route is followed</summary><p>${route.followed === "reach" ? `By its handler's reach: ${ROUTE_RULE}.` : html`By ${termLink(state, "reference weight")}, not flow: the adapter read no handler reach, so from each stop the route follows the heaviest component interface (most reference sites) to a component not yet on it, not a core dependency, and not in a column left of the one it stands in.`}</p></details>`;
}

function renderEntranceInspector(state: ShellState, model: FlowModel, entrance: FlowEntrance): Markup {
  const route = model.routes.find((candidate) => candidate.entrances.includes(entrance.id));
  return html`<div class="flow-inspect" data-kind="entrance">
    ${flowHead("Entrance", html`${entrance.name}`, `${entrance.id}-heading`, entrance.meaning)}
    ${flowFacts([
      ["Declared by", html`<code>${entrance.declaredBy}</code>`],
      ["Handler", entrance.handler === undefined ? "none" : html`<code>${entrance.handler}</code>${entrance.module ? html` <span class="flow-meta" data-field="module">the module's top-level script</span>` : null}`],
      entrance.start === undefined ? null : ["Starts in", html`<code>${entrance.start}</code>`],
      entrance.noControl === undefined ? null : ["Control", html`<span data-field="no-control">${NO_CONTROL_NEEDED}</span> <span class="flow-meta" data-field="no-control-reason">control: none — ${entrance.noControl}</span>`],
      entrance.guard === undefined ? null : ["Guard", html`<code>${entrance.guard}</code> <span class="flow-meta" data-field="guard">${entrance.guardUnconfirmed === undefined ? (entrance.guards?.some((g) => g.how === "declared" || g.how === "wrapper") ? "declared, and its registration confirmed" : "declared; the reading did not confirm it") : `declared, not counted: ${entrance.guardUnconfirmed}`}</span>`],
    ])}
    ${entrance.reachable ? (route === undefined ? html`<p class="flow-note">Its route is not drawn.</p>` : renderRouteBody(state, model, route, true)) : html`<p class="empty" data-field="unreachable">${entrance.resolved ? "Unreachable" : "Unresolved"}: ${entrance.reason}</p>`}
  </div>`;
}

function renderRouteInspector(state: ShellState, model: FlowModel, route: FlowRoute): Markup {
  return html`<div class="flow-inspect" data-kind="route">
    ${flowHead(route.derived ? html`${termLink(state, "derived", "Derived")} structural route, by reference weight` : html`${termLink(state, "structural route", "Structural route")}`, html`${routeSwatch(route)} ${route.derived ? routeName(route) : plural(route.names.length, "entrance", "entrances")}`, `${route.id}-heading`, routeStops(model, route))}
    ${renderRouteBody(state, model, route, false)}
    ${route.derived ? html`<p class="flow-note">Derived from the root component's component interface to ${route.stops[1] ?? "nothing"} by reference weight: no spec declares an entrance, so the route is named for the first component it reaches and is not the path work takes.</p>` : html`<h4>Entrances it starts from <span class="flow-count">${route.entrances.length}</span></h4><ul class="flow-rows" data-field="entrances">${route.entrances.map((id) => model.entrances.find((e) => e.id === id)!).map((e) => flowRow(flowPick(e.id, e.name), e.meaning))}</ul>`}
  </div>`;
}

function renderLevelInspector(state: ShellState, model: FlowModel, level: FlowLevel): Markup {
  const edges = model.edges.filter((edge) => level.edges.includes(edge.id));
  const touching = (c: FlowCrossing): boolean => c.from === level.name || c.to === level.name;
  const atEntrances = model.routes.filter((r) => level.routes.includes(r.id));
  const marks = model.nodes.filter((n) => level.components.includes(n.folder));
  const total = model.crossings.filter(touching).length;
  return html`<div class="flow-inspect" data-kind="level">
    ${flowHead(html`${termLink(state, "trust level", "Trust level")}`, html`${level.name}`, `${level.id}-heading`, level.meaning)}
    <p class="flow-note">${plural(total, "crossing", "crossings")} carry it, every one drawn: on the interfaces its chokepoint stands on, on an entrance line, or on a component's boundary mark.</p>
    ${edges.length === 0 ? null : html`<h4>On component interfaces <span class="flow-count">${edges.length}</span></h4><ul class="flow-rows">${edges.map((edge) => flowRow(flowPick(edge.id, edgeName(edge)), edge.crossings.filter(touching).map((c) => `${c.name} (${c.from} → ${c.to}), ${c.verdict.label}`).join("; ")))}</ul>`}
    ${atEntrances.length === 0 ? null : html`<h4>Where work enters <span class="flow-count">${atEntrances.length}</span></h4><ul class="flow-rows">${atEntrances.map((route) => flowRow(flowPick(route.id, routeName(route)), model.crossings.filter((c) => touching(c) && c.routes.includes(route.id)).map((c) => `${c.name} (${c.from} → ${c.to})`).join("; ")))}</ul>`}
    ${marks.length === 0 ? null : html`<h4>Inside components <span class="flow-count">${marks.length}</span></h4><ul class="flow-rows">${marks.map((node) => flowRow(flowPick(flowBoundaryId(node.folder), node.name), node.boundary.filter(touching).map((c) => `${c.name} (${c.from} → ${c.to})`).join("; ")))}</ul>`}
    ${level.unplaced.length === 0 ? null : html`<h4>Crossings the map could not place</h4><ul class="flow-rows">${level.unplaced.map((c) => html`<li class="flow-row"><a href="#${invariantId(c.component, c.name)}">${c.name}</a><span class="flow-meta">${c.from} → ${c.to}, in ${c.component === "." ? "the root" : c.component}</span></li>`)}</ul>`}
    ${total === 0 ? html`<p class="flow-note" data-field="no-crossing">No crossing names this trust level.</p>` : null}
  </div>`;
}

/** How many of a component's invariants its inspector shows before folding the rest. */
const FLOW_INVARIANTS_SHOWN = 4;

/**
 * A component's inspector, in the order the owner asks of it: its verdict in
 * one line (broken first, and whether anything covers it), then who depends
 * on it (its callers, what a change to it affects) and what it uses, then its
 * invariants, the first few shown and the rest folded; its routes and
 * load-bearing interfaces after.
 */
function renderComponentInspector(state: ShellState, model: FlowModel, node: FlowNode): Markup {
  const out = model.edges.filter((edge) => edge.from === node.folder);
  const into = model.edges.filter((edge) => edge.to === node.folder);
  const bearing = [...out, ...into].filter((edge) => edge.loadBearing || edge.bypasses.length > 0);
  const through = model.routes.filter((r) => r.stops.includes(node.folder) || r.rail === node.folder);
  const count = (s: FlowState): number => node.invariants.filter((i) => i.verdict.state === s).length;
  const verdict = node.invariants.length === 0
    ? "It declares no invariant: nothing here is enforced."
    : [count("broken") > 0 ? `${count("broken")} broken` : "", count("requirement") > 0 ? `${plural(count("requirement"), "requirement", "requirements")} not enforced` : "", count("verified") > 0 ? `${count("verified")} verified` : ""].filter(Boolean).join(", ");
  const name = (folder: string): string => (folder === "." ? "root" : folder);
  const shown = node.invariants.slice(0, FLOW_INVARIANTS_SHOWN);
  const folded = node.invariants.slice(FLOW_INVARIANTS_SHOWN);
  return html`<div class="flow-inspect" data-kind="component">
    ${flowHead(node.core ? html`${termLink(state, "core dependency", "Core dependency")}` : html`${termLink(state, "component", "Component")}`, html`<a href="#${componentId(node.folder)}">${flowName(node)}</a>`, undefined, node.intent)}
    <p class="flow-verdict-line${count("broken") > 0 ? " flow-bad" : ""}" data-field="own-verdicts">${verdict}</p>
    ${node.covered ? null : html`<p class="flow-note flow-attention" data-field="uncovered">Not covered: no ${termLink(state, "chokepoint")} stands on an interface it exposes or where work enters it, and none of its invariants is verified by a ${termLink(state, "totality oracle")}.</p>`}
    ${node.defects.length === 0 ? null : html`<p><button type="button" class="flow-pick flow-action flow-bad" data-structure-select="${flowBrokenId(node.folder)}">${plural(node.defects.length, "broken chokepoint", "broken chokepoints")}: see the bypass sites</button></p>`}
    <h4 data-field="callers">Who depends on it <span class="flow-count">${into.length}</span> <span class="flow-meta">its callers: a change here reaches them</span></h4>
    ${into.length === 0 ? html`<p class="flow-note">Nothing calls it${node.declaresEntrance ? "; work enters here" : ""}.</p>` : html`<ul class="flow-rows">${into.map((edge) => flowRow(flowPick(edge.id, `← ${name(edge.from)}`), `${plural(edge.symbols.length, "symbol", "symbols")}${edge.identifiers.length === 0 ? "" : ` · ${edge.identifiers.join(" ")}`}`, "count"))}</ul>`}
    <h4 data-field="callees">What it uses <span class="flow-count">${out.length}</span></h4>
    ${out.length === 0 ? html`<p class="flow-note">It calls no other component.</p>` : html`<ul class="flow-rows">${out.map((edge) => flowRow(flowPick(edge.id, `→ ${name(edge.to)}`), `${plural(edge.symbols.length, "symbol", "symbols")}${edge.identifiers.length === 0 ? "" : ` · ${edge.identifiers.join(" ")}`}`, "count"))}</ul>`}
    <h4 data-field="own-invariants">Its invariants <span class="flow-count">${node.invariants.length}</span></h4>
    ${node.invariants.length === 0 ? null : html`<ul class="flow-rows" data-field="invariants">${shown.map((ref) => invariantRow(model, ref))}</ul>${folded.length === 0 ? null : html`<details class="flow-more flow-invariants-more"><summary>+${folded.length} more</summary><ul class="flow-rows">${folded.map((ref) => invariantRow(model, ref))}</ul></details>`}`}
    ${node.boundary.length === 0 ? null : html`<p><button type="button" class="flow-pick flow-action" data-structure-select="${flowBoundaryId(node.folder)}">${plural(node.boundary.length, "crossing", "crossings")} inside it</button></p>`}
    ${node.children > 0 ? html`<p><button type="button" class="flow-pick flow-action" data-structure-expand="${node.folder}">${node.expanded ? "Close" : "Open"} its ${plural(node.children, "component", "components")} in place</button></p>` : null}
    ${node.core ? html`<p class="flow-note" data-field="core">A core dependency: ${CORE_RULE}. Drawn as a rail; each caller's stub runs down to it.</p>` : null}
    <h4 data-field="routes">Structural routes through it (${through.length})</h4>
    <ul class="flow-rows">${through.map((route) => routeRow(model, route))}</ul>
    <h4 data-field="load-bearing">Load-bearing here (${bearing.length})</h4>
    ${bearing.length === 0 ? html`<p class="flow-note">No chokepoint or crossing stands on its component interfaces.</p>` : html`<ul class="flow-rows">${bearing.map((edge) => flowRow(flowPick(edge.id, edgeName(edge)), flowLabelLines(edge).map((l) => l.text).join(", ")))}</ul>`}
    ${flowFacts([["Folder", html`<code>${node.folder}</code>`]])}
  </div>`;
}

/** A component's broken chokepoints: every bypass site, and, when all sit inside the component, that it says so and lists them. */
function renderBrokenInspector(state: ShellState, model: FlowModel, node: FlowNode): Markup {
  return html`<div class="flow-inspect" data-kind="broken">
    ${flowHead(html`Broken ${termLink(state, "chokepoint", "chokepoints")}`, html`<a href="#${componentId(node.folder)}">${node.name}</a>: ${plural(node.defects.length, "broken chokepoint", "broken chokepoints")}`, `${flowBrokenId(node.folder)}-heading`, html`A ${termLink(state, "bypass")} reaches a protected thing from outside its chokepoint.`)}
    ${join(node.defects.map((defect) => {
      const ref = node.invariants.find((i) => i.name === defect.name);
      const inside = defect.sites.filter((s) => s.inside);
      const outside = defect.sites.filter((s) => !s.inside);
      return html`<section class="flow-defect" data-defect="${defect.name}">
        <h4>${flowPick(defect.chokepoint, defect.name)} ${ref === undefined ? null : verdictMark(ref)}</h4>
        <p class="flow-note" data-field="where">${defect.sites.length === 0 ? "The latest run failed it and recorded no bypass site." : inside.length === defect.sites.length ? `All ${plural(defect.sites.length, "bypass", "bypasses")} sit inside ${node.name}, so no component interface carries them; they are listed here.` : `${plural(outside.length, "bypass", "bypasses")} from other components, drawn on their interfaces; ${inside.length} inside ${node.name}.`}</p>
        <ul class="site-list" data-field="sites">${defect.sites.map((s) => html`<li data-class="bypass" data-inside="${s.inside ? "true" : "false"}"><code>${s.file}:${s.line}</code> in <code>${s.symbol}</code>${s.inside ? html` <span class="label">inside</span>` : null}</li>`)}</ul>
        ${renderFlowOptions(node.folder, defect.name, [model.chokepoints.find((c) => c.id === defect.chokepoint)?.chokepoint ?? defect.name])}
      </section>`;
    }))}
  </div>`;
}

/** The crossings standing inside a component, on no drawn interface or entrance line: its boundary mark's inspector. */
function renderBoundaryInspector(state: ShellState, model: FlowModel, node: FlowNode): Markup {
  const pairs = [...new Set(node.boundary.map((c) => `${c.from} → ${c.to}`))];
  return html`<div class="flow-inspect" data-kind="boundary">
    ${flowHead(html`Trust boundaries inside a component`, html`<a href="#${componentId(node.folder)}">${node.name}</a>: ${plural(node.boundary.length, "crossing", "crossings")}`, `${flowBoundaryId(node.folder)}-heading`, html`Each ${termLink(state, "crossing")} stands inside ${node.name}: both sides of its chokepoint are in it, or it has no chokepoint, so no component interface can carry it.`)}
    ${join(pairs.map((pair) => {
      const members = node.boundary.filter((c) => `${c.from} → ${c.to}` === pair);
      return html`<h4>${pair} <span class="flow-count">${members.length}</span></h4><ul class="flow-rows" data-field="crossings">${members.map((c) => invariantRow(model, c))}</ul>`;
    }))}
  </div>`;
}

function renderEdgeInspector(state: ShellState, model: FlowModel, edge: FlowEdge): Markup {
  const shown = edge.symbols.slice(0, 24);
  const byInvariant = [...new Set(edge.bypasses.map((b) => b.invariant))];
  const through = model.routes.filter((route) => edge.routes.includes(route.id));
  const kind = edge.bypasses.length > 0 ? html`Broken component interface, ${plural(edge.bypasses.length, "bypass", "bypasses")}` : edge.loadBearing ? "Load-bearing component interface" : html`${termLink(state, "component interface", "Component interface")}`;
  return html`<div class="flow-inspect" data-kind="edge">
    ${flowHead(kind, html`${edgeName(edge)}`, undefined, `Code in ${edge.from} references ${plural(edge.symbols.length, "symbol", "symbols")} of ${edge.to} at ${plural(edge.sites, "site", "sites")}.`)}
    ${flowFacts([
      ["Drawn", edge.stub ? "A stub: its callee is a core dependency, drawn as a rail." : through.length > 0 ? `On ${through.map(routeName).join("; ")}.` : "On no structural route: drawn faint when a selection reaches it."],
    ])}
    ${edge.identifiers.length === 0 ? null : html`<h4>Interface identifiers</h4><ul class="flow-rows" data-field="identifiers">${edge.identifiers.map((text) => { const found = model.identifiers.find((i) => i.text === text)!; return flowRow(flowPick(found.chokepoint, found.name), verdictMark(found), "line", html`<span class="flow-ident" data-verdict-state="${found.verdict.state}">${text}</span>`); })}</ul>`}
    ${edge.chokepoints.length === 0 ? null : html`<h4>Chokepoints standing here</h4><ul class="flow-rows">${edge.chokepoints.map((c) => flowRow(flowPick(c.id, c.name), html`<code>${c.chokepoint}</code> protects ${codeOrText(c.protects)} · ${verdictMark(c)}`))}</ul>`}
    ${edge.crossings.length === 0 ? null : html`<h4>Crossings</h4><ul class="flow-rows">${edge.crossings.map((c) => html`<li class="flow-row">${c.from} → ${c.to}<span class="flow-meta">${c.name}</span></li>`)}</ul>`}
    ${edge.bypasses.length === 0 ? null : html`<div class="defect" data-field="defect"><h5>Bypass sites</h5><ul class="site-list">${edge.bypasses.map((b) => html`<li data-class="bypass"><code>${b.file}:${b.line}</code> in <code>${b.symbol}</code> <span class="site-role">bypass of the protected thing of ${b.invariant}</span></li>`)}</ul>${join(byInvariant.map((name) => renderFlowOptions(edge.to, name, edge.chokepoints.filter((c) => c.name === name).map((c) => c.chokepoint))))}</div>`}
    <h4>Symbols <span class="flow-count">${edge.symbols.length}</span></h4>
    <ul class="flow-rows flow-symbols">${shown.map((s) => html`<li class="flow-row flow-row-count"><code>${s.symbol}</code><span class="flow-meta">${s.file === "" ? "" : `${s.file}, `}${plural(s.sites, "site", "sites")}${s.kind === "type" ? ", type" : ""}</span></li>`)}</ul>
    ${edge.symbols.length > shown.length ? html`<p class="flow-note">and ${edge.symbols.length - shown.length} more</p>` : null}
  </div>`;
}

/**
 * An interface identifier's inspector: the invariant behind the chokepoint,
 * its one verdict, and where it stands on the map. What an agent needs
 * (per-enforcement records and test commands, the refutation record, the
 * reliance sites, the two options) folds beneath, closed.
 */
function renderChokepointInspector(state: ShellState, model: FlowModel, chokepoint: FlowChokepoint, selection: FlowSelection): Markup {
  const invariant = state.spec.components.find((c) => c.folder === chokepoint.component)?.invariants.find((i) => i.name === chokepoint.name);
  const reliance = invariant === undefined ? [] : relianceOf(invariant, state.spec.components, state.runs.records).filter((r) => r.chokepoint === chokepoint.chokepoint);
  const edges = model.edges.filter((edge) => selection.edges.has(edge.id));
  const identifier = model.identifiers.find((i) => i.chokepoint === chokepoint.id);
  const through = model.routes.filter((route) => edges.some((edge) => edge.routes.includes(route.id) || (edge.stub && route.rail === edge.to && route.stops[route.stops.length - 1] === edge.from)) || (identifier?.routes.includes(route.id) ?? false));
  const meaning = (level: string): string => state.spec.trustLevels.find((l) => l.name === level)?.meaning ?? "not a declared trust level";
  const bypasses = invariant === undefined ? [] : latestOf(invariant, state.runs.records).filter((entry) => entry.form === "chokepoint").flatMap((entry) => entry.bypasses);
  return html`<div class="flow-inspect" data-kind="chokepoint" data-reliance-of="${chokepoint.name}">
    ${flowHead(identifier === undefined ? html`${termLink(state, "chokepoint", "Chokepoint")} and its reliance` : html`${termLink(state, "interface identifier", "Interface identifier")} <span class="flow-ident" data-verdict-state="${identifier.verdict.state}">${identifier.text}</span>`, html`<a href="#${invariantId(chokepoint.component, chokepoint.name)}">${chokepoint.name}</a>`, `${chokepoint.id}-heading`, invariant === undefined ? null : html`<span data-field="sentence">${invariant.sentence}</span>`)}
    ${flowFacts([
      ["Verdict", html`<span data-field="verdict">${verdictMark(chokepoint)}</span>`],
      ["Component", html`<code>${chokepoint.component}</code>`],
      [html`${termLink(state, "chokepoint", "Chokepoint")}`, html`<code>${chokepoint.chokepoint}</code>`],
      ["Protects", codeOrText(chokepoint.protects)],
      invariant?.crossing === undefined ? null : [html`${termLink(state, "crossing", "Crossing")}`, html`<span class="crossing" data-field="crossing"><span class="level">${invariant.crossing.from}</span> → <span class="level">${invariant.crossing.to}</span></span>`],
      ["Stands on", `${plural(edges.length, "interface", "interfaces")}${identifier !== undefined && identifier.routes.length > 0 ? `, and where work enters by ${plural(identifier.routes.length, "route", "routes")}` : ""}`],
    ])}
    ${invariant?.crossing === undefined ? null : html`<dl class="flow-levels"><dt><span class="level">${invariant.crossing.from}</span></dt><dd>${meaning(invariant.crossing.from)}</dd><dt><span class="level">${invariant.crossing.to}</span></dt><dd>${meaning(invariant.crossing.to)}</dd></dl>`}
    ${bypasses.length === 0 ? null : html`<div class="defect" data-field="defect"><h5>${termLink(state, "bypass", "Bypass")} sites</h5><ul class="site-list">${bypasses.map((b) => html`<li data-class="bypass"><code>${b.file}:${b.line}</code> in <code>${b.symbol}</code></li>`)}</ul>${renderFlowOptions(chokepoint.component, chokepoint.name, [chokepoint.chokepoint])}</div>`}
    <h4>The component interfaces it stands on (${edges.length})</h4>
    <ul class="flow-rows" data-field="interfaces">${edges.map((edge) => flowRow(flowPick(edge.id, edgeName(edge)), `${plural(edge.symbols.length, "symbol", "symbols")}${edge.stub ? ", a stub to a core dependency" : ""}`, edge.stub ? "line" : "count"))}</ul>
    <h4 data-field="routes-through">Structural routes through it (${through.length})</h4>
    ${through.length === 0 ? html`<p class="flow-note">No structural route passes the interfaces it stands on.</p>` : html`<ul class="flow-rows">${through.map((route) => routeRow(model, route))}</ul>`}
    ${invariant === undefined ? null : html`<details class="flow-more flow-enforcement flow-agent"><summary>Enforcement record, for agents <span class="flow-meta">${enforcementSummary(state, invariant)}</span></summary><ul class="enforcements">${join(invariant.enforcements.map((enforcement) => renderEnforcement(state, invariant, enforcement)))}</ul></details>`}
    ${invariant === undefined ? null : html`<details class="flow-more flow-refutation flow-agent"><summary>${termLink(state, "refutation", "Refutation")} record</summary>${renderRefutation(invariant, state.runs.records)}</details>`}
    <details class="flow-more flow-reliance flow-agent"><summary>${termLink(state, "reliance", "Reliance")}: the recorded reference sites</summary>
    ${join(reliance.map((r) => r.evidence.status === "unknown"
      ? html`<p class="flow-note" data-reliance="unknown">${r.evidence.reason}</p>`
      : r.evidence.sites.length === 0 && r.evidence.left === 0
        ? html`<p class="flow-note" data-reliance="complete">Complete run site evidence records 0 references to the chokepoint or protected thing.</p>`
        : html`<p class="flow-note" data-reliance="complete">${plural(r.evidence.sites.length + r.evidence.left, "recorded reference site", "recorded reference sites")} to the chokepoint or protected thing; owner component first.${r.evidence.left === 0 ? "" : ` This page lists ${r.evidence.sites.length} of them.`}</p>${r.evidence.left === 0 || r.entry === undefined ? null : renderSitesLeft(state, r.entry, r.chokepoint, r.evidence.left)}<ul class="site-list">${r.evidence.sites.map(flowSite)}</ul>`))}
    </details>
    ${invariant !== undefined && invariant.state === "structural defect" && bypasses.length === 0 ? renderFlowOptions(chokepoint.component, chokepoint.name, [chokepoint.chokepoint]) : null}
  </div>`;
}

/** The enforcement forms, for the folded record's heading: the forms only; the one verdict is above. */
function enforcementSummary(state: ShellState, invariant: NonNullable<ShellState["spec"]["components"][number]["invariants"][number]>): string {
  void state;
  return invariant.enforcements.map((enforcement) => (enforcement.form === "chokepoint" ? "chokepoint" : "totality oracle")).join(", ");
}

function renderChangeInspector(): Markup {
  return html`<div class="flow-inspect" data-kind="change">
    ${flowHead("Change", html`What this change touches and weakens`, `${FLOW_CHANGE_ID}-heading`, "No second state is in this page, so nothing is lit.")}
    <p data-field="change-placeholder">Structure compares this state with the previous commit, or with a commit the agent names, in the next slice. The comparison is already one pure function over two maps, <code>compareFlows</code>, and it measures what the change touched and what it weakened:</p>
    <ul class="flow-list" data-field="measures">
      <li>entrance added or removed</li>
      <li>component interface added, removed, or widened (references new symbols)</li>
      <li>chokepoint gaining a bypass</li>
      <li>crossing added or removed</li>
      <li>data path gaining a branch</li>
    </ul>
  </div>`;
}

/**
 * The one inspector, beside the map: whatever is selected, else the map's
 * summary. Open while something is selected; closed by its close button or
 * Escape, which clear the selection. The selection hash reopens it. When the
 * selection is only the default story (the reader chose nothing), it is
 * marked so: below the side-by-side width it then stays in the page's flow
 * under the map instead of opening as a sheet over it.
 */
function renderFlowInspector(state: ShellState, model: FlowModel, selection: FlowSelection, previews: readonly StructurePreview[], chosen: boolean): Markup {
  const health = FLOW_HEALTH_KINDS.find((kind) => flowHealthId(kind) === selection.id);
  const body =
    selection.kind === "entrance"
      ? renderEntranceInspector(state, model, model.entrances.find((e) => e.id === selection.id)!)
      : selection.kind === "route"
        ? renderRouteInspector(state, model, model.routes.find((r) => r.id === selection.id)!)
      : selection.kind === "level"
        ? renderLevelInspector(state, model, model.levels.find((l) => l.id === selection.id)!)
        : selection.kind === "component"
          ? renderComponentInspector(state, model, model.nodes.find((n) => n.id === selection.id)!)
          : selection.kind === "edge"
            ? renderEdgeInspector(state, model, model.edges.find((e) => e.id === selection.id)!)
            : selection.kind === "chokepoint"
              ? renderChokepointInspector(state, model, model.chokepoints.find((c) => c.id === selection.id)!, selection)
              : selection.kind === "health" && health !== undefined
                ? renderHealthInspector(state, model, health)
                : selection.kind === "broken"
                  ? renderBrokenInspector(state, model, model.nodes.find((n) => flowBrokenId(n.folder) === selection.id)!)
                  : selection.kind === "boundary"
                    ? renderBoundaryInspector(state, model, model.nodes.find((n) => flowBoundaryId(n.folder) === selection.id)!)
                    : selection.kind === "change"
                      ? renderChangeInspector()
                      : null;
  const open = body !== null;
  return html`<aside class="flow-inspector" aria-label="Structure inspector" data-selection="${selection.kind}" data-open="${open ? "true" : "false"}" data-default="${open && !chosen ? "true" : "false"}"${open ? raw(' role="dialog" aria-modal="false"') : null}>
    ${open ? html`<button type="button" class="flow-close" data-structure-close data-structure-select="${FLOW_NONE_ID}" aria-label="Close the inspector" title="Close (Escape)">×</button>` : null}
    ${body ?? renderFlowSummary(state, model, previews)}
  </aside>`;
}

/** One entry of the key: a small drawing of the mark, and what it means. */
function keyItem(glyph: string, label: Markup | string): Markup {
  return html`<li><svg class="flow-key-glyph" viewBox="0 0 28 14" width="28" height="14" aria-hidden="true">${raw(glyph)}</svg><span>${label}</span></li>`;
}

/** The key's hatch, drawn as the map draws a requirement's identifier. */
const KEY_HATCH = '<defs><pattern id="flow-key-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="1.2" height="4" fill="var(--flow-key-quiet)"/></pattern></defs>';

/** The key below the map: each mark and what it is, the terms it uses, and how the map is laid out, folded beneath. */
function renderFlowKey(state: ShellState): Markup {
  return html`<div class="flow-key" data-field="key">
    <ul aria-label="Map key">
      ${keyItem('<path d="M1 7 H27" stroke="var(--flow-key-route-0)" stroke-width="3.5"/>', html`${termLink(state, "structural route", "Structural route")}: the path its entrances' handler takes; its origin token names up to four entrances and counts the rest, and the tag beneath it, under the base of its point, is the ${termLink(state, "trust level")} they carry in (unknown: not derived, treated as untrusted)`)}
      ${keyItem('<path d="M5 1.5 H14 L18 5.5 L14 9.5 H3 V3.5 Z" fill="var(--paper)" stroke="currentColor" stroke-opacity="0.42"/><path d="M7 3 H16 L20 7 L16 11 H5 V5 Z" fill="var(--paper)" stroke="currentColor" stroke-opacity="0.6"/><path d="M9 4.5 H18 L22 8.5 L18 12.5 H7 V6.5 Z" fill="var(--paper)" stroke="currentColor"/><path d="M22 8.5 H28" stroke="var(--flow-key-route-0)" stroke-width="2.5"/>', html`Origin token: its point is where work leaves it for the system, and a component's card never has one. One card is one ${termLink(state, "entrance")}; two stacked cards, two entrances sharing the route; three, three or more. The tag beneath says the trust they carry in`)}
      ${keyItem('<path d="M5 2 H26 V9 L23 12 H2 V5 Z" fill="none" stroke="currentColor" stroke-dasharray="3 2"/>', html`${termLink(state, "derived", "Derived")} route: no entrance declared, drawn by ${termLink(state, "reference weight")}, not flow`)}
      ${keyItem('<path d="M6 1.5 H26 V9 L22.5 12.5 H2 V5.5 Z" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="4" y="5.5" width="2.5" height="5" rx="1" fill="currentColor"/>', html`${termLink(state, "component", "Component")}: its name, its role, its folder; the bar at its left is its worst verdict; a heavier border declares an entrance`)}
      ${keyItem('<rect x="4" y="1.5" width="20" height="11" rx="2.5" fill="var(--flow-key-verified)"/><text x="8" y="10.2" font-size="8.5" font-weight="500" fill="var(--paper)">C</text>', html`${termLink(state, "interface identifier", "Interface identifier")}, solid fill: its ${termLink(state, "invariant")} is enforced and verified`)}
      ${keyItem(`${KEY_HATCH}<rect x="4" y="1.5" width="20" height="11" rx="2.5" fill="url(#flow-key-hatch)" stroke="currentColor"/><text x="8" y="10.2" font-size="8.5" font-weight="500" fill="currentColor">C</text>`, html`Hollow and hatched: a ${termLink(state, "requirement")}, not enforced, so not a working control`)}
      ${keyItem('<rect x="4" y="1.5" width="20" height="11" rx="2.5" fill="var(--flow-key-broken)"/><text x="8" y="10.2" font-size="8.5" font-weight="500" fill="#fff">C</text>', html`Red fill: broken, a ${termLink(state, "structural defect")} or a ${termLink(state, "chokepoint")} with a ${termLink(state, "bypass")}; a component with one carries a red broken mark that lists its bypass sites. Red means broken and nothing else`)}
      ${keyItem('<rect x="1" y="2" width="11" height="10" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M17 2 H24 L27 7 L24 12 H17 L14 7 Z" fill="none" stroke="currentColor" stroke-width="1.3"/>', html`C = ${termLink(state, "chokepoint")}, rounded: the one site every reference to a protected thing passes. X = ${termLink(state, "crossing")}, pointed: a chokepoint whose invariant names the trust levels on either side of it`)}
      ${keyItem('<circle cx="7" cy="7" r="4" fill="var(--flow-key-verified)"/><path d="M20 2 L25 7 L20 12 L15 7 Z" fill="var(--flow-key-verified)"/>', "A dot: the same identifier drawn in full elsewhere on the map; select it to select that identifier")}
      ${keyItem('<path d="M14 0 V14" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2"/><path d="M1 7 H27" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>', html`Trust boundary: where a crossing's ${termLink(state, "trust level")} changes, on its interface, on the line where work enters, or dashed along a component's edge for the crossings inside it (their count shows when a trust level or the component is selected)`)}
      ${keyItem('<path d="M4 0.5 H24 V4.5 L21 7.5 H1 V3.5 Z" fill="none" stroke="currentColor"/><path d="M12 11.5 H24" stroke="var(--flow-key-attention)" stroke-width="2.5"/>', html`Amber, attention, not breakage: <strong>no traced control</strong>, the tag beneath an untrusted route's token when no verified chokepoint or totality oracle was traced on it (on its lines, wrapping its handler, inside a component on it, or covering its trust); the route's inspector names each control it has and how it was traced; <strong>not covered</strong>, on a component no enforcement covers, whose bar is hollow`)}
      ${keyItem('<path d="M1 11 H27" stroke="var(--flow-key-rail)" stroke-width="4" stroke-linecap="round"/><path d="M8 1 V11" stroke="var(--flow-key-rail)" stroke-width="1.5"/>', html`${termLink(state, "core dependency", "Core dependency")} (rail) and a caller's stub to it`)}
      ${keyItem('<path d="M7 1.5 H25 V9 L21.5 12.5 H3 V5 Z" fill="none" stroke="var(--flow-key-halo)" stroke-width="5"/><path d="M7 1.5 H25 V9 L21.5 12.5 H3 V5 Z" fill="none" stroke="currentColor" stroke-width="2"/>', "Selected: a neutral halo and a heavier border, never a route's color")}
      ${keyItem('<path d="M1 4 H27" stroke="currentColor" stroke-width="1.8"/><path d="M1 10 H27" stroke="currentColor" stroke-width="1.6" stroke-dasharray="5 3"/>', "With a component selected: solid, a caller that depends on it; dashed, a callee it uses")}
      ${keyItem('<path d="M1 7 H27" stroke="var(--flow-key-quiet)" stroke-width="1.6"/>', "Load-bearing interface on no route")}
      ${keyItem('<path d="M1 7 H27" stroke="var(--flow-key-quiet)" stroke-width="1.4" stroke-dasharray="5 4"/>', "Interface a selection reached")}
      ${keyItem('<path d="M1 7 H27" stroke="var(--flow-key-quiet)" stroke-width="2"/><path d="M11 3 L15 7 L11 11" fill="none" stroke="currentColor" stroke-width="1.6"/>', "Motion: while a route or a component is selected, faint dashes flow slowly along its lines, caller to callee; clear the selection to stop them. With reduced motion, chevrons point the same way")}
    </ul>
    <details class="flow-more flow-terms"><summary>Terms</summary>
      <dl class="flow-levels">${Object.entries(LOCAL_TERMS).map(([name, meaning]) => html`<dt><dfn id="structure--term-${slug(name)}">${name}</dfn></dt><dd>${meaning}</dd>`)}</dl>
    </details>
    <details class="flow-more flow-rules"><summary>How the map is laid out</summary>
      <ul class="flow-list">
        <li>A route: ${ROUTE_RULE}.</li>
        <li>Entrances share a route only when they share its stops and the trust they carry in: the entering side of the crossings whose chokepoint is their handler.</li>
        <li>A component's column is its distance from where work enters. Within a column components keep folder order, so adding an interface never reorders the ones it does not reach.</li>
        <li>An identifier on a rail stands on the stubs to that core dependency.</li>
        <li>The map opens on ${DEFAULT_RULE}.</li>
      </ul>
    </details>
  </div>`;
}

/**
 * The canvas and what says it scrolls: when the map is wider than the room it
 * has, a hint above it and a fade at the edge it continues past. Both are
 * CSS alone, from the map's own width, which the layout already knows.
 */
function renderCanvas(model: FlowModel, selected: string | undefined, previews: readonly StructurePreview[]): Markup {
  const svg = renderFlowSvg(model, selected, previews);
  const width = /width="(\d+)"/.exec(svg.text.slice(svg.text.indexOf("<svg")))?.[1] ?? "0";
  return html`<div class="flow-canvas-wrap" data-map-width="${width}">
    <style>${raw(`@container flow-canvas (max-width: ${Number(width) - 1}px) { .flow-scroll-hint { display: block; } .flow-fade-end { display: block; } }`)}</style>
    <p class="flow-scroll-hint" data-field="scroll-hint">The map is wider than this window: scroll it sideways to see the rest →</p>
    <div class="flow-canvas-frame">
      <div class="flow-canvas" tabindex="0" role="region" aria-label="Scrollable Structure map">${svg}</div>
      <div class="flow-fade flow-fade-end" aria-hidden="true"></div>
    </div>
  </div>`;
}

/** The one map: the evidence it stands on, the health strip, the canvas and the inspector beside it, and its key. */
export function renderFlowSection(state: ShellState, previews: readonly StructurePreview[] = state.structure.preview, model: FlowModel = flowOf(state)): Markup {
  // A scaffold preview is what its page is for: it opens on the whole system with the proposal named, never on a broken component.
  const selected = previews.length > 0 && state.structure.selected === undefined ? undefined : flowSelected(model, state.structure.selected);
  const selection = flowSelection(model, selected);
  return html`<section class="flow" aria-labelledby="flow-heading" data-interfaces="${String(model.edges.length)}">
    <style>${raw(keyVars())}</style>
    <div class="flow-head">
      <h3 id="flow-heading">Structure</h3>
      <p class="flow-lede">What the system is made of and how work flows through it. Select anything on the map to trace it.</p>
      ${renderEvidence(model)}
    </div>
    <div class="flow-stage">
      <div class="flow-map">
        ${renderHealthStrip(model, selected)}
        ${renderCanvas(model, selected, previews)}
      </div>
      ${renderFlowInspector(state, model, selection, previews, state.structure.selected !== undefined)}
    </div>
    ${renderFlowKey(state)}
  </section>`;
}

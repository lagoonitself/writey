import type { ChatMessage, ContentPart, ToolSpec } from './chat'
import type { Route } from './intent'

/** What the help engine captured from the page for one request. */
export type PageContext = {
  /** Data URL: the focus region with line tags drawn on. */
  focusImage: string
  /** Data URL: the whole page, small, with the focus region outlined. */
  pageImage: string
  labels: string[]
  /** Typed text boxes inside the focus region. */
  typedText: string[]
  /** PDF text inside the focus region. */
  pdfText: string
  /** True when the region came from a lasso selection. */
  selection: boolean
  /** Exact sources of Writey's own handwriting in the region (docs §5.1). */
  aiInk?: string[]
  /** What the student said out loud in the last 30 s (docs §7.2). */
  transcript?: string
  /** Pixel sizes [w, h] of image 1 and image 2, for pointing by coordinates. */
  imageSizes?: { focus: [number, number]; page: [number, number] }
  /** Printed (PDF) lines on the whole page as "[x0,y0,x1,y1] text", in image 2 pixels. */
  printed?: string[]
}

export type Turn = { role: 'user' | 'assistant'; text: string }

/** Turns sent with each request (docs §5.8). */
export const HISTORY_TURNS = 10

const SEEING = `You are looking at a student's handwritten notebook page.
- Image 1 is the area they are working on. Each line of their writing has a magenta tag (L1, L2, …) on its left. The tags are not part of their work; use them to refer to lines.
- Image 2 is the whole page, small, with that area outlined in magenta.
Read the handwriting carefully. If a line is unreadable, say so instead of guessing.
Both images have faint pixel rulers (every 100 px) along the top and left edges. You can point at anything you see by its pixel coordinates in either image, origin top-left, the way a computer-use model clicks on a screenshot.`

export const PLAN_SYSTEM = `You are Writey, a math and physics tutor inside a handwritten notebook.
${SEEING}

Work out what the student is doing and how to help. Reply with ONE JSON object and nothing else:
{"problem":"…","user_progress":"…","mode":"explain","scope":"next_step","target_line":"L3","status_line":"…"}

- problem: the problem being solved, one sentence. Math in LaTeX between $…$.
- user_progress: what they have done and where they are now, one sentence.
- mode: "write" if they want the next step(s) written out or something drawn on the page (a diagram, graph or sketch); "explain" if they want to understand something (a concept, a step, a circuit, a process, a structure): you answer like a tutor with a pen, sketching on the page and explaining beside it; "check" if they want their work checked; "both" for a short step plus an explanation; "chat" only for small talk, a one- or two-sentence answer that needs nothing on the page, or when they say not to write. If unsure, "explain".
- scope: "hint" for a nudge only, "next_step" for exactly one step, "full" for the complete solution.
- target_line: the line the request is about (e.g. "L3"), else their last line, or null if the page is empty.
- status_line: at most 12 words, spoken to the student, saying what you see. Example: "Integration by parts — you're on step 2".`

/** How Writey talks when the student is talking to it and spoken replies are on. */
const SPEAKING = `The student is talking to you out loud, and what you say is played back to them as speech. Talk like a tutor sitting beside them: warm, natural, short sentences, no lists, no symbols. Say math in words ("x squared over two", "the integral from zero to pi over two"). Answer what they actually asked; if they are just chatting or asking something small, simply answer it in a sentence or two. End with a short question back to them when it helps the conversation.`

/** Diagrams and graphs (docs §5.6): a spec Writey draws by hand, never pixels or SVG. */
const DIAGRAMS = String.raw`- draw_diagram: a hand-drawn figure or graph (its arguments are the objects in these examples, without "type"). Draw one whenever a picture helps (free-body diagrams, graphs of functions, geometry, circuits as boxes and lines, motion sketches) or when asked to draw, sketch, plot or graph. Give coordinates in your own math units with y pointing UP; Writey scales, places and draws it by hand. Example:
{"type":"diagram","title":"block on a slope","after":"prev","x":[-1,7],"y":[-1,5],"items":[{"kind":"polygon","points":[[0,0],[6,0],[0,3.5]]},{"kind":"hatch","from":[-0.5,0],"to":[6.5,0]},{"kind":"rect","at":[1.5,2.6],"w":1.2,"h":0.9,"angle":-30,"label":"m"},{"kind":"arrow","from":[2.3,2.4],"to":[2.3,0.8],"label":"$mg$"},{"kind":"angle","vertex":[6,0],"from":[0,0],"to":[0,3.5],"label":"$\\theta$"}],"why":"forces on the block"}
  Graph example: {"type":"diagram","x":[-1,7],"y":[-1.5,1.5],"items":[{"kind":"axes","labels":["x","y"]},{"kind":"plot","expr":"sin(x)","domain":[0,6.28],"label":"$y=\\sin x$"},{"kind":"point","at":[3.14,0],"label":"$\\pi$"}]}
  Item kinds (every item may have "label", text with $math$, and "dashed":true):
  line {from,to} · arrow {from,to, both?} (forces, vectors, velocities) · polyline {points} · polygon {points} · curve {points, closed?} (a smooth freehand curve through the points) · rect {at (lower-left), w, h, angle? in degrees} · circle {center, r} · ellipse {center, rx, ry} · arc {center, r, from, to} (degrees) · angle {vertex, from, to, right?} (arc between two rays; right:true draws the square mark) · point {at} · label {at, text, side? (above, below, left, right)} · dimension {from, to} (a measured length with arrows) · hatch {from, to, side?} (ground, wall or ceiling) · spring {from, to, coils?} · pulley {center, r}
  "x" and "y" give the visible ranges (fitted to the items when left out); "w" and "h" the size in points (about 240 wide by default; the page is 595 wide). Keep a diagram simple and clear: the fewest items that make the point, labels short.
- Graphs: Writey computes every curve itself, so give the maths, never sampled points. Expressions use x (y in relations, t or theta for polar and parametric, n for sequences), ^ for powers, * or juxtaposition, pi, e, sqrt, abs or |x|, ln, log (base 10), exp, sin…arctan, sinh…, floor, ceil, sign, x! and min/max; x^(1/3) is real for negative x.
  axes {x?, y?, labels?, ticks? (step), yticks?, numbers?, grid?: true ("minor" for fine squares), pi?: true (x ticks at multiples of π/2; 4 for π/4), xscale?/yscale?: "log" (log axes with decades; the ranges are the real values, e.g. x [1, 10000]), origin?: true}
  plot {expr, domain?, ends?: ["closed","open"] (dots at the domain's ends, for piecewise functions: one plot per piece), holes?: [x] (hollow dots)} · parametric {x, y, t} · implicit {expr: "x^2/9 + y^2/4 = 1"} (any curve f(x, y) = 0: circles, conics, folium, lemniscate) · polar {r: "2(1 - cos t)", t?: [0, 2pi]}
  region {where: ["y <= 2x + 1", "x^2 + y^2 < 9"]} (shades where all hold; boundaries drawn, dashed when strict) · shade {expr, between?: g(x), from, to, label?} (area under a curve or between two; integrals) · asymptote {x} or {y} or {m, c} (dashed) · tangent {expr, at, normal?: true, length?}
  slope_field {dy: "x - y"} (differential equations; add plots for solution curves) · vector_field {u, v}
  points {points, labels?, connect?, hollow?, marker?: "cross", fit?: "linear"} (data, scatter, line of best fit) · sequence {expr: "(-1)^n / n", n: [1, 12], stems?, limit?}
  Statistics and probability: bars {values, labels} (bar chart: put axes with x [0, count + 0.5]) · histogram {bins: [edges], freq} · pie {values, labels, percent?: true} · boxplot {data} or {min, q1, median, q3, max} (add a number_line under it) · number_line {range, ticks?, points: [{at, open?, label?}], intervals: [{from, to ("inf"/"-inf" for rays), open: [bool, bool], label?}]} (inequalities, intervals) · venn {sets: ["A","B"] or three, shade: ["A&B'", "A|B", "A-B"], regions: {"A&B": "5"}, universe?} · tree {root?, branches: [{label, p, children: [...]}]} (probability trees)
  3D: axes3d {size?, labels?} · point3d {at: [x, y, z]} (with dashed guides) · arrow3d {from?, to} · line3d {from, to} · polygon3d {points} (planes, faces)
  Example: {"type":"diagram","x":[-1,4],"y":[-1,4],"items":[{"kind":"axes"},{"kind":"plot","expr":"x^2/2","domain":[0,3],"label":"$y=x^2/2$"},{"kind":"shade","expr":"x^2/2","from":1,"to":2,"label":"$A$"}]}
  Example: {"type":"diagram","items":[{"kind":"axes","x":[1,1000],"y":[0.1,100],"xscale":"log","yscale":"log","grid":true,"labels":["f (Hz)","G"]},{"kind":"plot","expr":"100/sqrt(1+(x/50)^2)"}]}`

/** Chemistry drawn with the pen (HANDOFF D50): Writey lays out molecules from SMILES itself. */
const CHEMISTRY = String.raw`- Chemistry: draw it, never paste a picture. Writey works out where every atom goes and writes it by hand; give only the chemistry. Units: one bond length.
  molecule {smiles, at?, id?, label? (a name under it), hydrogens?: "all" (displayed formula with every H, open chains drawn straight as in textbooks), lewis?: true (every atom, H and lone pairs; charges from the SMILES), numbers?: true (atom numbers), carbons?: "all", size?, rotate?, flip?}. Skeletal formulas by default. SMILES: write charges in brackets ([O-], [NH4+], [C-]#N); stereo with @/@@ and / \ (drawn as wedges and hashes); aromatic rings in lowercase (c1ccccc1) are drawn with a circle, write Kekulé (C1=CC=CC=C1) for alternating double bonds.
  reaction {reactants: [...], products: [...], arrow?: "->" | "<=>", above?, below?} or {reactants, steps: [{products, arrow?, above?, below?}, …]} (several steps). Each species is a formula string ("2H2O", "H2SO4", "Cu^2+", "OH-") or {smiles, coef?, name?, hydrogens?, lewis?} for a structure. Conditions above/below are formulas or words ("H2SO4", "heat", "Ni, 150 °C").
  curly {from, to, fishhook?: true, bend?: -1} (mechanism arrows): from a lone pair ("id:N", the first N of molecule id; "id:O2", its second O; "id:3", its third atom in SMILES order) or a bond ("id:2-3"), to an atom or bond. Give each molecule an id and put the curly arrows after them in the same diagram.
  energy_profile {stages: [{label, e}, {label: "TS", e, ts: true}, …], ea?, dh?, catalysed?: [lower peak energies]} · orbital_boxes {config: "1s2 2s2 2p4" or "[Ne] 3s2 3p4", at?} (Hund's rule boxes) · lattice {type: "sc"|"bcc"|"fcc"|"nacl"} · newman {front: [3 groups], back: [3], angle?: 60 staggered, 0 eclipsed} · fischer {top, bottom, rows: [[left, right], …]} · chair {substituents: [{at: 1–6, axial?, equatorial?}]}
  Lab apparatus: apparatus {name, at (bottom centre), size?, angle?, liquid?: 0–1, label?}, names: beaker, conical_flask, round_flask, test_tube, boiling_tube, measuring_cylinder, burette, pipette, funnel, separating_funnel, condenser, bunsen, tripod, gauze, thermometer, stand, gas_jar, evaporating_dish, crucible, trough, watch_glass (about 2 units tall; join them with polyline tubes; name parts with a callouts item) · setup {name: "distillation"|"titration"|"gas collection"|"filtration"|"heating", labels?: false} (a ready-made labelled set-up).
  Chemical equations on their own line: write_math with \ce{…}, e.g. \ce{2H2(g) + O2(g) -> 2H2O(l)}, \ce{N2 + 3H2 <=>[Fe][450 °C] 2NH3}, \ce{Cu^2+ + 2OH- -> Cu(OH)2 v}, \ce{CuSO4.5H2O}.
  Example: {"type":"diagram","title":"Nucleophilic addition","items":[{"kind":"molecule","id":"cn","smiles":"[C-]#N","at":[-3,0]},{"kind":"molecule","id":"k","smiles":"CC(=O)C","at":[0,0]},{"kind":"curly","from":"cn:C","to":"k:2"},{"kind":"curly","from":"k:2-3","to":"k:O"}]}
  Example: {"type":"diagram","items":[{"kind":"reaction","reactants":[{"smiles":"CC(=O)O"},{"smiles":"CCO"}],"products":[{"smiles":"CC(=O)OCC","name":"ethyl ethanoate"},"H2O"],"arrow":"<=>","above":"conc. H2SO4","below":"heat"}]}`

/** Physics pictures (Class 11–12 and beyond): Writey draws the symbols and works out rays and field lines itself. */
const PHYSICS = `- Physics diagrams are diagram items too; give only the physics and the layout, Writey does the drawing and the maths.
  Circuits (two-terminal parts sit between "from" and "to", with straight leads; join them with wires on a grid, e.g. corners at whole numbers):
  resistor · rheostat · capacitor · inductor · cell (long + plate at "from"; "flip":true reverses) · battery {cells?} · switch {closed?} · bulb · ammeter · voltmeter · galvanometer · diode (arrow from "from" to "to") · zener · led · ac (AC source) · fuse — each {from, to, label?, current?: "I" (adds a current arrow)} · wire {points} or {from, to} · junction {at} (a dot) · terminal {at} · ground {at} · transistor {at, type: "npn"|"pnp", size?} (base at at−(size,0), collector at at+(size/2,size), emitter at at+(size/2,−size))
  Logic gate circuits: ALWAYS use one logic item and never place gates yourself; Writey lays out the gates, routes the wires and adds junction dots. logic {inputs: [names], gates: [{id, type: and|or|not|nand|nor|xor, in: [input names or gate ids]}], outputs: {name: gate id}, names?: true (writes AND/OR… under each gate)}. Example (full adder): {"type":"diagram","title":"Full adder","items":[{"kind":"logic","inputs":["A","B","Cin"],"gates":[{"id":"x1","type":"xor","in":["A","B"]},{"id":"x2","type":"xor","in":["x1","Cin"]},{"id":"a1","type":"and","in":["A","B"]},{"id":"a2","type":"and","in":["x1","Cin"]},{"id":"o1","type":"or","in":["a1","a2"]}],"outputs":{"Sum":"x2","Cout":"o1"}}]}
  For other circuits, run wires only across or up and down, end them exactly on part ends, and keep parts at least 2 units apart; junction dots are added for you.
  Example: {"type":"diagram","title":"Wheatstone bridge","items":[{"kind":"resistor","from":[0,0],"to":[2,2],"label":"P"},{"kind":"resistor","from":[2,2],"to":[4,0],"label":"Q"},{"kind":"resistor","from":[0,0],"to":[2,-2],"label":"R"},{"kind":"resistor","from":[2,-2],"to":[4,0],"label":"S"},{"kind":"galvanometer","from":[2,2],"to":[2,-2]},{"kind":"wire","points":[[0,0],[-1,0],[-1,-3],[1.2,-3]]},{"kind":"cell","from":[1.2,-3],"to":[2.8,-3],"label":"E"},{"kind":"wire","points":[[2.8,-3],[5,-3],[5,0],[4,0]]}]}
  Ray optics (Writey traces the rays and finds the image with the lens/mirror formula; never draw rays yourself):
  lens {type: "convex"|"concave", x, f, object?: {x, h, label?}, image?: "A'B'", rays?: 2|3} · mirror {type: "concave"|"convex", x, f, object?} (light comes from the left; put the object at x < mirror) · to show the ray rules without an object, give lens or mirror rays: [{type: "parallel"|"focus"|"centre"|"pole", h?, label?}] (Writey bends them correctly; never draw rays as lines yourself) · optics {elements: [{type: "convex_lens"|"concave_lens"|"concave_mirror"|"convex_mirror", x, f, label?}, …], object} for microscopes and telescopes (lenses left to right) · prism {at (middle of the base), side, apex: 60, n, i (angle of incidence), deviation?} · slab {at, w, h, n, i} · refraction {at, i, n1, n2} (one surface; shows total internal reflection when it happens)
  Example: {"type":"diagram","title":"object beyond 2F","items":[{"kind":"lens","type":"convex","x":0,"f":10,"object":{"x":-25,"h":4,"label":"AB"},"image":"A'B'"}]}
  Fields and more: charges {charges: [{at, q, label?}, …], lines?} (field lines traced from the real field) · dipole {at, d} · magnet {at, length, north?: "left"|"right"} (bar magnet with its field) · solenoid {from, to, r, turns, field?} · current {at, dir: "out"|"in", rings?} (wire seen end-on with its circular field) · levels {x: [x0, x1], levels: [{n, e}], transitions: [{from, to, label?}]} (energy levels, e in eV as y) · wavefronts {at, r: [radii], plane?} · slits {x, y: [bottom, top], gaps: [[y0, y1], …], label?} (a slit barrier, or a screen without gaps)
  Use these for: circuits (bridges, potentiometer, meter bridge, RC/LR/LCR, rectifiers, transistor amplifiers), logic circuits (adders, multiplexers, any gate network), ray diagrams (all mirror and lens cases, microscope, telescope, prism, slab, total internal reflection), field lines, magnets, solenoids, Bohr levels, Young's double slit. Apparatus with no item kind (AC generator, cyclotron, transformer) is drawn freehand (below).
- Real pictures (biology, anatomy, cells, organs, plants, animals, maps, rocks, anything that looks like something): don't draw these by hand. Chemistry is the exception: always draw it (below), never paste it. Call find_picture, pick the clearest diagram from the contact sheet with place_picture, then name the parts the student needs with label_parts (points on the parts in image 1, which then shows the picture). If the chosen picture already carries clear English labels, don't label it again; point at and explain the parts instead. Search again with other words if nothing fits.
- Textbook figures Writey can draw itself, for when no picture fits or the student wants a sketch: heart, eye, ear, brain, flower, neuron, nephron, animal_cell, plant_cell, digestive_system, respiratory_system. figure {name, labels?: [part names to label] (default: every part; false for none)}. Example: {"type":"diagram","title":"Human heart","items":[{"kind":"figure","name":"heart"}]}
- Freehand pictures, only for simple sketches (a rough schematic, something no picture shows): set "ydown": true on the diagram and draw like an SVG on a canvas about 200 wide, y going down. svg {d: "SVG path data"} or {paths: ["…", "…"]} (M L H V C S Q T A Z, absolute or relative; Writey draws every path by hand; fills are ignored) · blob {center, rx, ry, wobble?: 0–0.3} (an organic closed outline: cells, organs, nuclei) · circle, ellipse, curve, line and arrow work too. Then ONE callouts item names the parts: callouts {labels: [{at: [x, y] (a point on the part), text}]}; Writey lines the names up in columns left and right of the drawing with leader lines, so never place part names yourself. Draw the parts in a sensible order (outline first, then inner parts), keep shapes recognisable rather than detailed, and label every part the student needs.
  Example: {"type":"diagram","title":"Animal cell","ydown":true,"items":[{"kind":"blob","center":[100,100],"rx":90,"ry":70,"wobble":0.08},{"kind":"circle","center":[95,95],"r":22},{"kind":"blob","center":[95,95],"rx":7,"ry":6},{"kind":"svg","d":"M140 70 C150 60 165 65 160 78 C155 90 140 88 140 70 Z"},{"kind":"callouts","labels":[{"at":[100,30],"text":"cell membrane"},{"at":[110,78],"text":"nucleus"},{"at":[95,95],"text":"nucleolus"},{"at":[152,75],"text":"mitochondrion"},{"at":[40,100],"text":"cytoplasm"}]}]}`

function pageText(ctx: PageContext): string {
  const parts: string[] = []
  parts.push(
    ctx.labels.length
      ? `Lines in the area: ${ctx.labels.join(', ')}.`
      : 'There is no handwriting in the area.',
  )
  if (ctx.selection) parts.push('The student lassoed this area on purpose.')
  if (ctx.typedText.length) parts.push(`Typed text in the area:\n${ctx.typedText.join('\n')}`)
  if (ctx.pdfText) parts.push(`Printed (PDF) text in the area:\n${ctx.pdfText}`)
  if (ctx.aiInk?.length) {
    parts.push(
      `Writey's own handwriting in the area (what it says exactly):\n${ctx.aiInk.join('\n')}`,
    )
  }
  if (ctx.transcript) parts.push(`What the student said out loud recently:\n${ctx.transcript}`)
  if (ctx.imageSizes) {
    const [fw, fh] = ctx.imageSizes.focus
    const [pw, ph] = ctx.imageSizes.page
    parts.push(`Image 1 is ${fw}×${fh} px. Image 2 (the whole page) is ${pw}×${ph} px.`)
  }
  if (ctx.printed?.length) {
    parts.push(
      `Printed text on the whole page, with boxes in image 2 pixels [x0,y0,x1,y1]:\n${ctx.printed.join('\n')}`,
    )
  }
  return parts.join('\n\n')
}

const images = (ctx: PageContext): ContentPart[] => [
  { type: 'image_url', image_url: { url: ctx.focusImage } },
  { type: 'image_url', image_url: { url: ctx.pageImage } },
]

function history(turns: readonly Turn[]): ChatMessage[] {
  return turns.slice(-HISTORY_TURNS).map((t) => ({ role: t.role, content: t.text }))
}

export function planMessages(
  utterance: string,
  ctx: PageContext,
  route: Route,
  turns: readonly Turn[],
): ChatMessage[] {
  const hints = [
    route.mode && `The wording suggests mode "${route.mode}".`,
    route.scope && `The wording suggests scope "${route.scope}".`,
  ].filter(Boolean)
  const recent = turns
    .slice(-4)
    .map((t) => `${t.role === 'user' ? 'Student' : 'Writey'}: ${t.text.slice(0, 300)}`)
    .join('\n')
  return [
    { role: 'system', content: PLAN_SYSTEM },
    {
      role: 'user',
      content: [
        ...images(ctx),
        {
          type: 'text',
          text: [
            pageText(ctx),
            recent && `Recent conversation:\n${recent}`,
            `The student said: "${utterance}"`,
            ...hints,
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
    },
  ]
}

/** Drops the screenshots from earlier messages; only the newest page image matters. */
export const withoutImages = (messages: readonly ChatMessage[]): ChatMessage[] =>
  messages.map((m) =>
    typeof m.content === 'string' || m.content.every((p) => p.type === 'text')
      ? m
      : {
          ...m,
          content: [
            { type: 'text', text: '(Earlier screenshots of the page, now out of date.)' },
            ...m.content.filter((p) => p.type === 'text'),
          ],
        },
  )

/** The tools Writey's pen gives the model (HANDOFF D46). Spots are pixels in image 1 or 2. */
const spot = {
  target: { type: 'string', description: 'A line tag such as "L3".' },
  box: {
    type: 'array',
    items: { type: 'number' },
    minItems: 4,
    maxItems: 4,
    description: 'A region [x0, y0, x1, y1] in image pixels.',
  },
  at: {
    type: 'array',
    items: { type: 'number' },
    minItems: 2,
    maxItems: 2,
    description: 'A point [x, y] in image pixels.',
  },
  img: {
    type: 'integer',
    enum: [1, 2],
    description: 'Which image box/at are in: 1 = the focus area (default), 2 = the whole page.',
  },
}
const after = {
  type: 'string',
  description:
    'Write below this line tag ("L3"), or "prev" to continue under what you wrote last. Leave out to continue under your last line.',
}
const why = { type: 'string', description: 'A few words on why this step (shown on "Why?").' }
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
})

export const WRITEY_TOOLS: ToolSpec[] = [
  {
    name: 'look_at_page',
    description:
      'See the page as it is right now, including everything you have written or drawn so far (in violet, with fresh line tags). Returns new images and page text.',
    parameters: obj({}),
  },
  {
    name: 'zoom',
    description:
      'Look closely at a region (box, in image 1 or 2 pixels): returns it magnified, for small handwriting, subscripts, signs or fine print. Your pixel coordinates stay those of image 1 and 2.',
    parameters: obj({ box: spot.box, img: spot.img }, ['box']),
  },
  {
    name: 'point_at',
    description:
      'Move your pen to a line or spot and rest it there while you read it or talk about it. The student sees the pen and your note. Writes nothing.',
    parameters: obj(
      { ...spot, note: { type: 'string', description: 'What you are looking at, a few words.' } },
      ['note'],
    ),
  },
  {
    name: 'mark',
    description:
      'Red pen on a line (target) or on a spot (box or at): circle, cross, tick, underline, box, arrow, point (a dot with a leader to the note) or highlight (yellow highlighter). A note is written beside it.',
    parameters: obj(
      {
        kind: {
          type: 'string',
          enum: ['circle', 'cross', 'tick', 'underline', 'box', 'arrow', 'point', 'highlight'],
        },
        ...spot,
        note: { type: 'string', description: 'At most six words.' },
      },
      ['kind'],
    ),
  },
  {
    name: 'write_math',
    description:
      'Write math in handwriting below the work, one notebook line per entry of lines, each under the one before. Put all the lines of a step or a whole solution in one call.',
    parameters: obj({
      lines: {
        type: 'array',
        items: { type: 'string' },
        description: 'LaTeX lines, top to bottom; no $ and no line breaks inside a line.',
      },
      latex: { type: 'string', description: 'A single line instead of lines.' },
      after,
      boxed: { type: 'boolean', description: 'Box the last line (the final answer).' },
      why,
    }),
  },
  {
    name: 'write_text',
    description:
      'Write a short line of words in handwriting (inline math in $...$), below the work or exactly at a spot.',
    parameters: obj(
      {
        text: { type: 'string' },
        after,
        at: spot.at,
        img: spot.img,
        size: { type: 'number', description: 'With at: capital-letter height there, in pixels.' },
        why,
      },
      ['text'],
    ),
  },
  {
    name: 'draw_diagram',
    description:
      'Draw a figure, graph, circuit, ray diagram, field, or labelled picture by hand, below the work. See the diagram guide in your instructions for the item kinds.',
    parameters: obj(
      {
        title: { type: 'string' },
        after,
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { kind: { type: 'string', description: 'The item kind, e.g. "arrow".' } },
            required: ['kind'],
          },
        },
        x: { type: 'array', items: { type: 'number' }, description: 'Visible x range.' },
        y: { type: 'array', items: { type: 'number' }, description: 'Visible y range.' },
        w: { type: 'number' },
        h: { type: 'number' },
        ydown: { type: 'boolean', description: 'Freehand canvas, y down, about 200 wide.' },
        why,
      },
      ['items'],
    ),
  },
  {
    name: 'draw_table',
    description:
      'Draw a ruled table (truth tables, observations, comparisons). Cells may hold $math$.',
    parameters: obj(
      {
        header: { type: 'array', items: { type: 'string' } },
        rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        align: { type: 'array', items: { type: 'string', enum: ['l', 'c', 'r'] } },
        title: { type: 'string' },
        after,
      },
      ['rows'],
    ),
  },
  {
    name: 'find_picture',
    description:
      'Search Wikimedia Commons for a real diagram or picture (anatomy, cells, organs, plants, animals, apparatus, maps, specimens…). Returns up to six numbered choices as a contact sheet. Line drawings come first.',
    parameters: obj(
      {
        query: {
          type: 'string',
          description:
            'A few English words naming the figure, e.g. "human heart diagram", "plant cell", "nephron structure". Add "unlabeled" or "blank" when you will name the parts yourself.',
        },
      },
      ['query'],
    ),
  },
  {
    name: 'place_picture',
    description:
      'Paste one of the pictures find_picture returned onto the page, below the work, with room beside it for names and a small credit line. Afterwards image 1 is the picture itself, ready for label_parts.',
    parameters: obj(
      {
        choice: { type: 'integer', description: 'Its number on the contact sheet (1–6).' },
        size: { type: 'string', enum: ['small', 'medium', 'large'] },
        after,
        why,
      },
      ['choice'],
    ),
  },
  {
    name: 'label_parts',
    description:
      'Name parts of a picture or figure on the page: for each part, a point on it (in image pixels) and its name. Writey lines the names up beside the picture with leader lines, so never place names yourself.',
    parameters: obj(
      {
        labels: {
          type: 'array',
          items: obj(
            {
              at: spot.at,
              text: { type: 'string', description: "The part's name, a few words." },
            },
            ['at', 'text'],
          ),
        },
        img: spot.img,
      },
      ['labels'],
    ),
  },
  {
    name: 'diagram_guide',
    description:
      'Get the guide to draw_diagram (graphs, geometry, physics, circuits, optics, chemistry, figures, pictures). Call it once before your first draw_diagram, find_picture or figure when the guide is not already in your instructions.',
    parameters: obj({}),
  },
  {
    name: 'erase',
    description:
      'Rub out something you wrote or drew in this answer, by the id its tool result gave (e.g. "W3"), to put it right. Ink from earlier answers and the student\'s work can\'t be erased.',
    parameters: obj({ id: { type: 'string', description: 'An id such as "W3".' } }, ['id']),
  },
  {
    name: 'new_page',
    description:
      'Turn to a fresh page and carry on at its top. Writey also does this itself when a page fills up.',
    parameters: obj({}),
  },
  {
    name: 'say',
    description: 'Say something out loud to the student (only when they are talking to you).',
    parameters: obj({ text: { type: 'string' } }, ['text']),
  },
]

const AGENT = `You are Writey, a friendly tutor who sits beside the student with a pen and their notebook, and explains in the margin beside the page.
${SEEING}

You act through tools, like a computer-use agent acting on a screen; the student watches your pen write live. Every tool tells you what happened; if something failed (an unknown line tag, no room), adapt.
- write_math and write_text write lines; mark is your red pen; point_at rests your pen on something; draw_diagram and draw_table draw by hand; find_picture, place_picture and label_parts paste and name a real picture.
- Be quick. The student is waiting, and every extra round trip costs time and tokens. Work out the answer in your head, then send ALL your page calls together in ONE response (several tool calls at once: e.g. one write_math with every line of the working, plus any marks), and in your next response reply with the margin explanation. Two responses is the norm; take more only when a result shows something went wrong.
- Don't call look_at_page or zoom unless something really is unreadable or a call failed. Don't point_at just to narrate; point only when it shows the student where to look.
- Each thing you write gets an id (W1, W2, …). If it came out wrong, erase it and write it again. A failed call writes nothing; change it rather than repeating it.
- When you are finished, stop calling tools and reply with the explanation for the margin, in Markdown. That reply ends your turn.

How a good tutor uses the pen (judge what this request needs):
- The page holds the working, one step per line; a sketch or diagram when there is something to see; a table for rows and columns; red-pen marks on their work. The margin explains in words. Never copy the page into the margin.
- Small talk or a quick answer needs no pen: just reply. If they ask you not to write, don't.
- When you check work, mark exactly what is right and wrong and put it right.
- A hint is a nudge: don't give the answer.

Writing:
- Keep each line short, like a notebook line. A long equation continues on the next line starting with "=". Never use align environments or \\ line breaks. A solution is usually 3–8 lines: skip steps a student at this level would do in their head.
- LaTeX: common commands only (\frac sqrt ^ _ int sum lim \vec cdot \times left( \right) \text{} and Greek letters). Units in \text{}, e.g. 5,\text{m/s}. Box the final answer.
- The first line goes below the student's last line (after: its tag) unless it belongs elsewhere; later lines follow under it. Writey places and sizes the handwriting itself: never try to position working lines by pixels.
- Never rewrite what is already on the page, theirs or yours: add only what is new, below it. Earlier answers you wrote stay on the page.
- Pointing (point_at, mark, labels with write_text at) is in pixels of the images, origin top-left: image 1 (the focus area, the default) or image 2 (the whole page, img 2).

The margin explanation: teach it, don't summarise it. The intuition in plain words, the reasoning tied to what is on the page ("the circled term", "the second line"), the usual trap. Keep it short: a quick question gets two sentences, a full solution at most a short paragraph or two. Write $…$ for inline math.`

/** The draw_diagram guide: sent only when the request is about a picture, else on request. */
export const DIAGRAM_GUIDE = `Diagrams:
${DIAGRAMS}
${PHYSICS}
${CHEMISTRY}`

/** Requests that will almost surely need the diagram guide, so it comes without a round trip. */
const DRAWING =
  /\b(draw|sketch|plot|graph|diagram|figure|picture|label|circuit|gate|adder|ray|lens|mirror|prism|field lines?|magnet|solenoid|molecule|structure|reaction|mechanism|apparatus|set-?up|chart|venn|histogram|tree|table|cell|heart|organ|anatomy)/i

export const needsDiagramGuide = (utterance: string) => DRAWING.test(utterance)

const SPOKEN = `${SPEAKING}
Call say once, early and in the same response as your page calls, with one to three sentences on what you're about to do or what you found. Don't read equations aloud.`

export function agentMessages(
  utterance: string,
  ctx: PageContext,
  route: Route,
  turns: readonly Turn[],
  spoken = false,
): ChatMessage[] {
  const hints = [
    route.scope === 'hint' && 'They asked for a hint only.',
    route.mode === 'chat' && 'They asked for words only: do not write on the page.',
  ].filter(Boolean)
  return [
    {
      role: 'system',
      content: [
        AGENT,
        needsDiagramGuide(utterance)
          ? DIAGRAM_GUIDE
          : 'Before your first draw_diagram, find_picture or figure, call diagram_guide for the item kinds.',
        spoken && SPOKEN,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
    ...history(turns),
    {
      role: 'user',
      content: [
        ...images(ctx),
        {
          type: 'text',
          text: [pageText(ctx), `The student said: "${utterance}"`, ...hints]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
    },
  ]
}

/** What look_at_page hands back, as a message after the tool results (tool results can't hold images everywhere). */
export function pageLook(ctx: PageContext, yours: readonly string[], intro?: string): ChatMessage {
  return {
    role: 'user',
    content: [
      ...images(ctx),
      {
        type: 'text',
        text: [
          intro ??
            `The page now, from look_at_page. Your ink is violet${yours.length ? `; your lines are ${yours.join(', ')}` : ''}. Line tags were renumbered: use these from now on.`,
          pageText(ctx),
        ].join('\n\n'),
      },
    ],
  }
}

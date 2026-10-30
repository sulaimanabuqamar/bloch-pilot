// One-qubit quantum engine for Bloch Pilot.
// Complex numbers are [re, im]. A state is [alpha, beta] for alpha|0> + beta|1>.

export const c = (re, im = 0) => [re, im];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const conj = (a) => [a[0], -a[1]];
const abs2 = (a) => a[0] * a[0] + a[1] * a[1];
const S2 = Math.SQRT1_2;
const C8 = Math.cos(Math.PI / 8);
const S8 = Math.sin(Math.PI / 8);

// Each gate has its exact matrix (for the maths) and the Bloch-sphere rotation it causes
// (axis in Bloch coordinates x, y, z and angle in radians), used only for the animation.
export const GATES = {
  X: {
    key: 'X', label: 'X', name: 'Pauli-X',
    matrix: [[c(0), c(1)], [c(1), c(0)]],
    axis: [1, 0, 0], angle: Math.PI,
    qiskit: 'qc.x(0)',
    blurb: 'Half-turn around the X axis. Flips |0⟩ and |1⟩.',
  },
  Z: {
    key: 'Z', label: 'Z', name: 'Pauli-Z',
    matrix: [[c(1), c(0)], [c(0), c(-1)]],
    axis: [0, 0, 1], angle: Math.PI,
    qiskit: 'qc.z(0)',
    blurb: 'Half-turn around the vertical axis. Changes the phase.',
  },
  H: {
    key: 'H', label: 'H', name: 'Hadamard',
    matrix: [[c(S2), c(S2)], [c(S2), c(-S2)]],
    axis: [S2, 0, S2], angle: Math.PI,
    qiskit: 'qc.h(0)',
    blurb: 'Swaps the poles with the equator: |0⟩ ↔ |+⟩, |1⟩ ↔ |−⟩.',
  },
  S: {
    key: 'S', label: 'S', name: 'S (phase)',
    matrix: [[c(1), c(0)], [c(0), c(0, 1)]],
    axis: [0, 0, 1], angle: Math.PI / 2,
    qiskit: 'qc.s(0)',
    blurb: 'Quarter-turn around the vertical axis.',
  },
  RY: {
    key: 'RY', label: 'RY', name: 'RY(π/4)',
    matrix: [[c(C8), c(-S8)], [c(S8), c(C8)]],
    axis: [0, 1, 0], angle: Math.PI / 4,
    qiskit: 'qc.ry(pi/4, 0)',
    blurb: 'Tilts the arrow 45° around the Y axis.',
  },
};

export const GATE_ORDER = ['X', 'H', 'Z', 'S', 'RY'];

export const KET = {
  '0': [c(1), c(0)],
  '1': [c(0), c(1)],
  '+': [c(S2), c(S2)],
  '-': [c(S2), c(-S2)],
  '+i': [c(S2), c(0, S2)],
  '-i': [c(S2), c(0, -S2)],
};

export function applyGate(gate, psi) {
  const m = gate.matrix;
  return [
    add(mul(m[0][0], psi[0]), mul(m[0][1], psi[1])),
    add(mul(m[1][0], psi[0]), mul(m[1][1], psi[1])),
  ];
}

export function runCircuit(startKet, gateKeys) {
  let psi = KET[startKet];
  for (const k of gateKeys) psi = applyGate(GATES[k], psi);
  return psi;
}

// Bloch vector [x, y, z].
export function bloch(psi) {
  const ab = mul(conj(psi[0]), psi[1]);
  return [2 * ab[0], 2 * ab[1], abs2(psi[0]) - abs2(psi[1])];
}

// |<a|b>|^2. Ignores global phase, as it should.
export function fidelity(a, b) {
  const ip = add(mul(conj(a[0]), b[0]), mul(conj(a[1]), b[1]));
  return abs2(ip);
}

export function probabilities(psi) {
  return [abs2(psi[0]), abs2(psi[1])];
}

// Rodrigues rotation of vector v about unit axis k by angle t.
export function rotate(v, k, t) {
  const cos = Math.cos(t), sin = Math.sin(t);
  const dot = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  const cross = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  return [0, 1, 2].map((i) => v[i] * cos + cross[i] * sin + k[i] * dot * (1 - cos));
}

export const PASS_FIDELITY = 0.99;

// Scoring: 1000 x best fidelity on each scored level, plus 100 for every unused gate
// on a solved level. Ties are broken by total time (faster wins).
export const POINTS_PER_FIDELITY = 1000;
export const POINTS_PER_SPARE_GATE = 100;

export const LEVELS = [
  {
    id: 'tutorial',
    title: 'Tutorial · First Flip',
    scored: false,
    start: '0',
    target: KET['1'],
    targetName: '|1⟩ (the south pole)',
    budget: 3,
    allowed: GATE_ORDER,
    solution: ['X'],
    fog: false,
    goal: 'Move the arrow from |0⟩ at the top to the beacon at the bottom.',
    pilotGoal: 'You start on |0⟩, the top of the sphere. The beacon is straight below you at |1⟩. Get there.',
    insideGoal: 'Your arrow points straight up at |0⟩. Swing it down to the beacon at |1⟩, below your feet.',
    hint: 'X is a half-turn around the X axis. It takes the top of the sphere to the bottom.',
  },
  {
    id: 'equator',
    title: 'Level 1 · Around the Equator',
    scored: true,
    start: '0',
    target: KET['+i'],
    targetName: '|+i⟩ (on the equator, the Y side)',
    budget: 3,
    allowed: GATE_ORDER,
    solution: ['H', 'S'],
    fog: false,
    goal: 'Reach the beacon on the equator.',
    hint: 'H drops you from the top onto the equator. S turns you a quarter-turn around the vertical axis.',
  },
  {
    id: 'tilt',
    title: 'Level 2 · The Tilt',
    scored: true,
    start: '0',
    target: runCircuit('0', ['H', 'RY']),
    targetName: 'below the equator, on the |+⟩ side',
    budget: 2,
    allowed: GATE_ORDER,
    solution: ['H', 'RY'],
    fog: false,
    goal: 'Reach the beacon below the equator. Only 2 gates allowed.',
    hint: 'Get onto the equator first, then use RY to tilt 45° further down.',
  },
  {
    id: 'phase',
    title: 'Level 3 · Invisible Phase',
    scored: true,
    start: '0',
    target: KET['-'],
    targetName: '|−⟩',
    budget: 3,
    allowed: GATE_ORDER,
    solution: ['H', 'Z'],
    fog: true,
    ghost: '+',
    revealText: 'The fog is gone. |+⟩ and |−⟩ both measure 50/50, but they sit on opposite sides of the sphere. That difference is the phase.',
    goal: 'The sphere is fogged. You only see the measurement odds. Unlock the checkpoint: it wants |−⟩.',
    hint: '|+⟩ and |−⟩ both measure 50/50, so the odds alone cannot tell them apart. Which gate changes the phase without changing the odds?',
  },
];

// Challenge round: five scored levels, harder than the tutorial round, no warm-up.
// Every target and every listed solution is checked against Qiskit (bloch-tests/verify.py).
export const CHALLENGE_LEVELS = [
  {
    id: 'c1-high',
    title: 'Challenge 1 · High Road',
    scored: true,
    start: '0',
    target: runCircuit('0', ['RY', 'Z']),
    targetName: 'above the equator, on the |−⟩ side',
    budget: 2,
    allowed: GATE_ORDER,
    solution: ['RY', 'Z'],
    fog: false,
    goal: 'Reach the beacon above the equator. Only 2 gates.',
    hint: 'RY tilts you 45° off the top toward |+⟩. Which gate then swings you around to the opposite side?',
  },
  {
    id: 'c2-spiral',
    title: 'Challenge 2 · Spiral Down',
    scored: true,
    start: '0',
    target: runCircuit('0', ['H', 'RY', 'S']),
    targetName: 'below the equator, on the |+i⟩ side',
    budget: 3,
    allowed: GATE_ORDER,
    solution: ['H', 'RY', 'S'],
    fog: false,
    goal: 'Reach the beacon below the equator, on the |+i⟩ side.',
    hint: 'First get below the equator on the |+⟩ side. Then turn a quarter-turn around the vertical axis.',
  },
  {
    id: 'c3-low',
    title: 'Challenge 3 · Low Road',
    scored: true,
    start: '0',
    target: runCircuit('0', ['X', 'RY', 'S']),
    targetName: 'below the equator, on the |−i⟩ side',
    budget: 4,
    allowed: GATE_ORDER,
    solution: ['X', 'RY', 'S'],
    fog: false,
    goal: 'Reach the beacon below the equator, on the |−i⟩ side. You have 4 gates, but 3 is enough for bonus points.',
    hint: 'Start from the bottom instead of the top: X first. Then tilt, then turn.',
  },
  {
    id: 'c4-phase',
    title: 'Challenge 4 · Invisible Phase II',
    scored: true,
    start: '0',
    target: KET['-i'],
    targetName: '|−i⟩',
    budget: 3,
    allowed: GATE_ORDER,
    solution: ['H', 'Z', 'S'],
    fog: true,
    ghost: '+i',
    revealText: 'The fog is gone. Every point on the equator measures 50/50. Only the phase tells |+i⟩ and |−i⟩ apart.',
    goal: 'Fog again. You only see the odds. The checkpoint wants |−i⟩.',
    hint: 'Every point on the equator measures 50/50. Get onto the equator, then use the phase gates (S and Z) to turn to the right spot.',
  },
  {
    id: 'c5-diagonal',
    title: 'Challenge 5 · The Diagonal',
    scored: true,
    start: '0',
    target: runCircuit('0', ['RY', 'S', 'H']),
    targetName: 'on the equator, halfway between |+⟩ and |−i⟩',
    budget: 3,
    allowed: GATE_ORDER,
    solution: ['RY', 'S', 'H'],
    fog: false,
    goal: 'Reach the beacon on the equator, halfway between |+⟩ and |−i⟩. The hardest one.',
    hint: 'S and Z only turn in 90° steps, so you cannot turn 45° on the equator. Get 45° off the top on the |+i⟩ side first, then use H.',
  },
];

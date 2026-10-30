import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import {
  GATES, GATE_ORDER, KET, LEVELS as TUTORIAL_LEVELS, CHALLENGE_LEVELS, MARATHON_LEVELS, applyGate, bloch, fidelity, probabilities, rotate,
  PASS_FIDELITY, POINTS_PER_FIDELITY, POINTS_PER_SPARE_GATE,
} from './quantum.js';

// ---------------------------------------------------------------------------
// Settings from the URL: ?hs=3 labels the headset, ?minutes=15 sets the run length.
// ?log=1 shows the results saved on this device.
// The headset number is also remembered on the device, so staff pick it once
// from the start page and never type it into the Quest keyboard.
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const RUN_MINUTES = Math.max(1, Number(params.get('minutes')) || 15);
const HS_KEY = 'blochPilotHeadset';
const storeGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const storeSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
if (params.get('hs')) storeSet(HS_KEY, params.get('hs').slice(0, 12));
const HEADSET = (params.get('hs') || storeGet(HS_KEY) || '').slice(0, 12);
const LOG_KEY = 'blochPilotResults';
// Live leaderboard (Vercel). Each finished run is sent here; unsent runs wait in an outbox
// on the headset and are retried every 10 s, so a Wi-Fi drop never loses a score.
const BOARD_API = 'https://bloch-pilot-board.vercel.app/api/board';
const OUTBOX_KEY = 'blochPilotOutbox';
const PLAYER_KEY = 'blochPilotPlayer';
let roster = [];                                   // player names saved by staff on the leaderboard
let playerName = (storeGet(PLAYER_KEY) || '').slice(0, 60);
// Views:
//   'inside'  (default) the player stands in the middle of a big Bloch sphere; the state
//             arrow comes out of their chest and swings around them.
//   'outside' the original view: a small sphere in front of the player.
//   'tip'     the player rides the tip of the arrow, on a sphere that turns under their feet
//             (only through ?view=tip).
// A button switches between inside and outside.
const VIEW_PARAM = params.get('view');
let viewMode = VIEW_PARAM === 'outside' ? 'outside' : VIEW_PARAM === 'tip' ? 'tip' : 'inside';

// Round: 'tutorial' (the first game: a warm-up and 3 levels) or 'challenge' (5 harder levels).
// Staff pick it once per headset on the start page; it is remembered on the device.
const ROUND_KEY = 'blochPilotRound';
const ROUNDS = { tutorial: [TUTORIAL_LEVELS, 'Tutorial round'], challenge: [CHALLENGE_LEVELS, 'Challenge round'], marathon: [MARATHON_LEVELS, 'Marathon round'] };
if (params.get('round')) storeSet(ROUND_KEY, ROUNDS[params.get('round')] ? params.get('round') : 'tutorial');
const ROUND = ROUNDS[storeGet(ROUND_KEY)] ? storeGet(ROUND_KEY) : 'tutorial';
const LEVELS = ROUNDS[ROUND][0];
const ROUND_NAME = ROUNDS[ROUND][1];
{
  const pick = document.getElementById('roundPick');
  if (pick) {
    pick.value = ROUND;
    pick.addEventListener('change', () => {
      storeSet(ROUND_KEY, pick.value);
      const url = new URL(location.href);
      url.searchParams.delete('round');
      location.replace(url.toString());
    });
  }
}

document.getElementById('meta').textContent =
  `Run length: ${RUN_MINUTES} min. Pass fidelity: ${Math.round(PASS_FIDELITY * 100)}%.`;
{
  const pick = document.getElementById('hsPick');
  if (pick) {
    for (let i = 1; i <= 10; i++) pick.add(new Option(String(i), String(i)));
    pick.value = HEADSET || '';
    pick.addEventListener('change', () => {
      storeSet(HS_KEY, pick.value);
      const url = new URL(location.href);
      url.searchParams.delete('hs');
      location.replace(url.toString());
    });
  }
}

if (params.get('log')) showLog();

// ---------------------------------------------------------------------------
// Colours and fonts
// ---------------------------------------------------------------------------
const C = {
  bg: '#061418', panel: 'rgba(9, 32, 37, 0.92)', panelEdge: '#2a8f88', text: '#e8f6f4', dim: '#9fbfbb',
  teal: '#1f6f6c', mint: '#9ff0dd', go: '#25b36a', goHover: '#33d17f', warn: '#ffb347', bad: '#ff6b6b',
  gate: '#164b48', gateHover: '#22706b', neutral: '#24363b', neutralHover: '#35504f', disabled: '#1a2629',
  arrow: 0xffb347, beacon: 0x5ef2ff, path: 0xffe066, sphere: 0x2a8f88,
};
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif';

// ---------------------------------------------------------------------------
// Renderer, scene, camera
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const scene = new THREE.Scene();
scene.background = new THREE.Color(C.bg);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 120);
// Laptop camera. Outside view: orbit around the sphere. Pilot view: look around from just
// behind the pilot's head (VR uses the real head instead).
const PIVOT = new THREE.Vector3(0, 1.25, -0.9);
const PILOT_EYE = new THREE.Vector3(0, 2.3, 1.5);
const INSIDE_EYE = new THREE.Vector3(0, 1.6, 0.05);
const VIEW_DEFAULTS = { outside: { yaw: 0, pitch: 0.2, dist: 1.55 }, tip: { yaw: 0, pitch: -0.9 }, inside: { yaw: 0, pitch: -0.12 } };
const views = { outside: { ...VIEW_DEFAULTS.outside }, tip: { ...VIEW_DEFAULTS.tip }, inside: { ...VIEW_DEFAULTS.inside } };
function placeDesktopCamera() {
  const view = views[viewMode];
  if (viewMode === 'tip' || viewMode === 'inside') {
    const eye = viewMode === 'tip' ? PILOT_EYE : INSIDE_EYE;
    camera.fov = viewMode === 'tip' ? 80 : 85;
    camera.position.copy(eye);
    camera.lookAt(eye.clone().add(new THREE.Vector3(
      Math.sin(view.yaw) * Math.cos(view.pitch), Math.sin(view.pitch), -Math.cos(view.yaw) * Math.cos(view.pitch))));
  } else {
    camera.fov = 70;
    camera.position.set(
      PIVOT.x + view.dist * Math.sin(view.yaw) * Math.cos(view.pitch),
      PIVOT.y + view.dist * Math.sin(view.pitch),
      PIVOT.z + view.dist * Math.cos(view.yaw) * Math.cos(view.pitch),
    );
    camera.lookAt(PIVOT);
  }
  camera.updateProjectionMatrix();
}

scene.add(new THREE.HemisphereLight(0xdffaf5, 0x0b2226, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(1, 3, 2);
scene.add(sun);

const grid = new THREE.GridHelper(12, 24, 0x1f6f6c, 0x0d2a2d);
scene.add(grid);

// Pilot view surroundings. Stars and the deck under the player's feet never move, so the
// eye always has a fixed reference while the sphere turns (this is what keeps it comfortable).
const stars = (() => {
  const n = 900;
  const pos = new Float32Array(n * 3);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < n; i++) {
    const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = 45 + rnd() * 20;
    const s = Math.sqrt(1 - u * u);
    pos.set([r * s * Math.cos(a), r * u, r * s * Math.sin(a)], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ color: 0xcfeee9, size: 2, sizeAttenuation: false }));
})();
scene.add(stars);

const deck = new THREE.Group();
{
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.42, 64),
    new THREE.MeshBasicMaterial({ color: 0x2a8f88, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide }));
  disc.rotation.x = -Math.PI / 2;
  const edgePts = [];
  for (let i = 0; i <= 96; i++) { const a = (i / 96) * Math.PI * 2; edgePts.push(new THREE.Vector3(Math.cos(a) * 0.42, 0, Math.sin(a) * 0.42)); }
  const edge = new THREE.Line(new THREE.BufferGeometry().setFromPoints(edgePts),
    new THREE.LineBasicMaterial({ color: 0x9ff0dd, transparent: true, opacity: 0.7 }));
  deck.add(disc, edge);
  deck.position.y = 0.003;
}
scene.add(deck);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Canvas text helpers
// ---------------------------------------------------------------------------
function makeCanvasPlane(wM, hM, pxW = 1024) {
  const canvas = document.createElement('canvas');
  canvas.width = pxW;
  canvas.height = Math.round((pxW * hM) / wM);
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(wM, hM), mat);
  // Panels and buttons are UI: they draw after the sphere and on top of it, so the arrow or the
  // fog never covers a button the player needs.
  mesh.renderOrder = 10;
  mat.depthTest = false;
  return { mesh, canvas, ctx, tex, W: canvas.width, H: canvas.height };
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrap(ctx, text, x, y, maxW, lineH) {
  const paragraphs = String(text).split('\n');
  for (const para of paragraphs) {
    const words = para.split(' ');
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, x, y);
        y += lineH;
        line = w;
      } else {
        line = test;
      }
    }
    ctx.fillText(line, x, y);
    y += lineH;
  }
  return y;
}

function panelBackground(p, edge = C.panelEdge) {
  const { ctx, W, H } = p;
  ctx.clearRect(0, 0, W, H);
  rr(ctx, 6, 6, W - 12, H - 12, 28);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = edge;
  ctx.stroke();
}

function makeLabelSprite(text, color = C.mint, scale = 0.075) {
  const canvas = document.createElement('canvas');
  const measure = canvas.getContext('2d');
  measure.font = `600 64px ${FONT}`;
  canvas.width = Math.max(128, Math.ceil(measure.measureText(text).width + 48));
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.font = `600 64px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, canvas.width / 2, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set((scale * canvas.width) / canvas.height, scale, 1);
  return sprite;
}

function faceEye(obj, eyeY = 1.6) {
  obj.lookAt(new THREE.Vector3(0, eyeY, 0.3));
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------
const interactive = [];

function makeButton({ w, h, label, sub = '', kind = 'neutral', onClick, fontPx }) {
  const p = makeCanvasPlane(w, h, 512);
  const btn = { ...p, label, sub, kind, onClick, enabled: true, hover: 0, flash: 0 };
  btn.mesh.userData.button = btn;
  btn.draw = () => {
    const { ctx, W, H } = btn;
    ctx.clearRect(0, 0, W, H);
    const palette = {
      gate: [C.gate, C.gateHover], go: [C.go, C.goHover], neutral: [C.neutral, C.neutralHover],
    }[btn.kind] || [C.neutral, C.neutralHover];
    let fill = btn.hover ? palette[1] : palette[0];
    if (!btn.enabled) fill = C.disabled;
    rr(ctx, 6, 6, W - 12, H - 12, Math.min(40, H / 4));
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = btn.hover && btn.enabled ? 12 : 6;
    ctx.strokeStyle = btn.enabled ? (btn.hover ? C.mint : C.panelEdge) : '#2b3b3f';
    ctx.stroke();
    ctx.fillStyle = btn.enabled ? C.text : '#5d7377';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const big = fontPx || Math.round(H * (btn.sub ? 0.42 : 0.38));
    ctx.font = `700 ${big}px ${FONT}`;
    ctx.fillText(btn.label, W / 2, btn.sub ? H * 0.42 : H / 2);
    if (btn.sub) {
      ctx.font = `500 ${Math.round(H * 0.15)}px ${FONT}`;
      ctx.fillStyle = btn.enabled ? C.dim : '#4a5d61';
      ctx.fillText(btn.sub, W / 2, H * 0.78);
    }
    btn.tex.needsUpdate = true;
  };
  btn.setEnabled = (e) => { if (btn.enabled !== e) { btn.enabled = e; btn.draw(); } };
  btn.setLabel = (l, kind) => { btn.label = l; if (kind) btn.kind = kind; btn.draw(); };
  btn.setHover = (hv) => { if (btn.hover !== hv) { btn.hover = hv; btn.draw(); } };
  btn.draw();
  interactive.push(btn.mesh);
  return btn;
}

function isShown(obj) {
  for (let o = obj; o; o = o.parent) if (!o.visible) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Bloch sphere
// ---------------------------------------------------------------------------
const CENTER = new THREE.Vector3(0, 1.45, -1.25);
const R = 0.4;
const sphereGroup = new THREE.Group();
sphereGroup.position.copy(CENTER);
scene.add(sphereGroup);

// Bloch (x, y, z) -> scene (x, z, -y): Bloch z is up, Bloch x is to the player's right,
// Bloch y points away from the player. This keeps the frame right-handed.
const blochDir = (v) => new THREE.Vector3(v[0], v[2], -v[1]);
const blochLocal = (v) => blochDir(v).multiplyScalar(R);

const shell = new THREE.Mesh(
  new THREE.SphereGeometry(R, 48, 32),
  new THREE.MeshPhongMaterial({ color: C.sphere, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, shininess: 60 }),
);
sphereGroup.add(shell);

function ring(normalAxis, color = 0x5fbfb6, opacity = 0.55) {
  const pts = [];
  for (let i = 0; i <= 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    if (normalAxis === 'y') pts.push(new THREE.Vector3(Math.cos(a) * R, 0, Math.sin(a) * R));
    if (normalAxis === 'z') pts.push(new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0));
    if (normalAxis === 'x') pts.push(new THREE.Vector3(0, Math.sin(a) * R, Math.cos(a) * R));
  }
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
  sphereGroup.add(line);
  return line;
}
ring('y', 0x9ff0dd, 0.8); // equator
ring('z');
ring('x');

function axisLine(v) {
  const g = new THREE.BufferGeometry().setFromPoints([blochLocal(v.map((n) => -n)), blochLocal(v)]);
  sphereGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x3f8f88, transparent: true, opacity: 0.6 })));
}
axisLine([1, 0, 0]); axisLine([0, 1, 0]); axisLine([0, 0, 1]);

const axisLabels = [
  ['|0⟩', [0, 0, 1]], ['|1⟩', [0, 0, -1]], ['|+⟩', [1, 0, 0]], ['|−⟩', [-1, 0, 0]], ['|+i⟩', [0, 1, 0]], ['|−i⟩', [0, -1, 0]],
];
const axisLabelSprites = [];
for (const [t, v] of axisLabels) {
  const s = makeLabelSprite(t);
  s.position.copy(blochDir(v).multiplyScalar(R + 0.07));
  sphereGroup.add(s);
  axisLabelSprites.push(s);
}

// State arrow
const arrow = new THREE.Group();
const arrowMat = new THREE.MeshStandardMaterial({ color: C.arrow, emissive: C.arrow, emissiveIntensity: 0.6, roughness: 0.4 });
const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, R * 0.86, 16), arrowMat);
shaft.position.y = (R * 0.86) / 2;
const head = new THREE.Mesh(new THREE.ConeGeometry(0.026, R * 0.14, 24), arrowMat);
head.position.y = R * 0.93;
const tipDot = new THREE.Mesh(new THREE.SphereGeometry(0.014, 16, 12), arrowMat);
tipDot.position.y = R;
arrow.add(shaft, head, tipDot);
sphereGroup.add(arrow);
const UP = new THREE.Vector3(0, 1, 0);
function setArrow(v) {
  const d = blochDir(v);
  if (d.lengthSq() < 1e-9) return;
  arrow.quaternion.setFromUnitVectors(UP, d.normalize());
}

// Target beacon
const beacon = new THREE.Group();
const beaconCore = new THREE.Mesh(new THREE.SphereGeometry(0.03, 20, 16), new THREE.MeshBasicMaterial({ color: C.beacon }));
const beaconHalo = new THREE.Mesh(new THREE.SphereGeometry(0.06, 20, 16),
  new THREE.MeshBasicMaterial({ color: C.beacon, transparent: true, opacity: 0.25, depthWrite: false }));
beacon.add(beaconCore, beaconHalo);
sphereGroup.add(beacon);
const beaconLineGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, R, 0)]);
const beaconLine = new THREE.Line(beaconLineGeom, new THREE.LineDashedMaterial({ color: C.beacon, dashSize: 0.02, gapSize: 0.015, transparent: true, opacity: 0.7 }));
sphereGroup.add(beaconLine);
function setBeacon(v) {
  const p = blochLocal(v);
  beacon.position.copy(p);
  beaconLineGeom.setFromPoints([new THREE.Vector3(), p]);
  beaconLine.computeLineDistances();
}

// Ghost marker (used to reveal |+> after the Invisible Phase level)
const ghost = new THREE.Group();
ghost.add(new THREE.Mesh(new THREE.SphereGeometry(0.028, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 })));
const ghostLabel = makeLabelSprite('also 50/50', '#ffffff', 0.06);
ghostLabel.position.set(0, 0.07, 0);
ghost.add(ghostLabel);
ghost.visible = false;
sphereGroup.add(ghost);

// Path trace
const MAX_PATH = 4000;
const pathPositions = new Float32Array(MAX_PATH * 3);
const pathGeom = new THREE.BufferGeometry();
pathGeom.setAttribute('position', new THREE.BufferAttribute(pathPositions, 3));
pathGeom.setDrawRange(0, 0);
const pathLine = new THREE.Line(pathGeom, new THREE.LineBasicMaterial({ color: C.path }));
// Lines are 1 pixel wide in WebXR, so the trail also gets world-sized dots to stay visible.
const pathDots = new THREE.Points(pathGeom, new THREE.PointsMaterial({ color: C.path, size: 0.012, sizeAttenuation: true }));
pathLine.add(pathDots);
sphereGroup.add(pathLine);
let pathCount = 0;
function resetPath() { pathCount = 0; pathGeom.setDrawRange(0, 0); }
function pushPath(v) {
  if (pathCount >= MAX_PATH) return;
  const p = blochLocal(v);
  pathPositions.set([p.x, p.y, p.z], pathCount * 3);
  pathCount++;
  pathGeom.setDrawRange(0, pathCount);
  pathGeom.attributes.position.needsUpdate = true;
}

// Fog for the Invisible Phase level
const fog = new THREE.Mesh(new THREE.SphereGeometry(R * 1.04, 48, 32),
  new THREE.MeshPhongMaterial({ color: 0x8aa6a3, transparent: true, opacity: 0.82, depthWrite: false }));
const fogMark = makeLabelSprite('?', '#ffffff', 0.18);
fog.add(fogMark);
fog.visible = false;
sphereGroup.add(fog);

// ---------------------------------------------------------------------------
// Pilot view: the player rides the tip of the state vector.
// The sphere is scaled up and sits under the player's feet. Instead of moving the player
// (which makes people dizzy in VR), the sphere turns under them by the inverse of each gate's
// rotation, so the tip of the arrow always stays exactly at the player's feet.
// planetQ is that orientation: planetQ * (state direction) = straight up.
// ---------------------------------------------------------------------------
const PLANET_RADIUS = 1.1; // metres
const PLANET_SCALE = PLANET_RADIUS / R;
const planetQ = new THREE.Quaternion();
const tmpQ = new THREE.Quaternion();

function syncPlanet() {
  if (viewMode === 'tip') sphereGroup.quaternion.copy(planetQ);
  else sphereGroup.quaternion.identity();
}

// Point the sphere so that the state vec is straight up (used when a circuit starts over).
function resetPlanet(vec) {
  planetQ.setFromUnitVectors(blochDir(vec).normalize(), UP);
  syncPlanet();
}

// Orientation part-way through a gate: q0 times the inverse of the gate's rotation so far.
function planetDuring(q0, gate, angle) {
  tmpQ.setFromAxisAngle(blochDir(gate.axis).normalize(), -angle);
  planetQ.copy(q0).multiply(tmpQ).normalize();
  syncPlanet();
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------
const banner = makeCanvasPlane(1.4, 0.2, 1400);
banner.mesh.position.set(0, 2.08, -1.25);
faceEye(banner.mesh);
scene.add(banner.mesh);

const hud = makeCanvasPlane(0.62, 0.78, 900);
hud.mesh.position.set(-0.95, 1.45, -0.95);
faceEye(hud.mesh);
scene.add(hud.mesh);

const mission = makeCanvasPlane(0.66, 0.66, 900);
mission.mesh.position.set(0.97, 1.52, -0.95);
faceEye(mission.mesh);
scene.add(mission.mesh);

const missionButtons = new THREE.Group();
missionButtons.position.set(0.97, 1.1, -0.95);
faceEye(missionButtons);
scene.add(missionButtons);
const hintBtn = makeButton({ w: 0.26, h: 0.1, label: 'HINT', onClick: () => toggleHint() });
hintBtn.mesh.position.set(-0.17, 0, 0);
const primaryBtn = makeButton({ w: 0.34, h: 0.1, label: 'START', kind: 'go', onClick: () => primaryAction() });
primaryBtn.mesh.position.set(0.15, 0, 0);
missionButtons.add(hintBtn.mesh, primaryBtn.mesh);

// Player picker (staff use it on the start screen): < name >
const playerGroup = new THREE.Group();
playerGroup.position.set(0.97, 0.97, -0.95);
faceEye(playerGroup);
scene.add(playerGroup);
const prevPlayerBtn = makeButton({ w: 0.09, h: 0.09, label: '<', onClick: () => stepPlayer(-1) });
const playerBtn = makeButton({ w: 0.42, h: 0.09, label: 'PICK PLAYER', onClick: () => stepPlayer(1), fontPx: 30 });
const nextPlayerBtn = makeButton({ w: 0.09, h: 0.09, label: '>', onClick: () => stepPlayer(1) });
prevPlayerBtn.mesh.position.set(-0.27, 0, 0);
nextPlayerBtn.mesh.position.set(0.27, 0, 0);
playerGroup.add(prevPlayerBtn.mesh, playerBtn.mesh, nextPlayerBtn.mesh);

function setPlayer(name) {
  playerName = (name || '').slice(0, 60);
  storeSet(PLAYER_KEY, playerName);
  const pick = document.getElementById('playerPick');
  if (pick) pick.value = playerName;
  if (typeof state !== 'undefined' && gameReady) refreshAll();
}
function stepPlayer(dir) {
  if (!roster.length) return;
  const i = roster.indexOf(playerName);
  const next = i < 0 ? (dir > 0 ? 0 : roster.length - 1) : (i + dir + roster.length) % roster.length;
  setPlayer(roster[next]);
}
function fillPlayerPick() {
  const pick = document.getElementById('playerPick');
  if (!pick) return;
  pick.textContent = '';
  pick.add(new Option(roster.length ? 'pick a player' : 'no player list yet', ''));
  for (const n of roster) pick.add(new Option(n, n));
  if (playerName && !roster.includes(playerName)) pick.add(new Option(playerName, playerName));
  pick.value = playerName;
}
async function loadRoster() {
  try {
    const r = await fetch(`${BOARD_API}?what=players`, { cache: 'no-store' });
    const j = await r.json();
    roster = Array.isArray(j.names) ? j.names : [];
  } catch (e) { /* offline: keep whatever name is set */ }
  fillPlayerPick();
  if (gameReady) refreshAll();
}
{
  const pick = document.getElementById('playerPick');
  if (pick) pick.addEventListener('change', () => setPlayer(pick.value));
}

// View switch, under the left panel
let gameReady = false;
const viewGroup = new THREE.Group();
viewGroup.position.set(-0.95, 0.98, -0.95);
faceEye(viewGroup);
scene.add(viewGroup);
const otherView = () => (viewMode === 'outside' ? 'inside' : 'outside');
const viewBtn = makeButton({ w: 0.4, h: 0.09, label: 'OUTSIDE VIEW', onClick: () => setView(otherView()) });
viewGroup.add(viewBtn.mesh);

// Inside view: sphere centred on the player's chest, big enough that every panel sits inside it.
const INSIDE_CENTER = new THREE.Vector3(0, 1.25, 0);
const INSIDE_RADIUS = 2.4; // metres
const INSIDE_SCALE = INSIDE_RADIUS / R;

function setView(mode) {
  viewMode = mode;
  const space = mode !== 'outside';
  for (const s of axisLabelSprites) s.material.opacity = 1;
  arrow.scale.set(1, 1, 1);
  tipDot.scale.set(1, 1, 1);
  shaft.scale.y = 1;
  shaft.position.y = (R * 0.86) / 2;
  fogMark.visible = true;
  beacon.scale.setScalar(1);
  fog.material.side = THREE.FrontSide;
  if (mode === 'tip') {
    sphereGroup.position.set(0, -PLANET_RADIUS, 0);
    sphereGroup.scale.setScalar(PLANET_SCALE);
    banner.mesh.position.set(0, 1.64, -1.3);
    pathDots.material.size = 0.012 * PLANET_SCALE;
  } else if (mode === 'inside') {
    sphereGroup.position.copy(INSIDE_CENTER);
    sphereGroup.scale.setScalar(INSIDE_SCALE);
    banner.mesh.position.set(0, 2.08, -1.25);
    pathDots.material.size = 0.03;
    // A thinner arrow: at this size the normal one would be a 10 cm pole in the player's face.
    arrow.scale.set(0.3, 1, 0.3);
    tipDot.scale.set(1, 0.3, 1);
    // The shaft starts 0.8 m out from the chest, so it never passes through the player's head
    // or fills their view; the dashed beacon line still shows where it comes from.
    shaft.scale.y = (0.86 - 0.35) / 0.86;
    shaft.position.y = (R * (0.35 + 0.86)) / 2;
    fogMark.visible = false; // its centre would be the player's chest
    beacon.scale.setScalar(0.7);
    fog.material.side = THREE.DoubleSide; // the player is inside the fog, so draw its inner face
  } else {
    sphereGroup.position.copy(CENTER);
    sphereGroup.scale.setScalar(1);
    banner.mesh.position.set(0, 2.08, -1.25);
    pathDots.material.size = 0.012;
  }
  scene.background.set(space ? '#02090b' : C.bg);
  faceEye(banner.mesh);
  grid.visible = !space;
  stars.visible = space;
  deck.visible = space;
  syncPlanet();
  placeDesktopCamera();
  if (gameReady) refreshAll();
}

// In the pilot view, axis labels that come close to the player's feet fade out so they
// never sit in the player's face.
const tmpV = new THREE.Vector3();
function fadeNearLabels() {
  if (viewMode !== 'tip') return;
  for (const s of axisLabelSprites) {
    s.getWorldPosition(tmpV);
    const d = tmpV.length();
    s.material.opacity = Math.max(0, Math.min(1, (d - 0.3) / 0.4));
  }
}

// Circuit tray + actions
const trayGroup = new THREE.Group();
trayGroup.position.set(0, 1.1, -0.8);
faceEye(trayGroup);
scene.add(trayGroup);
const trayTitle = makeLabelSprite('CIRCUIT', C.dim, 0.05);
trayTitle.position.set(-0.47, 0, 0.001);
trayTitle.renderOrder = 10; trayTitle.material.depthTest = false;
trayGroup.add(trayTitle);
let traySlots = [];

const undoBtn = makeButton({ w: 0.13, h: 0.1, label: 'UNDO', onClick: () => undo() });
const clearBtn = makeButton({ w: 0.13, h: 0.1, label: 'CLEAR', onClick: () => clearTray() });
const launchBtn = makeButton({ w: 0.2, h: 0.1, label: 'LAUNCH', kind: 'go', onClick: () => launch() });
undoBtn.mesh.position.set(0.26, 0, 0);
clearBtn.mesh.position.set(0.41, 0, 0);
launchBtn.mesh.position.set(0.6, 0, 0);
trayGroup.add(undoBtn.mesh, clearBtn.mesh, launchBtn.mesh);

// Gate palette
const paletteGroup = new THREE.Group();
paletteGroup.position.set(0, 0.93, -0.62);
faceEye(paletteGroup);
scene.add(paletteGroup);
const gateButtons = {};
GATE_ORDER.forEach((k, i) => {
  const g = GATES[k];
  const b = makeButton({
    w: 0.14, h: 0.14, label: g.label, sub: k === 'RY' ? 'π/4' : '', kind: 'gate', onClick: () => addGate(k), fontPx: 120,
  });
  b.mesh.position.set((i - (GATE_ORDER.length - 1) / 2) * 0.17, 0, 0);
  paletteGroup.add(b.mesh);
  gateButtons[k] = b;
});
const paletteTitle = makeLabelSprite('GATES', C.dim, 0.05);
paletteTitle.position.set(-0.5, 0, 0.001);
paletteTitle.renderOrder = 10; paletteTitle.material.depthTest = false;
paletteGroup.add(paletteTitle);

function buildTraySlots(budget) {
  for (const s of traySlots) trayGroup.remove(s.mesh);
  traySlots = [];
  const spacing = 0.13;
  const startX = 0.13 - (budget - 1) * spacing - 0.05;
  for (let i = 0; i < budget; i++) {
    const p = makeCanvasPlane(0.11, 0.11, 256);
    p.mesh.position.set(startX + i * spacing, 0, 0);
    trayGroup.add(p.mesh);
    traySlots.push(p);
  }
}

function drawTray() {
  traySlots.forEach((p, i) => {
    const { ctx, W, H } = p;
    ctx.clearRect(0, 0, W, H);
    const k = state.tray[i];
    rr(ctx, 8, 8, W - 16, H - 16, 28);
    if (k) {
      const active = state.anim && state.anim.index === i;
      const done = state.anim && state.anim.index > i;
      ctx.fillStyle = active ? '#8a6a1f' : done ? '#2b5b3f' : C.gate;
      ctx.fill();
      ctx.lineWidth = 8;
      ctx.strokeStyle = active ? C.warn : C.panelEdge;
      ctx.stroke();
      ctx.fillStyle = C.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `700 ${k === 'RY' ? 84 : 110}px ${FONT}`;
      ctx.fillText(GATES[k].label, W / 2, H / 2);
    } else {
      ctx.setLineDash([18, 14]);
      ctx.lineWidth = 6;
      ctx.strokeStyle = '#3f6f6a';
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#4f7f79';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `600 64px ${FONT}`;
      ctx.fillText(String(i + 1), W / 2, H / 2);
    }
    p.tex.needsUpdate = true;
  });
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const state = {
  runId: '',
  sendStatus: '', // '' | sending | sent | retrying | failed
  phase: 'intro', // intro | playing | solved | finished
  levelIndex: 0,
  tray: [],
  psi: KET['0'],
  vec: [0, 0, 1],
  anim: null,
  runStart: 0,
  runEnd: 0,
  lastFidelity: null,
  lastLaunchProbs: null,
  hintShown: false,
  revealed: false,
  message: 'Press START when you are ready. The clock starts on START.',
  messageKind: 'info',
  results: LEVELS.map(() => ({ best: 0, solved: false, gates: null, attempts: 0 })),
  finishReason: '',
};

const level = () => LEVELS[state.levelIndex];
const goalText = (L) => (viewMode === 'tip' && L.pilotGoal) || (viewMode === 'inside' && L.insideGoal) || L.goal;
const now = () => performance.now() / 1000;
const elapsed = () => (state.runStart ? (state.runEnd || now()) - state.runStart : 0);

function fmtTime(s) {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function scoreFor(i) {
  const L = LEVELS[i];
  const r = state.results[i];
  if (!L.scored) return 0;
  let pts = Math.round(r.best * POINTS_PER_FIDELITY);
  if (r.solved) pts += (L.budget - r.gates) * POINTS_PER_SPARE_GATE;
  return pts;
}
const totalScore = () => LEVELS.reduce((s, _, i) => s + scoreFor(i), 0);

function setMessage(text, kind = 'info') {
  state.message = text;
  state.messageKind = kind;
  drawBanner();
}

function startRun() {
  state.runId = `${(HEADSET || 'x').replace(/[^A-Za-z0-9]/g, '')}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  state.sendStatus = '';
  state.runStart = now();
  state.runEnd = 0;
  state.results = LEVELS.map(() => ({ best: 0, solved: false, gates: null, attempts: 0 }));
  loadLevel(0);
}

function loadLevel(i) {
  state.levelIndex = i;
  state.phase = 'playing';
  state.tray = [];
  state.anim = null;
  state.lastFidelity = null;
  state.lastLaunchProbs = null;
  state.hintShown = false;
  state.revealed = false;
  const L = level();
  state.psi = KET[L.start];
  state.vec = bloch(state.psi);
  setArrow(state.vec);
  resetPlanet(state.vec);
  setBeacon(bloch(L.target));
  resetPath();
  ghost.visible = false;
  applyFog(L.fog);
  buildTraySlots(L.budget);
  setMessage(goalText(L), 'info');
  refreshAll();
}

function applyFog(on) {
  fog.visible = on;
  arrow.visible = !on;
  pathLine.visible = !on;
  beacon.visible = !on;
  beaconLine.visible = !on;
}

function addGate(k) {
  if (state.phase !== 'playing' || state.anim) return;
  const L = level();
  if (state.tray.length >= L.budget) {
    setMessage(`Gate budget used up (${L.budget}). Undo a gate or launch.`, 'warn');
    return;
  }
  state.tray.push(k);
  setMessage(`${GATES[k].name}: ${GATES[k].blurb}`, 'info');
  refreshAll();
}

function undo() {
  if (state.phase !== 'playing' || state.anim || !state.tray.length) return;
  state.tray.pop();
  refreshAll();
}

function clearTray() {
  if (state.phase !== 'playing' || state.anim) return;
  state.tray = [];
  refreshAll();
}

function launch() {
  if (state.phase !== 'playing' || state.anim || !state.tray.length) return;
  const L = level();
  state.results[state.levelIndex].attempts++;
  state.psi = KET[L.start];
  state.vec = bloch(state.psi);
  setArrow(state.vec);
  resetPlanet(state.vec);
  resetPath();
  pushPath(state.vec);
  state.anim = { index: 0, t: 0, from: state.vec.slice(), q0: planetQ.clone() };
  setMessage('Launching…', 'info');
  refreshAll();
}

// Seconds per gate. Slower in the pilot view: the ground turning under you should feel calm.
const stepSeconds = () => (viewMode === 'tip' ? 2.2 : viewMode === 'inside' ? 1.4 : 0.8);
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function stepAnimation(dt) {
  const a = state.anim;
  if (!a) return;
  const g = GATES[state.tray[a.index]];
  a.t += dt;
  const p = Math.min(1, a.t / stepSeconds());
  const v = rotate(a.from, g.axis, g.angle * ease(p));
  state.vec = v;
  setArrow(v);
  planetDuring(a.q0, g, g.angle * ease(p));
  pushPath(v);
  if (p >= 1) {
    state.psi = applyGate(g, state.psi);
    state.vec = bloch(state.psi);
    setArrow(state.vec);
    planetDuring(a.q0, g, g.angle);
    a.index++;
    a.t = 0;
    a.from = state.vec.slice();
    a.q0 = planetQ.clone();
    drawTray();
    if (a.index >= state.tray.length) {
      state.anim = null;
      finishLaunch();
    }
  }
}

function finishLaunch() {
  const L = level();
  const r = state.results[state.levelIndex];
  const F = Math.min(1, fidelity(state.psi, L.target));
  const probs = probabilities(state.psi);
  state.lastFidelity = F;
  state.lastLaunchProbs = probs;
  r.best = Math.max(r.best, F);
  if (F >= PASS_FIDELITY) {
    r.solved = true;
    r.gates = state.tray.length;
    state.phase = 'solved';
    if (L.fog) revealPhase();
    const spare = L.budget - r.gates;
    const pts = L.scored ? ` +${scoreFor(state.levelIndex)} points.` : '';
    setMessage(`Checkpoint reached! Fidelity ${(F * 100).toFixed(1)}%.${spare > 0 && L.scored ? ` ${spare} gate${spare > 1 ? 's' : ''} to spare.` : ''}${pts}`, 'good');
  } else if (L.fog && Math.abs(probs[0] - 0.5) < 0.02) {
    setMessage('Right odds, wrong phase! 50/50 is correct, but the checkpoint is still locked. Change the phase.', 'warn');
  } else {
    setMessage(`Not there yet. Fidelity ${(F * 100).toFixed(1)}%. Change your circuit and launch again.`, 'warn');
  }
  refreshAll();
}

function revealPhase() {
  state.revealed = true;
  applyFog(false);
  ghost.position.copy(blochLocal(bloch(KET[level().ghost || '+'])));
  ghost.visible = true;
}

function toggleHint() {
  if (state.phase !== 'playing' && state.phase !== 'solved') return;
  state.hintShown = !state.hintShown;
  drawMission();
}

function primaryAction() {
  if (state.anim) return;
  if (state.phase === 'intro') startRun();
  else if (state.phase === 'solved') {
    if (state.levelIndex < LEVELS.length - 1) loadLevel(state.levelIndex + 1);
    else finishRun('all levels done');
  } else if (state.phase === 'finished') resetForNextPlayer();
}

function finishRun(reason) {
  state.phase = 'finished';
  state.runEnd = now();
  state.anim = null;
  state.finishReason = reason;
  applyFog(false);
  saveResult();
  queueResult();
  setMessage('Run complete. Show this screen to a staff member.', 'good');
  refreshAll();
}

function resetForNextPlayer() {
  if (gameReady && state.phase === 'finished') setPlayer('');
  state.phase = 'intro';
  state.runStart = 0;
  state.runEnd = 0;
  state.levelIndex = 0;
  state.tray = [];
  state.results = LEVELS.map(() => ({ best: 0, solved: false, gates: null, attempts: 0 }));
  state.psi = KET['0'];
  state.vec = [0, 0, 1];
  setArrow(state.vec);
  resetPlanet(state.vec);
  resetPath();
  ghost.visible = false;
  applyFog(false);
  setBeacon(bloch(LEVELS[0].target));
  buildTraySlots(LEVELS[0].budget);
  setMessage('Press START when you are ready. The clock starts on START.', 'info');
  refreshAll();
}

function queueResult() {
  const scored = LEVELS.filter((L) => L.scored);
  const rec = {
    action: 'score', round: ROUND, runId: state.runId, name: playerName, headset: HEADSET,
    score: totalScore(), time: Math.round(elapsed()),
    levels: LEVELS.filter((L, i) => L.scored && state.results[i].solved).length, total: scored.length,
    reason: state.finishReason,
  };
  let box = [];
  try { box = JSON.parse(storeGet(OUTBOX_KEY) || '[]'); } catch (e) { box = []; }
  box.push(rec);
  storeSet(OUTBOX_KEY, JSON.stringify(box.slice(-50)));
  outboxMem = box.slice(-50);
  state.sendStatus = 'sending';
  flushOutbox();
}

let outboxMem = null; // used when the headset's storage is unavailable
let flushing = false;
async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  try {
    let box;
    try { box = JSON.parse(storeGet(OUTBOX_KEY) || 'null'); } catch (e) { box = null; }
    if (!Array.isArray(box)) box = outboxMem || [];
    const left = [];
    for (const rec of box) {
      try {
        const r = await fetch(BOARD_API, { method: 'POST', body: JSON.stringify(rec) });
        if (r.ok || r.status === 400) { if (rec.runId === state.runId) state.sendStatus = r.ok ? 'sent' : 'failed'; continue; }
        left.push(rec);
      } catch (e) { left.push(rec); }
    }
    storeSet(OUTBOX_KEY, JSON.stringify(left));
    outboxMem = left;
    if (left.some((x) => x.runId === state.runId)) state.sendStatus = 'retrying';
    if (state.phase === 'finished') drawMission();
  } finally { flushing = false; }
}
setInterval(flushOutbox, 10000);

function saveResult() {
  try {
    const list = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    list.push({
      at: new Date().toISOString(),
      headset: HEADSET,
      round: ROUND,
      score: totalScore(),
      time: Math.round(elapsed()),
      reason: state.finishReason,
      levels: LEVELS.map((L, i) => ({
        id: L.id, best: Number(state.results[i].best.toFixed(4)), solved: state.results[i].solved,
        gates: state.results[i].gates, attempts: state.results[i].attempts,
      })),
    });
    localStorage.setItem(LOG_KEY, JSON.stringify(list.slice(-200)));
  } catch (e) { /* storage unavailable: the on-screen summary is the record */ }
}

// ---------------------------------------------------------------------------
// Drawing panels
// ---------------------------------------------------------------------------
function drawBanner() {
  const p = banner;
  const { ctx, W, H } = p;
  const edge = { good: C.go, warn: C.warn, bad: C.bad }[state.messageKind] || C.panelEdge;
  panelBackground(p, edge);
  ctx.fillStyle = C.text;
  ctx.textAlign = 'center';
  let size = 54;
  ctx.font = `600 ${size}px ${FONT}`;
  if (ctx.measureText(state.message).width <= W - 90) {
    ctx.textBaseline = 'middle';
    ctx.fillText(state.message, W / 2, H / 2);
  } else {
    // Two lines: shrink until the wrapped text fits in the banner height.
    size = 46;
    let lines;
    for (;;) {
      ctx.font = `600 ${size}px ${FONT}`;
      lines = splitLines(ctx, state.message, W - 90);
      if (lines.length <= 2 || size <= 30) break;
      size -= 2;
    }
    ctx.textBaseline = 'middle';
    const lh = size * 1.18;
    const y0 = H / 2 - ((lines.length - 1) * lh) / 2;
    lines.forEach((l, i) => ctx.fillText(l, W / 2, y0 + i * lh));
  }
  p.tex.needsUpdate = true;
}

function splitLines(ctx, text, maxW) {
  const out = [];
  let line = '';
  for (const w of String(text).split(' ')) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) { out.push(line); line = w; } else line = test;
  }
  if (line) out.push(line);
  return out;
}

function drawHUD() {
  const p = hud;
  const { ctx, W } = p;
  panelBackground(p);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const x = 52;
  const right = W - 52;
  let y = 96;
  ctx.fillStyle = C.mint;
  ctx.font = `800 64px ${FONT}`;
  ctx.fillText('BLOCH PILOT', x, y);
  if (HEADSET) {
    ctx.textAlign = 'right';
    ctx.fillStyle = C.dim;
    ctx.font = `600 40px ${FONT}`;
    ctx.fillText(`Headset ${HEADSET}`, right, y);
    ctx.textAlign = 'left';
  }
  y += 76;
  ctx.fillStyle = C.text;
  ctx.font = `700 48px ${FONT}`;
  const title = state.phase === 'intro' ? `Ready · ${ROUND_NAME}` : state.phase === 'finished' ? 'Run complete' : level().title;
  y = wrap(ctx, title, x, y, right - x, 58);

  const remaining = RUN_MINUTES * 60 - elapsed();
  const rows = [
    ['Time left', state.runStart ? fmtTime(remaining) : fmtTime(RUN_MINUTES * 60), remaining < 60 && state.runStart ? C.warn : C.text],
    ['Gates used', state.phase === 'intro' || state.phase === 'finished' ? '–' : `${state.tray.length} / ${level().budget}`, C.text],
    ['Last fidelity', state.lastFidelity == null ? '–' : `${(state.lastFidelity * 100).toFixed(1)}%`, C.text],
    ['Score', String(totalScore()), C.mint],
  ];
  y += 26;
  for (const [k, v, col] of rows) {
    ctx.fillStyle = C.dim;
    ctx.textAlign = 'left';
    ctx.font = `500 44px ${FONT}`;
    ctx.fillText(k, x, y);
    ctx.fillStyle = col;
    ctx.textAlign = 'right';
    ctx.font = `700 48px ${FONT}`;
    ctx.fillText(v, right, y);
    y += 72;
  }

  // Measurement odds of the arrow's current state
  y += 24;
  ctx.textAlign = 'left';
  ctx.fillStyle = C.dim;
  ctx.font = `600 40px ${FONT}`;
  ctx.fillText('If you measured now:', x, y);
  y += 24;
  const probs = probabilities(state.psi);
  const showProbs = !state.anim;
  ['0', '1'].forEach((lab, i) => {
    const barY = y + i * 92;
    ctx.fillStyle = C.text;
    ctx.font = `700 46px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(`|${lab}⟩`, x, barY + 58);
    const bx = x + 110, bw = right - x - 110 - 130, bh = 54;
    rr(ctx, bx, barY + 18, bw, bh, 16);
    ctx.fillStyle = '#12302f';
    ctx.fill();
    if (showProbs) {
      const val = probs[i];
      if (val > 0.002) {
        rr(ctx, bx, barY + 18, Math.max(32, bw * val), bh, 16);
        ctx.fillStyle = i === 0 ? '#3fbfa8' : '#d98f3a';
        ctx.fill();
      }
      ctx.fillStyle = C.text;
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(val * 100)}%`, right, barY + 60);
    }
  });
  p.tex.needsUpdate = true;
}

function drawMission() {
  const p = mission;
  const { ctx, W } = p;
  panelBackground(p);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const x = 52;
  const maxW = W - 104;
  let y = 92;
  ctx.fillStyle = C.mint;
  ctx.font = `800 52px ${FONT}`;

  if (state.phase === 'intro') {
    ctx.fillText('YOUR MISSION', x, y);
    y += 70;
    ctx.fillStyle = C.text;
    ctx.font = `500 42px ${FONT}`;
    if (viewMode === 'inside') {
      y = wrap(ctx, 'You are inside the Bloch sphere. The orange arrow coming out of your chest is your qubit.', x, y, maxW, 54);
      y += 14;
      y = wrap(ctx, '1. Press gate blocks to build your circuit.\n2. Press LAUNCH and the arrow swings around you.\n3. Point the arrow at the glowing beacon.', x, y, maxW, 54);
    } else if (viewMode === 'tip') {
      y = wrap(ctx, 'You are the qubit. You stand on the tip of its arrow. Look down: the sphere is under your feet.', x, y, maxW, 54);
      y += 14;
      y = wrap(ctx, '1. Press gate blocks to build your circuit.\n2. Press LAUNCH. The sphere turns under you.\n3. Bring the glowing beacon to your feet.', x, y, maxW, 54);
    } else {
      y = wrap(ctx, 'Steer the orange arrow (your qubit) to the glowing beacon.', x, y, maxW, 54);
      y += 14;
      y = wrap(ctx, '1. Press gate blocks to build your circuit.\n2. Press LAUNCH and watch the arrow move.\n3. Reach the beacon to pass the checkpoint.', x, y, maxW, 54);
    }
    y += 14;
    ctx.fillStyle = C.dim;
    ctx.font = `500 38px ${FONT}`;
    const nScored = LEVELS.filter((L) => L.scored).length;
    const warm = LEVELS.some((L) => !L.scored) ? 'a warm-up and ' : '';
    wrap(ctx, `${ROUND_NAME}: ${RUN_MINUTES} minutes for ${warm}${nScored} scored levels. Score: fidelity first, then spare gates, then time.`, x, y, maxW, 50);
  } else if (state.phase === 'finished') {
    ctx.fillText('RESULTS', x, y);
    if (HEADSET) {
      ctx.textAlign = 'right';
      ctx.fillStyle = C.dim;
      ctx.font = `600 40px ${FONT}`;
      ctx.fillText(`Headset ${HEADSET}`, W - 52, y);
      ctx.textAlign = 'left';
    }
    y += 72;
    const scoredCount = LEVELS.filter((L) => L.scored).length;
    if (scoredCount > 6) {
      const passed = LEVELS.filter((L, i) => L.scored && state.results[i].solved).length;
      ctx.font = `600 44px ${FONT}`;
      ctx.fillStyle = C.text;
      ctx.fillText(`Levels passed: ${passed} of ${scoredCount}`, x, y);
      y += 64;
    }
    LEVELS.forEach((L, i) => {
      if (!L.scored || scoredCount > 6) return;
      const r = state.results[i];
      ctx.font = `600 40px ${FONT}`;
      ctx.fillStyle = C.text;
      ctx.fillText(L.title.split(' · ')[1], x, y);
      ctx.textAlign = 'right';
      ctx.fillStyle = r.solved ? C.mint : C.warn;
      ctx.fillText(r.solved ? `${(r.best * 100).toFixed(0)}% · ${r.gates} gates` : `${(r.best * 100).toFixed(0)}% · not solved`, W - 52, y);
      ctx.textAlign = 'left';
      y += 56;
    });
    y += 34;
    ctx.fillStyle = C.text;
    ctx.font = `800 84px ${FONT}`;
    ctx.fillText(`${totalScore()} pts`, x, y + 20);
    ctx.textAlign = 'right';
    ctx.font = `700 50px ${FONT}`;
    ctx.fillText(`Time ${fmtTime(elapsed())}`, W - 52, y + 20);
    ctx.textAlign = 'left';
    y += 96;
    ctx.fillStyle = C.dim;
    ctx.font = `500 36px ${FONT}`;
    ctx.font = `600 40px ${FONT}`;
    ctx.fillStyle = C.text;
    ctx.fillText(playerName || 'No player name picked', x, y);
    y += 56;
    const st = state.sendStatus;
    ctx.fillStyle = st === 'sent' ? C.mint : C.warn;
    ctx.font = `600 36px ${FONT}`;
    ctx.fillText(st === 'sent' ? 'Sent to the leaderboard ✓' : st === 'failed' ? 'Leaderboard refused it: write it down' : 'Sending to the leaderboard…', x, y);
    y += 52;
    ctx.fillStyle = C.dim;
    ctx.font = `500 34px ${FONT}`;
    wrap(ctx, 'Staff: press NEW PLAYER, then pick the next name.', x, y, maxW, 44);
  } else {
    const L = level();
    ctx.fillText(state.phase === 'solved' ? 'CHECKPOINT REACHED' : 'TARGET', x, y);
    y += 68;
    ctx.fillStyle = C.text;
    ctx.font = `500 40px ${FONT}`;
    if (state.phase === 'solved') {
      if (L.fog) {
        y = wrap(ctx, L.revealText || 'The fog is gone.', x, y, maxW, 52);
        y += 12;
      }
      ctx.fillStyle = C.dim;
      ctx.font = `600 38px ${FONT}`;
      ctx.fillText('Your circuit in Qiskit:', x, y);
      y += 56;
      ctx.fillStyle = C.mint;
      ctx.font = `500 38px ui-monospace, Menlo, Consolas, monospace`;
      const lines = ['qc = QuantumCircuit(1)', ...state.tray.map((k) => GATES[k].qiskit)];
      for (const line of lines) { ctx.fillText(line, x, y); y += 50; }
      y += 12;
      ctx.fillStyle = C.text;
      ctx.font = `600 40px ${FONT}`;
      ctx.fillText(state.levelIndex < LEVELS.length - 1 ? 'Press NEXT for the next level.' : 'Press FINISH to see your results.', x, y);
    } else {
      y = wrap(ctx, goalText(L), x, y, maxW, 52);
      y += 10;
      ctx.fillStyle = C.dim;
      y = wrap(ctx, `Target: ${L.targetName}. Gate budget: ${L.budget}.`, x, y, maxW, 52);
      if (state.hintShown) {
        y += 12;
        ctx.fillStyle = C.warn;
        wrap(ctx, `Hint: ${L.hint}`, x, y, maxW, 52);
      }
    }
  }
  p.tex.needsUpdate = true;
}

function refreshButtons() {
  const playing = state.phase === 'playing' && !state.anim;
  const L = state.phase === 'playing' || state.phase === 'solved' ? level() : null;
  for (const k of GATE_ORDER) gateButtons[k].setEnabled(playing && state.tray.length < (L ? L.budget : 0));
  undoBtn.setEnabled(playing && state.tray.length > 0);
  clearBtn.setEnabled(playing && state.tray.length > 0);
  launchBtn.setEnabled(playing && state.tray.length > 0);
  hintBtn.setEnabled((state.phase === 'playing' || state.phase === 'solved') && !state.anim);
  hintBtn.setLabel(state.hintShown ? 'HIDE HINT' : 'HINT');
  if (state.phase === 'intro') primaryBtn.setLabel('START', 'go');
  else if (state.phase === 'solved') primaryBtn.setLabel(state.levelIndex < LEVELS.length - 1 ? 'NEXT' : 'FINISH', 'go');
  else if (state.phase === 'finished') primaryBtn.setLabel('NEW PLAYER', 'neutral');
  else primaryBtn.setLabel('NEXT', 'go');
  primaryBtn.setEnabled(state.phase !== 'playing' && !state.anim);
  viewBtn.setLabel(viewMode === 'outside' ? 'INSIDE VIEW' : 'OUTSIDE VIEW');
  viewBtn.setEnabled(!state.anim);
  const intro = state.phase === 'intro';
  playerGroup.visible = intro;
  playerBtn.setLabel(playerName ? `PLAYER: ${playerName}`.slice(0, 26) : (roster.length ? 'PICK PLAYER' : 'NO PLAYER LIST'));
  playerBtn.setEnabled(intro && roster.length > 0);
  prevPlayerBtn.setEnabled(intro && roster.length > 0);
  nextPlayerBtn.setEnabled(intro && roster.length > 0);
}

function refreshAll() {
  drawTray();
  drawHUD();
  drawMission();
  drawBanner();
  refreshButtons();
}

// ---------------------------------------------------------------------------
// Input: VR controllers (and hands), mouse, keyboard
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const tmpMat = new THREE.Matrix4();

function pickFromRay(origin, dir) {
  raycaster.ray.origin.copy(origin);
  raycaster.ray.direction.copy(dir);
  const targets = interactive.filter((m) => isShown(m));
  const hits = raycaster.intersectObjects(targets, false);
  return hits.length ? hits[0] : null;
}

function press(btn, source) {
  if (!btn || !btn.enabled) return;
  if (source && source.gamepad && source.gamepad.hapticActuators && source.gamepad.hapticActuators[0]) {
    try { source.gamepad.hapticActuators[0].pulse(0.4, 40); } catch (e) { /* no haptics */ }
  }
  btn.onClick();
}

const controllers = [0, 1].map((i) => {
  const ctrl = renderer.xr.getController(i);
  const rayGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  const ray = new THREE.Line(rayGeom, new THREE.LineBasicMaterial({ color: 0x9ff0dd, transparent: true, opacity: 0.8 }));
  ray.scale.z = 2.5;
  ray.renderOrder = 20;
  ray.material.depthTest = false;
  ctrl.add(ray);
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8), new THREE.MeshBasicMaterial({ color: 0x9ff0dd, depthTest: false }));
  dot.renderOrder = 20;
  dot.visible = false;
  scene.add(dot);
  const entry = { ctrl, ray, dot, source: null, hovered: null };
  ctrl.addEventListener('connected', (e) => { entry.source = e.data; });
  ctrl.addEventListener('disconnected', () => { entry.source = null; });
  ctrl.addEventListener('selectstart', () => {
    const hit = rayFromController(entry);
    if (hit) press(hit.object.userData.button, entry.source);
  });
  scene.add(ctrl);
  const grip = renderer.xr.getControllerGrip(i);
  grip.add(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.1), new THREE.MeshStandardMaterial({ color: 0x2a8f88 })));
  scene.add(grip);
  return entry;
});

function rayFromController(entry) {
  tmpMat.identity().extractRotation(entry.ctrl.matrixWorld);
  const origin = new THREE.Vector3().setFromMatrixPosition(entry.ctrl.matrixWorld);
  const dir = new THREE.Vector3(0, 0, -1).applyMatrix4(tmpMat);
  return pickFromRay(origin, dir);
}

function updateVRHover() {
  const hovered = new Set();
  for (const entry of controllers) {
    const hit = renderer.xr.isPresenting ? rayFromController(entry) : null;
    if (hit) {
      hovered.add(hit.object.userData.button);
      entry.ray.scale.z = hit.distance;
      entry.dot.visible = true;
      entry.dot.position.copy(hit.point);
    } else {
      entry.ray.scale.z = 2.5;
      entry.dot.visible = false;
    }
  }
  return hovered;
}

// Mouse
const mouse = new THREE.Vector2();
let mouseHover = null;
let drag = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  const view = views[viewMode];
  drag = { x: e.clientX, y: e.clientY, moved: false, yaw: view.yaw, pitch: view.pitch };
});
renderer.domElement.addEventListener('pointermove', (e) => {
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
    if (drag.moved) {
      const view = views[viewMode];
      if (viewMode !== 'outside') {
        view.yaw = drag.yaw - dx * 0.004;
        view.pitch = Math.max(-1.5, Math.min(0.7, drag.pitch + dy * 0.004));
      } else {
        view.yaw = drag.yaw - dx * 0.006;
        view.pitch = Math.max(-0.6, Math.min(1.1, drag.pitch + dy * 0.004));
      }
      placeDesktopCamera();
    }
  }
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (drag && !drag.moved) {
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hit = pickFromRay(raycaster.ray.origin.clone(), raycaster.ray.direction.clone());
    if (hit) press(hit.object.userData.button);
  }
  drag = null;
});

window.addEventListener('keydown', (e) => {
  if (e.key >= '1' && e.key <= '5') addGate(GATE_ORDER[Number(e.key) - 1]);
  else if (e.key === 'Backspace') undo();
  else if (e.key === 'Enter') { if (state.phase === 'playing') launch(); else primaryAction(); }
  else if (e.key === 'r' || e.key === 'R') { Object.assign(views[viewMode], VIEW_DEFAULTS[viewMode]); placeDesktopCamera(); }
  else if (e.key === 'v' || e.key === 'V') { if (!state.anim) setView(otherView()); }
  else if (e.key === 'h' || e.key === 'H') toggleHint();
});

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
let lastHudSecond = -1;

renderer.setAnimationLoop(() => {
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.elapsedTime;

  // Hover
  let hovered = new Set();
  if (renderer.xr.isPresenting) hovered = updateVRHover();
  else {
    raycaster.setFromCamera(mouse, camera);
    const hit = drag && drag.moved ? null : pickFromRay(raycaster.ray.origin.clone(), raycaster.ray.direction.clone());
    mouseHover = hit ? hit.object.userData.button : null;
    if (mouseHover) hovered.add(mouseHover);
    renderer.domElement.style.cursor = mouseHover && mouseHover.enabled ? 'pointer' : drag ? 'grabbing' : 'grab';
  }
  for (const m of interactive) {
    const b = m.userData.button;
    b.setHover(hovered.has(b) && b.enabled ? 1 : 0);
  }

  // Launch animation
  if (state.anim) {
    stepAnimation(dt);
    drawHUD();
  }

  // Beacon pulse
  const s = 1 + 0.25 * Math.sin(t * 4);
  beaconHalo.scale.setScalar(s);
  fogMark.material.opacity = 0.6 + 0.4 * Math.sin(t * 2);
  fadeNearLabels();

  // Clock
  if (state.runStart && (state.phase === 'playing' || state.phase === 'solved')) {
    const sec = Math.floor(elapsed());
    if (sec !== lastHudSecond) {
      lastHudSecond = sec;
      drawHUD();
    }
    if (elapsed() >= RUN_MINUTES * 60 && !state.anim) finishRun('time up');
  }

  renderer.render(scene, camera);
});

// ---------------------------------------------------------------------------
// Results log page (?log=1)
// ---------------------------------------------------------------------------
function showLog() {
  const el = document.getElementById('log');
  el.style.display = 'block';
  let list = [];
  try { list = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (e) { list = []; }
  const rows = list.slice().reverse().map((r) => `<tr><td>${new Date(r.at).toLocaleTimeString()}</td><td>${r.headset || ''}</td><td>${r.score}</td><td>${fmtTime(r.time)}</td><td>${r.round || ''}</td><td>${r.levels.filter((l) => l.solved && l.id !== 'tutorial').length}/${r.levels.filter((l) => l.id !== 'tutorial').length}</td><td>${r.reason}</td></tr>`).join('');
  el.innerHTML = `<h2>Results saved on this device</h2>
    <table><tr><th>Finished</th><th>Headset</th><th>Score</th><th>Time</th><th>Round</th><th>Levels solved</th><th>Ended by</th></tr>${rows || '<tr><td colspan="7">No runs yet.</td></tr>'}</table>
    <button id="close-log">Back to the game</button><button id="clear-log">Delete all results on this device</button>`;
  el.querySelector('#close-log').onclick = () => { el.style.display = 'none'; };
  el.querySelector('#clear-log').onclick = () => {
    try { localStorage.removeItem(LOG_KEY); } catch (e) { /* ignore */ }
    showLog();
  };
}

// Test hook for automated checks.
window.__bloch = {
  state, addGate, launch, undo, clearTray, primaryAction, totalScore, LEVELS, finishRun, setView,
  view: () => viewMode,
  player: () => playerName, setPlayer, roster: () => roster, outbox: () => storeGet(OUTBOX_KEY), flushOutbox,
  round: ROUND,
  tipWorld: () => tipDot.getWorldPosition(new THREE.Vector3()).toArray(),
  beaconWorld: () => beacon.getWorldPosition(new THREE.Vector3()).toArray(),
  setLook: (yaw, pitch) => { Object.assign(views[viewMode], { yaw, pitch }); placeDesktopCamera(); },
  debugCam: (pos, yaw, pitch, fov) => {
    camera.fov = fov; camera.position.set(...pos);
    camera.lookAt(camera.position.clone().add(new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))));
    camera.updateProjectionMatrix();
  },
};

setView(viewMode);
gameReady = true;
resetForNextPlayer();
loadRoster();
flushOutbox();

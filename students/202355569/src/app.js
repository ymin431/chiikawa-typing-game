import * as THREE from '/three.module.min.js';

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const now = () => performance.now();
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const easeOutBack = t => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2;
const format = n => Number(n).toLocaleString('ko-KR');
const levels = { easy: '쉬움', normal: '보통', hard: '어려움' };
// Must mirror RULES/POINTS in server.py so the live score matches the verified one.
const RULES = { easy: { holes: 6, cols: 3, factor: 1 }, normal: { holes: 9, cols: 3, factor: 1.3 }, hard: { holes: 12, cols: 4, factor: 1.6 } };
const POINTS = { mole: 10, gold: 30, bunny: -20 };
const storage = {
  get(k, f) { try { return JSON.parse(localStorage.getItem('bonk.' + k)) ?? f; } catch { return f; } },
  set(k, v) { try { localStorage.setItem('bonk.' + k, JSON.stringify(v)); } catch {} },
};
const prefs = storage.get('prefs', { sound: true });
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let difficulty = storage.get('difficulty', 'normal'), boardDifficulty = difficulty;
let state = 'idle', game = null, lastResult = null, toastTimer = 0;

function node(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
function toast(msg) { $('#toast').textContent = msg; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 3800); }
async function api(path, body) {
  const ctrl = new AbortController(), timeout = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
    let data; try { data = await res.json(); } catch { throw Error('서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.'); }
    if (!res.ok) throw Error(data.error || '요청을 완료하지 못했어요.');
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw Error('연결이 오래 걸리고 있어요. 다시 시도해 주세요.');
    if (e instanceof TypeError) throw Error('서버 연결을 확인해 주세요.');
    throw e;
  } finally { clearTimeout(timeout); }
}

/* ================================================================
   Sound: synthesised toy-hammer effects, click.mp3 for UI buttons
   ================================================================ */
const sound = { ctx: null, master: null, click: null, raw: null };
fetch('/click.mp3').then(r => r.ok ? r.arrayBuffer() : null).then(b => { sound.raw = b; decodeClick(); }).catch(() => {});
function audioCtx() {
  if (!sound.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    sound.ctx = new AC(); sound.master = sound.ctx.createGain(); sound.master.gain.value = .8; sound.master.connect(sound.ctx.destination);
    decodeClick();
  }
  if (sound.ctx.state === 'suspended') sound.ctx.resume();
  return sound.ctx;
}
async function decodeClick() {
  if (!sound.ctx || !sound.raw) return;
  const raw = sound.raw; sound.raw = null;
  try { sound.click = await sound.ctx.decodeAudioData(raw); } catch {}
}
function tone(freq, { type = 'sine', at = 0, dur = .4, gain = .2, to = null, attack = .005 } = {}) {
  const ctx = sound.ctx, t = ctx.currentTime + at, osc = ctx.createOscillator(), amp = ctx.createGain();
  osc.type = type; osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur * .8);
  amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(gain, t + attack); amp.gain.exponentialRampToValueAtTime(.0001, t + dur);
  osc.connect(amp).connect(sound.master); osc.start(t); osc.stop(t + dur + .02);
}
function thud(gain = .25, freq = 600) {
  const ctx = sound.ctx, t = ctx.currentTime, len = Math.floor(ctx.sampleRate * .08), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * .2));
  const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  src.buffer = buf; f.type = 'lowpass'; f.frequency.value = freq; g.gain.value = gain;
  src.connect(f).connect(g).connect(sound.master); src.start(t);
}
// Browsers only allow audio after the first click or key press.
const on = () => prefs.sound && (navigator.userActivation?.hasBeenActive ?? true) && audioCtx();
const play = {
  ui() {
    if (!on()) return;
    if (sound.click) { const s = sound.ctx.createBufferSource(), g = sound.ctx.createGain(); s.buffer = sound.click; g.gain.value = .7; s.connect(g).connect(sound.master); s.start(); }
    else tone(1200, { dur: .05, gain: .06, to: 800, attack: .001 });
  },
  bonk(combo) { // the squeaky "뿅"
    if (!on()) return;
    thud(.35, 900);
    const f = 520 * 2 ** (Math.min(combo, 12) / 24);
    tone(f, { type: 'square', dur: .12, gain: .05, to: f * 2.6, attack: .002 }); tone(f * 1.5, { dur: .16, gain: .1, to: f * 3.2, attack: .002 });
  },
  gold() { if (!on()) return; this.bonk(8); [0, 4, 7, 12, 16].forEach((s, i) => tone(1047 * 2 ** (s / 12), { at: .05 + i * .05, dur: .4, gain: .07 })); },
  bunny() { if (!on()) return; thud(.3, 500); tone(330, { dur: .45, gain: .16, to: 110 }); tone(345, { type: 'triangle', dur: .3, gain: .06, to: 140 }); },
  whiff() { if (!on()) return; thud(.18, 320); },
  cheer() { if (!on()) return; [0, 5, 9].forEach((s, i) => tone(1175 * 2 ** (s / 12), { at: i * .05, dur: .25, gain: .05, type: 'triangle' })); },
  pop() { if (!on()) return; tone(rand(380, 460), { dur: .07, gain: .035, to: rand(700, 800), attack: .002 }); },
  beep(high) { if (!on()) return; tone(high ? 1047 : 698, { dur: high ? .45 : .18, gain: .1 }); },
  fanfare() { if (!on()) return; [0, 4, 7, 12].forEach((s, i) => tone(784 * 2 ** (s / 12), { at: i * .07, dur: .5, gain: .08 })); },
};

/* ================================================================
   Three.js: a hand-built toon garden
   ================================================================ */
const canvas = $('#stage');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch {
  document.body.classList.remove('loading');
  $('#start-button').disabled = true;
  toast('이 브라우저는 3D(WebGL)를 지원하지 않아요. 다른 브라우저로 열어 주세요.');
  throw Error('WebGL unavailable');
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const HORIZON = new THREE.Color(0xe4f5ff);
scene.fog = new THREE.Fog(HORIZON, 45, 150);
const camera = new THREE.PerspectiveCamera(38, 1, .1, 400);

scene.add(new THREE.HemisphereLight(0xe2f4ff, 0x86c25e, 1.5));
const sun = new THREE.DirectionalLight(0xfff3dd, 2.4);
sun.position.set(-7, 16, 9); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -.0004; sun.shadow.normalBias = .03;
Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 50 });
scene.add(sun);

const gradientMap = new THREE.DataTexture(new Uint8Array([110, 185, 255]), 3, 1, THREE.RedFormat);
gradientMap.minFilter = gradientMap.magFilter = THREE.NearestFilter; gradientMap.needsUpdate = true;
const toonCache = new Map();
function toon(color, extra = {}) {
  const key = color + JSON.stringify(extra);
  if (!toonCache.has(key)) toonCache.set(key, new THREE.MeshToonMaterial({ color, gradientMap, ...extra }));
  return toonCache.get(key);
}
const outlineMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, uniforms: { uWidth: { value: .035 } },
  vertexShader: `uniform float uWidth; void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position + normal * uWidth, 1.); }`,
  fragmentShader: `void main(){ gl_FragColor = vec4(.23, .165, .133, 1.); }`,
});
function mesh(geo, mat, { x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, cast = true, outline = false } = {}) {
  const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.scale.set(sx, sy, sz); m.castShadow = cast; m.receiveShadow = true;
  if (outline) { const o = new THREE.Mesh(geo, outlineMat); o.castShadow = false; m.add(o); }
  return m;
}
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}

/* ---------- sky ---------- */
scene.add(new THREE.Mesh(new THREE.SphereGeometry(200, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { top: { value: new THREE.Color(0x63b9ee) }, horizon: { value: HORIZON }, sunDir: { value: new THREE.Vector3(-.45, .5, -.75).normalize() } },
  vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
  fragmentShader: `uniform vec3 top, horizon, sunDir; varying vec3 vDir;
    void main(){
      float h = clamp(vDir.y, 0., 1.);
      vec3 col = mix(horizon, top, pow(h, .55));
      float s = max(dot(vDir, sunDir), 0.);
      col += vec3(1., .96, .85) * (pow(s, 600.) * 1.5 + pow(s, 12.) * .25);
      gl_FragColor = vec4(col, 1.);
      #include <colorspace_fragment>
    }`,
})));

/* ---------- ground, hills and the garden around the board ---------- */
const ground = mesh(new THREE.CircleGeometry(160, 64).rotateX(-Math.PI / 2), toon(0x9bd673), { y: -.4, cast: false });
scene.add(ground);
[[-38, -70, 30, 0x86c962], [10, -82, 42, 0x7dbf5b], [52, -66, 28, 0x92cf6a], [-70, -50, 26, 0x8fcb67], [80, -40, 24, 0x86c962]].forEach(([x, z, r, c]) =>
  scene.add(mesh(new THREE.SphereGeometry(r, 32, 16), toon(c), { x, y: -r * .72, z, sy: .55, cast: false })));

function tree(x, z, s = 1) {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(.22, .3, 1.6, 10), toon(0x9a6a45), { y: .8, outline: true }));
  const leaf = toon([0x6fbf55, 0x7cc95d, 0x5fb24c][Math.floor(Math.random() * 3)]);
  [[0, 2.3, 0, 1.15], [-.7, 1.9, .2, .8], [.7, 1.95, -.1, .85], [.1, 2.9, -.1, .75]].forEach(([px, py, pz, r]) => g.add(mesh(new THREE.SphereGeometry(r, 20, 14), leaf, { x: px, y: py, z: pz, outline: true })));
  g.position.set(x, -.4, z); g.scale.setScalar(s); g.rotation.y = rand(0, 6); scene.add(g); return g;
}
[[-11, -9, 1.5], [-15, -3, 1.2], [12, -10, 1.6], [16, -4, 1.1], [-6, -15, 1.3], [7, -17, 1.4], [-20, -14, 1.7], [22, -15, 1.5], [0, -22, 1.8], [-25, 2, 1.2], [26, 1, 1.3]].forEach(a => tree(...a));

function mushroom(x, z, s = 1) {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(.13, .17, .4, 10), toon(0xfff3e0), { y: .2, outline: true }));
  g.add(mesh(new THREE.SphereGeometry(.34, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), toon(0xff6f6f), { y: .36, outline: true }));
  [[.15, .55, .17], [-.17, .52, .12], [0, .66, -.05], [.05, .5, -.25]].forEach(([px, py, pz]) => g.add(mesh(new THREE.SphereGeometry(.055, 8, 6), toon(0xffffff), { x: px, y: py, z: pz, cast: false })));
  g.position.set(x, -.4, z); g.scale.setScalar(s); scene.add(g);
}
[[-7.5, 2.5, 1.1], [-8.4, 3.4, .8], [8, 3.2, 1], [6.8, -5.8, .9], [-6.2, -6.5, 1.2]].forEach(a => mushroom(...a));

// Flowers: one instanced mesh for stems, one for blossoms.
{
  const N = 140, stems = new THREE.InstancedMesh(new THREE.CylinderGeometry(.025, .025, .5, 5), toon(0x4f9c3a), N);
  const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(.13, 10, 8), toon(0xffffff), N);
  const colors = [0xffffff, 0xffffff, 0xfff1a8, 0xffb3c7, 0xc8b6ff], m = new THREE.Matrix4();
  for (let i = 0; i < N; i++) {
    let x, z; do { x = rand(-24, 24); z = rand(-20, 12); } while (Math.abs(x) < 7.5 && Math.abs(z) < 6.5);
    m.makeTranslation(x, -.15, z); stems.setMatrixAt(i, m);
    m.makeScale(1, .7, 1).setPosition(x, .12, z); heads.setMatrixAt(i, m); heads.setColorAt(i, new THREE.Color(colors[i % colors.length]));
  }
  stems.castShadow = heads.castShadow = true; scene.add(stems, heads);
}

// Grass tufts scattered over the ground.
{
  const N = 150, blades = new THREE.InstancedMesh(new THREE.ConeGeometry(.06, .42, 4), toon(0x8ccf66), N * 3), m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  for (let i = 0; i < N; i++) {
    let x, z; do { x = rand(-22, 22); z = rand(-18, 12); } while (Math.abs(x) < 7 && Math.abs(z) < 5.8);
    for (let j = 0; j < 3; j++) {
      e.set(rand(-.35, .35), 0, (j - 1) * .45 + rand(-.1, .1)); const sc = rand(.6, 1.2);
      m.compose(new THREE.Vector3(x + (j - 1) * .07, -.4 + .22 * sc, z), q.setFromEuler(e), new THREE.Vector3(sc, sc, sc)); blades.setMatrixAt(i * 3 + j, m);
    }
  }
  blades.castShadow = true; scene.add(blades);
}

// Puffy clouds drifting across the sky.
const clouds = [];
for (let i = 0; i < 7; i++) {
  const g = new THREE.Group(), mat = toon(0xffffff, { fog: false });
  for (let j = 0; j < 5; j++) g.add(mesh(new THREE.SphereGeometry(rand(2, 3.4), 18, 12), mat, { x: (j - 2) * 2.4 + rand(-.5, .5), y: rand(-.4, .8), z: rand(-1, 1), sy: .7, cast: false }));
  g.position.set(rand(-90, 90), rand(22, 34), rand(-110, -70)); g.userData.speed = rand(.6, 1.4); scene.add(g); clouds.push(g);
}

// Butterflies.
const wingTex = canvasTex(64, 64, g => { g.fillStyle = '#ffb3c7'; g.beginPath(); g.ellipse(30, 22, 26, 18, -.3, 0, Math.PI * 2); g.fill(); g.fillStyle = '#ffd9e3'; g.beginPath(); g.ellipse(26, 46, 16, 14, .3, 0, Math.PI * 2); g.fill(); });
const butterflies = Array.from({ length: 3 }, (_, i) => {
  const g = new THREE.Group(), mat = new THREE.MeshBasicMaterial({ map: wingTex, transparent: true, side: THREE.DoubleSide, alphaTest: .3 });
  const wing = () => { const p = new THREE.Group(), m = new THREE.Mesh(new THREE.PlaneGeometry(.5, .5), mat); m.position.x = .25; p.add(m); return p; };
  const l = wing(), r = wing(); r.scale.x = -1; g.add(l, r); g.userData = { l, r, seed: i * 2.1, r0: rand(5, 9) }; scene.add(g); return g;
});

/* ---------- board: lawn platform + holes, rebuilt per difficulty ---------- */
const holeTex = canvasTex(128, 128, g => { const gr = g.createRadialGradient(64, 64, 4, 64, 64, 64); gr.addColorStop(0, '#120b07'); gr.addColorStop(.75, '#2e1d13'); gr.addColorStop(1, '#4a3021'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); });
const board = new THREE.Group(); scene.add(board);
let holes = [], boardSize = { w: 6, d: 4 };
const SPACING_X = 2.05, SPACING_Z = 1.95, HIDE_Y = -2.1, HOLE_Y = -.4;

function buildBoard(level) {
  board.clear(); holes.forEach(h => scene.remove(h.root)); holes = [];
  const { holes: count, cols } = RULES[level], rows = count / cols;
  boardSize = { w: (cols - 1) * SPACING_X, d: (rows - 1) * SPACING_Z };
  board.position.y = HOLE_Y;
  for (let i = 0; i < count; i++) {
    const c = i % cols, r = Math.floor(i / cols), x = (c - (cols - 1) / 2) * SPACING_X, z = (r - (rows - 1) / 2) * SPACING_Z;
    board.add(mesh(new THREE.CircleGeometry(.6, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: holeTex }), { x, y: .006, z, cast: false }));
    board.add(mesh(new THREE.TorusGeometry(.64, .13, 10, 40).rotateX(Math.PI / 2), toon(0x9b6845), { x, y: .02, z, sy: .5, cast: false }));
    // a few dirt clods kicked up around each hole
    for (let k = 0; k < 4; k++) { const a = rand(0, Math.PI * 2), d = rand(.82, 1.05); board.add(mesh(sph, toon(0x9b6845), { x: x + Math.cos(a) * d, y: .02, z: z + Math.sin(a) * d * .9, sx: rand(.06, .11), sy: .05, sz: rand(.06, .1), cast: false })); }
    holes.push(new Hole(i, x, z));
  }
}

/* ---------- critters ---------- */
const BODY = { mole: 0xa8714c, gold: 0xffcd3c, bunny: 0xffffff }, BELLY = { mole: 0xf0cfa8, gold: 0xfff2b8, bunny: 0xffe8ee };
const sph = new THREE.SphereGeometry(1, 20, 14);
function critter(kind) {
  const g = new THREE.Group(), body = toon(BODY[kind], kind === 'gold' ? { emissive: 0x6b4a00, emissiveIntensity: .35 } : {});
  g.add(mesh(new THREE.CapsuleGeometry(.42, .55, 8, 20), body, { y: .55, outline: true }));
  g.add(mesh(sph, toon(BELLY[kind]), { y: .42, z: .25, sx: .3, sy: .36, sz: .2, cast: false }));
  const eyes = [-1, 1].map(s => {
    const e = mesh(sph, toon(0x231a16), { x: .15 * s, y: .84, z: .36, sx: .062, sy: .075, sz: .05, cast: false });
    e.add(mesh(sph, new THREE.MeshBasicMaterial({ color: 0xffffff }), { x: .35, y: .4, z: .8, sx: .38, sy: .32, sz: .3, cast: false }));
    g.add(e); return e;
  });
  [-1, 1].forEach(s => g.add(mesh(sph, toon(0xff9fb2), { x: .27 * s, y: .7, z: .31, sx: .075, sy: .045, sz: .04, cast: false })));
  if (kind === 'bunny') {
    g.add(mesh(sph, toon(0xff8fa8), { y: .74, z: .41, sx: .045, sy: .035, sz: .035, cast: false }));
    [-1, 1].forEach(s => {
      const ear = mesh(new THREE.CapsuleGeometry(.09, .5, 6, 12), body, { x: .15 * s, y: 1.42, z: -.04, outline: true }); ear.rotation.z = -.16 * s;
      ear.add(mesh(new THREE.CapsuleGeometry(.045, .38, 6, 10), toon(0xffc2d1), { z: .06, cast: false })); g.add(ear);
    });
    g.add(mesh(sph, toon(0xffe27a), { x: .26, y: 1.08, z: .2, sx: .09, sy: .09, sz: .06 }));
  } else {
    g.add(mesh(sph, toon(0xff8fa3), { y: .73, z: .43, sx: .095, sy: .075, sz: .07, outline: true }));
    g.add(mesh(new THREE.BoxGeometry(.07, .07, .03), toon(0xffffff), { y: .63, z: .43, cast: false }));
  }
  if (kind === 'gold') {
    const crown = new THREE.Group(), cm = toon(0xffa51f, { emissive: 0x7a3d00, emissiveIntensity: .3 });
    crown.add(mesh(new THREE.CylinderGeometry(.2, .22, .1, 16), cm, { outline: true }));
    for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2; crown.add(mesh(new THREE.ConeGeometry(.05, .14, 8), cm, { x: Math.cos(a) * .18, y: .11, z: Math.sin(a) * .18 })); }
    crown.position.y = 1.18; crown.rotation.x = -.15; g.add(crown);
  }
  [-1, 1].forEach(s => g.add(mesh(sph, body, { x: .3 * s, y: .16, z: .34, sx: .13, sy: .1, sz: .12, outline: true })));
  return { g, eyes };
}
// Render each critter once into a small transparent image for the start screen's cast list.
function renderPortraits() {
  try {
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setSize(160, 160, false); r.setPixelRatio(1); r.outputColorSpace = THREE.SRGBColorSpace; r.setClearColor(0, 0);
    const s = new THREE.Scene(), cam = new THREE.PerspectiveCamera(30, 1, .1, 20);
    s.add(new THREE.HemisphereLight(0xe2f4ff, 0x86c25e, 1.6)); const d = new THREE.DirectionalLight(0xfff3dd, 2.4); d.position.set(-2, 4, 5); s.add(d);
    for (const kind of ['mole', 'gold', 'bunny']) {
      const c = critter(kind); c.g.rotation.y = .35; s.add(c.g);
      const tall = kind === 'bunny';
      cam.position.set(0, tall ? 1.05 : .95, tall ? 3.9 : 2.7); cam.lookAt(0, tall ? .95 : .78, 0);
      r.render(s, cam);
      const url = r.domElement.toDataURL('image/png');
      $$(`[data-critter="${kind}"]`).forEach(img => img.src = url);
      s.remove(c.g);
    }
    r.dispose(); r.forceContextLoss();
  } catch {}
}

const starGeo = (() => { const s = new THREE.Shape(); for (let i = 0; i < 10; i++) { const r = i % 2 ? .05 : .12, a = i / 10 * Math.PI * 2 - Math.PI / 2; i ? s.lineTo(Math.cos(a) * r, Math.sin(a) * r) : s.moveTo(Math.cos(a) * r, Math.sin(a) * r); } return new THREE.ShapeGeometry(s); })();
const starMat = new THREE.MeshBasicMaterial({ color: 0xffd84d, side: THREE.DoubleSide });

class Hole {
  constructor(index, x, z) {
    this.index = index; this.root = new THREE.Group(); this.root.position.set(x, HOLE_Y, z); scene.add(this.root);
    this.kinds = {};
    for (const k of ['mole', 'gold', 'bunny']) { const c = critter(k); c.g.visible = false; c.g.position.y = HIDE_Y; this.root.add(c.g); this.kinds[k] = c; }
    this.stars = new THREE.Group(); this.stars.visible = false; this.stars.position.y = 1.35;
    for (let i = 0; i < 3; i++) { const s = new THREE.Mesh(starGeo, starMat); s.position.set(Math.cos(i * 2.1) * .42, 0, Math.sin(i * 2.1) * .42); this.stars.add(s); }
    this.root.add(this.stars);
    this.hitbox = new THREE.Mesh(new THREE.CylinderGeometry(.78, .78, 1.7, 12), new THREE.MeshBasicMaterial({ visible: false }));
    this.hitbox.position.y = .7; this.hitbox.userData.hole = this; this.root.add(this.hitbox);
    this.pop = null; this.phase = 'empty'; this.t = 0; this.seed = Math.random();
  }
  show(pop, real = true) {
    if (this.current) this.current.g.visible = false;
    this.pop = pop; this.real = real; this.hit = false; this.phase = 'rise'; this.t = 0; this.stars.visible = false;
    this.current = this.kinds[pop.kind]; this.current.g.visible = true; this.current.g.position.y = HIDE_Y; this.current.g.scale.set(1, 1, 1);
    this.current.g.rotation.set(0, rand(-.25, .25), 0);
    puff(this.root.position, 6, 0x9b6845); play.pop();
  }
  hide() { if (this.phase === 'rise' || this.phase === 'up') { this.phase = 'sink'; this.t = 0; } }
  bonk() { this.hit = true; this.phase = 'bonk'; this.t = 0; this.stars.visible = this.pop.kind !== 'gold'; }
  get up() { return this.phase === 'rise' || this.phase === 'up'; }
  update(dt, time) {
    if (!this.current) return;
    const c = this.current, g = c.g; this.t += dt;
    if (this.phase === 'rise') { g.position.y = lerp(HIDE_Y, 0, easeOutBack(clamp(this.t / .16))); if (this.t >= .16) { this.phase = 'up'; this.t = 0; } }
    else if (this.phase === 'up') {
      g.position.y = Math.sin(time * 6 + this.seed * 9) * .03;
      g.rotation.z = Math.sin(time * 3 + this.seed * 5) * .06;
      const blink = (time + this.seed * 3) % 2.6 < .12 ? .15 : 1; c.eyes.forEach(e => e.scale.y = .075 * blink);
      if (this.pop.kind === 'gold' && Math.random() < dt * 14) sparkle(g.getWorldPosition(tmpV).add(new THREE.Vector3(rand(-.5, .5), rand(.3, 1.3), rand(-.3, .4))));
    } else if (this.phase === 'bonk') {
      const k = clamp(this.t / .1); g.scale.set(1 + .25 * k, 1 - .35 * k, 1 + .25 * k); c.eyes.forEach(e => e.scale.y = .02);
      this.stars.rotation.y += dt * 9;
      if (this.t > .38) { this.phase = 'sink'; this.t = 0; }
    } else if (this.phase === 'sink') {
      g.position.y = lerp(0, HIDE_Y, clamp(this.t / .18) ** 2); this.stars.rotation.y += dt * 9;
      if (this.t >= .18) { g.visible = false; g.scale.set(1, 1, 1); this.stars.visible = false; this.phase = 'empty'; this.pop = null; this.current = null; c.eyes.forEach(e => e.scale.y = .075); }
    }
  }
}

/* ---------- cheer squad: a bunny joins behind the holes every CHEER_STEP points ---------- */
const CHEER_STEP = 100, CHEER_MAX = 12, cheerers = [];
function cheerSlot(i) {
  // Fill from the middle outwards in a gentle arc behind the last row, then a second row.
  const row = Math.floor(i / 7), k = i % 7, side = k === 0 ? 0 : (k % 2 ? -1 : 1) * Math.ceil(k / 2);
  const x = side * 1.45 + (row ? .72 : 0), z = -boardSize.d / 2 - 1.7 - row * 1.25 + Math.abs(side) * .12;
  return new THREE.Vector3(x, HOLE_Y, z);
}
function addCheerer() {
  if (cheerers.length >= CHEER_MAX) return;
  const c = critter('bunny'), arms = [];
  [-1, 1].forEach((s, j) => {
    const arm = new THREE.Group(); arm.position.set(.4 * s, .62, .12);
    arm.add(mesh(sph, toon([0xff8fb0, 0xffd84d][(cheerers.length + j) % 2]), { x: .22 * s, y: .3, sx: .17, sy: .17, sz: .17, outline: true }));
    c.g.add(arm); arms.push({ arm, s });
  });
  c.g.position.copy(cheerSlot(cheerers.length)); c.g.rotation.y = -c.g.position.x * .08; c.g.scale.setScalar(.001);
  scene.add(c.g); cheerers.push({ ...c, arms, t: 0, seed: Math.random() * 6 });
  burst(c.g.position.clone().setY(HOLE_Y + 1), { count: 16, shape: 1, size: .15, speed: 3 }); play.cheer();
}
function clearCheerers() { cheerers.splice(0).forEach(c => scene.remove(c.g)); }
function updateCheerers(dt, time) {
  for (const c of cheerers) {
    c.t += dt;
    const hop = Math.abs(Math.sin(time * 5 + c.seed)) * .3;
    c.g.scale.setScalar(.72 * easeOutBack(clamp(c.t / .45)));
    c.g.position.y = HOLE_Y + hop; c.g.rotation.z = Math.sin(time * 5 + c.seed) * .08;
    c.arms.forEach(({ arm, s }) => arm.rotation.z = s * (.5 + Math.sin(time * 10 + c.seed + s) * .45));
    const blink = (time + c.seed) % 3 < .1 ? .15 : 1; c.eyes.forEach(e => e.scale.y = .075 * blink);
  }
}

/* ---------- effects: sparkles, dirt puffs, ripples ---------- */
const sparkMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, uniforms: { uScale: { value: 400 } },
  vertexShader: `attribute float aSize, aAlpha, aSpin, aShape; attribute vec3 aColor; uniform float uScale;
    varying float vAlpha, vSpin, vShape; varying vec3 vColor;
    void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.); gl_PointSize = aSize * uScale / -mv.z; gl_Position = projectionMatrix * mv;
      vAlpha = aAlpha; vColor = aColor; vSpin = aSpin; vShape = aShape; }`,
  fragmentShader: `varying float vAlpha, vSpin, vShape; varying vec3 vColor;
    void main(){
      vec2 p = gl_PointCoord - .5; float c = cos(vSpin), s = sin(vSpin); p = mat2(c, -s, s, c) * p;
      float d = length(p);
      float star = max(0., 1. - abs(p.x * p.y) * 90. - d * 2.);
      float dot_ = smoothstep(.5, .3, d);
      float shape = mix(pow(star, 1.4) + exp(-d * d * 70.) * .7, dot_, vShape);
      float a = clamp(shape, 0., 1.) * vAlpha; if (a < .01) discard;
      gl_FragColor = vec4(mix(vColor, vec3(1.), exp(-d * d * 140.) * (1. - vShape * .8)), a);
      #include <colorspace_fragment>
    }`,
});
class Sparks {
  constructor(n) {
    this.n = n; this.next = 0; this.p = Array.from({ length: n }, () => ({ life: 0 }));
    const g = new THREE.BufferGeometry(), attr = (name, size) => { const a = new THREE.BufferAttribute(new Float32Array(n * size), size); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(name, a); return a; };
    this.pos = attr('position', 3); this.col = attr('aColor', 3); this.size = attr('aSize', 1); this.alpha = attr('aAlpha', 1); this.spin = attr('aSpin', 1); this.shape = attr('aShape', 1);
    this.points = new THREE.Points(g, sparkMat); this.points.frustumCulled = false; scene.add(this.points);
  }
  emit(o) {
    let p; do { p = this.p[this.next]; this.next = (this.next + 1) % this.n; } while (p.ambient && !o.ambient);
    Object.assign(p, { gravity: 0, drag: 1.8, spinV: rand(-4, 4), spin: rand(0, 6), shape: 0, alphaScale: 1 }, o);
    p.max = p.life; p.color = new THREE.Color(o.color);
  }
  update(dt) {
    for (let i = 0; i < this.n; i++) {
      const p = this.p[i];
      if (p.life <= 0) { this.alpha.array[i] = 0; continue; }
      if (p.ambient) { p.vel.set(Math.sin(p.life * .3 + i) * .15, .12, Math.cos(p.life * .27 + i) * .1); if (p.pos.y > 5) p.pos.y = -.2; }
      p.life -= dt; p.vel.y -= p.gravity * dt; p.vel.multiplyScalar(Math.exp(-p.drag * dt)); p.pos.addScaledVector(p.vel, dt); p.spin += p.spinV * dt;
      const k = clamp(p.life / p.max);
      this.pos.setXYZ(i, p.pos.x, p.pos.y, p.pos.z); this.col.setXYZ(i, p.color.r, p.color.g, p.color.b);
      this.size.array[i] = p.size * (p.shape ? .5 + .5 * k : Math.sin(Math.min(1, (1 - k) * 4) * Math.PI / 2) * (.4 + .6 * k));
      this.alpha.array[i] = Math.min(1, k * 2.2) * p.alphaScale; this.spin.array[i] = p.spin; this.shape.array[i] = p.shape;
    }
    for (const a of [this.pos, this.col, this.size, this.alpha, this.spin, this.shape]) a.needsUpdate = true;
  }
}
const sparks = new Sparks(800);
// Pollen drifting over the garden.
for (let i = 0; i < (reducedMotion ? 15 : 45); i++) sparks.emit({ pos: new THREE.Vector3(rand(-11, 11), rand(0, 5), rand(-8, 6)), vel: new THREE.Vector3(), drag: 0, spinV: 0, life: 1e9, size: rand(.06, .14), color: [0xffffff, 0xfff4c2][i % 2], shape: 1, alphaScale: .65, ambient: true });
const CONFETTI = [0xffffff, 0xffd84d, 0x9fe0b5, 0x9fd3f7, 0xffa8c0];
const tmpV = new THREE.Vector3();
function burst(pos, { count = 24, speed = 4.5, colors = CONFETTI, size = .3, life = .9, gravity = 4, shape = 0 } = {}) {
  for (let i = 0; i < count; i++) {
    const a = rand(0, Math.PI * 2), e = rand(-.4, .9), v = speed * rand(.45, 1);
    sparks.emit({ pos: pos.clone(), vel: new THREE.Vector3(Math.cos(a) * Math.cos(e) * v, Math.sin(e) * v + 2, Math.sin(a) * Math.cos(e) * v), life: life * rand(.7, 1.2), size: size * rand(.6, 1.3), color: colors[i % colors.length], gravity, shape });
  }
}
function puff(pos, count = 10, color = 0xffffff) {
  for (let i = 0; i < count; i++) { const a = rand(0, Math.PI * 2); sparks.emit({ pos: pos.clone().add(new THREE.Vector3(Math.cos(a) * .6, .1, Math.sin(a) * .6)), vel: new THREE.Vector3(Math.cos(a) * rand(.8, 1.8), rand(.6, 1.6), Math.sin(a) * rand(.8, 1.8)), life: rand(.35, .6), size: rand(.14, .26), color, shape: 1, drag: 3, gravity: 3 }); }
}
function sparkle(pos) { sparks.emit({ pos: pos.clone(), vel: new THREE.Vector3(0, rand(.3, .8), 0), life: rand(.4, .7), size: rand(.15, .3), color: 0xfff3b0, drag: 1 }); }

const ringGeo = new THREE.RingGeometry(.9, 1, 64).rotateX(-Math.PI / 2);
const rings = Array.from({ length: 12 }, () => {
  const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false })); m.visible = false; scene.add(m); return { m, life: 0 };
});
let ringNext = 0;
function ripple(pos, { size = 1.4, color = 0xffffff, life = .5 } = {}) {
  const r = rings[ringNext]; ringNext = (ringNext + 1) % rings.length;
  Object.assign(r, { life, max: life, size }); r.m.position.copy(pos).setY(HOLE_Y + .03); r.m.material.color.set(color); r.m.visible = true;
}
function updateRings(dt) {
  for (const r of rings) {
    if (r.life <= 0) { r.m.visible = false; continue; }
    r.life -= dt; const k = 1 - clamp(r.life / r.max);
    r.m.scale.setScalar(.2 + r.size * (1 - (1 - k) ** 3)); r.m.material.opacity = (1 - k) * .9;
  }
}

/* ---------- camera framing ---------- */
const view = { target: new THREE.Vector3(), pos: new THREE.Vector3(), curTarget: new THREE.Vector3(0, 0, 0), curPos: new THREE.Vector3(0, 14, 20) };
const frameEl = $('#frame');
function frameBoard() {
  const aspect = frameEl.clientWidth / Math.max(1, frameEl.clientHeight), vfov = THREE.MathUtils.degToRad(camera.fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  const playing = document.body.classList.contains('playing'), pitch = THREE.MathUtils.degToRad(playing ? 44 : 30);
  const halfW = boardSize.w / 2 + 1.7, halfD = boardSize.d / 2 + 1.5;
  let dist = Math.max(halfW / Math.tan(hfov / 2) + halfD * Math.cos(pitch), (halfD * Math.sin(pitch) + 1.1) / Math.tan(vfov / 2) * 1.05 + halfD * Math.cos(pitch));
  // Idle: pull back a little so the garden and the start bar both fit.
  if (!playing) dist *= 1.18;
  view.target.set(0, playing ? -.05 : .2, playing ? -.2 : .2);
  view.pos.set(view.target.x, view.target.y + Math.sin(pitch) * dist, view.target.z + Math.cos(pitch) * dist);
}
function resize() {
  const w = frameEl.clientWidth, h = frameEl.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  // Side panels match the game window's height on wide layouts.
  document.documentElement.style.setProperty('--frame-h', h + 'px');
  sparkMat.uniforms.uScale.value = h * renderer.getPixelRatio() / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  frameBoard();
}
new ResizeObserver(resize).observe(frameEl);

/* ---------- pointer: hammer cursor + raycast whacks ---------- */
const pointer = new THREE.Vector2(), smooth = new THREE.Vector2(), raycaster = new THREE.Raycaster();
const hammer = $('#hammer');
let shake = 0;
function trackPointer(e) {
  const r = canvas.getBoundingClientRect();
  pointer.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height * 2 - 1));
  hammer.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0)`;
}
canvas.addEventListener('pointermove', trackPointer);
canvas.addEventListener('pointerenter', () => hammer.classList.add('inside'));
canvas.addEventListener('pointerleave', () => { hammer.classList.remove('inside'); pointer.set(0, 0); });
canvas.addEventListener('pointerdown', e => {
  trackPointer(e); hammer.classList.add('inside');
  if (state !== 'playing') return;
  e.preventDefault();
  hammer.classList.add('whack'); setTimeout(() => hammer.classList.remove('whack'), 110);
  whack();
});

/* ================================================================
   Game
   ================================================================ */
function busy() { return ['starting', 'playing', 'pausing', 'paused', 'resuming', 'finishing', 'finish-error'].includes(state); }
function elapsed() { return game ? Math.min(game.duration, (game.pauseAt ?? now()) / 1000 - game.started - game.paused) : 0; }
function show(id, on = true) { $(id).hidden = !on; }
function setPlaying(on) {
  document.body.classList.toggle('playing', on); frameBoard();
  if (on && innerWidth <= 1180) frameEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function toScreen(v) { const p = v.clone().project(camera); return { x: (p.x + 1) / 2 * frameEl.clientWidth, y: (1 - p.y) / 2 * frameEl.clientHeight }; }
function popText(text, v, cls = '') { const s = toScreen(v), n = node('div', 'pop ' + cls, text); n.style.left = s.x + 'px'; n.style.top = s.y + 'px'; $('.frame-ui').append(n); setTimeout(() => n.remove(), 950); }
function renderHud() {
  if (!game) return;
  $('#score').textContent = format(Math.max(0, game.score)); $('#hud-combo').textContent = game.combo;
}
function renderClock(t) {
  const remain = Math.max(0, Math.ceil(game.duration - t)), c = $('#clock');
  c.textContent = remain; c.style.setProperty('--p', (100 * (1 - t / game.duration)).toFixed(1) + '%'); c.classList.toggle('hurry', remain <= 10);
}

function whack() {
  game.clicks++;
  const t = elapsed();
  raycaster.setFromCamera(pointer, camera);
  const targets = holes.filter(h => h.real && h.pop && !h.hit && h.up && t >= h.pop.at && t <= h.pop.at + h.pop.stay).map(h => h.hitbox);
  const hit = raycaster.intersectObjects(targets, false)[0];
  if (!hit) {
    const p = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -HOLE_Y), new THREE.Vector3());
    if (p) { puff(p, 8, 0xc8a27f); ripple(p, { size: .7, life: .35 }); }
    play.whiff(); return;
  }
  const h = hit.object.userData.hole, pop = h.pop, f = game.rule.factor, head = h.root.position.clone().setY(HOLE_Y + 1.2);
  game.hits.push({ id: pop.id, at: Number(t.toFixed(3)) });
  h.bonk(); shake = .12;
  if (pop.kind === 'bunny') {
    game.combo = 0; const pts = Math.round(POINTS.bunny * f); game.score += pts; game.bunnies++;
    popText(String(pts), head, 'bad'); play.bunny(); burst(head, { count: 10, colors: [0xffffff, 0xffc2d1], speed: 3 });
    $('#flash').classList.add('on'); requestAnimationFrame(() => requestAnimationFrame(() => $('#flash').classList.remove('on')));
  } else {
    game.combo++; game.best = Math.max(game.best, game.combo); game.caught++;
    const pts = Math.round(POINTS[pop.kind] * f) + Math.min(game.combo, 20) * 2; game.score += pts;
    while (cheerers.length < Math.min(CHEER_MAX, Math.floor(game.score / CHEER_STEP))) addCheerer();
    if (pop.kind === 'gold') { popText('+' + pts, head, 'gold'); play.gold(); burst(head, { count: 46, colors: [0xffd84d, 0xfff3b0, 0xffffff], speed: 6, size: .36 }); }
    else { popText('+' + pts, head); play.bonk(game.combo); burst(head, { count: 18 + Math.min(game.combo, 10) * 2, speed: 4 }); }
    ripple(h.root.position, { size: 1.5 });
    if (game.combo >= 3) { const c = $('#combo'); c.replaceChildren(node('b', '', game.combo), document.createTextNode('COMBO')); c.classList.remove('show'); void c.offsetWidth; c.classList.add('show'); }
    if (game.combo % 10 === 0) play.fanfare();
  }
  renderHud();
}

function updateGame(t) {
  const deck = game.deck;
  while (game.next < deck.length && deck[game.next].at <= t && deck[game.next].at < game.duration) { const pop = deck[game.next++]; holes[pop.hole].show(pop); }
  for (const h of holes) {
    if (!h.real || !h.pop || h.hit || !h.up) continue;
    if (t >= h.pop.at + h.pop.stay) {
      if (h.pop.kind !== 'bunny') { game.combo = 0; game.escaped++; renderHud(); }
      h.hide();
    }
  }
  if (t >= game.duration) finishGame();
}

let idleTimer = 1;
function updateIdle(dt) {
  if (busy() || document.hidden || (idleTimer -= dt) > 0) return;
  idleTimer = rand(.5, 1.1);
  const free = holes.filter(h => h.phase === 'empty');
  if (!free.length) return;
  const h = free[Math.floor(Math.random() * free.length)], r = Math.random();
  h.show({ kind: r < .1 ? 'gold' : r < .22 ? 'bunny' : 'mole' }, false);
  setTimeout(() => { if (!h.real) h.hide(); }, rand(900, 1600));
}

async function startGame() {
  if (busy()) return;
  state = 'starting'; play.ui();
  show('#start-screen', false); show('#result-screen', false);
  try {
    const config = await api('/api/start', { difficulty });
    holes.forEach(h => h.hide()); clearCheerers();
    game = { ...config, started: 0, paused: 0, pauseAt: null, hits: [], clicks: 0, score: 0, combo: 0, best: 0, caught: 0, bunnies: 0, escaped: 0, next: 0 };
    setPlaying(true); show('#hud'); renderHud(); renderClock(0); show('#pause-button');
    show('#countdown');
    for (const text of ['3', '2', '1', 'GO']) {
      const c = $('#count'); c.textContent = text; c.classList.toggle('go', text === 'GO'); c.style.animation = 'none'; void c.offsetWidth; c.style.animation = '';
      play.beep(text === 'GO'); await new Promise(r => setTimeout(r, text === 'GO' ? 450 : 700));
    }
    show('#countdown', false);
    game.started = now() / 1000; state = 'playing';
    if (document.hidden) pauseGame();
  } catch (e) {
    state = 'idle'; setPlaying(false); show('#countdown', false); show('#hud', false); show('#pause-button', false); show('#start-screen'); toast(e.message);
  }
}
async function pauseGame() {
  if (state !== 'playing') return;
  game.pauseAt = now(); state = 'pausing'; document.body.classList.add('paused');
  try {
    await api('/api/pause', { session: game.session });
    state = 'paused'; $('#pause-title').textContent = '잠시 멈춤'; $('#pause-text').textContent = '준비되면 이어서 해요.'; $('#resume-button').textContent = '이어서 하기'; show('#quit-button'); show('#pause-screen');
  } catch (e) { game.pauseAt = null; state = 'playing'; document.body.classList.remove('paused'); toast(e.message); }
}
async function resumeGame() {
  if (state === 'finish-error') { finishGame(); return; }
  if (state !== 'paused') return;
  state = 'resuming'; $('#resume-button').disabled = true;
  try {
    await api('/api/resume', { session: game.session });
    game.paused += (now() - game.pauseAt) / 1000; game.pauseAt = null; state = 'playing';
    show('#pause-screen', false); document.body.classList.remove('paused');
  } catch (e) { state = 'paused'; toast(e.message); } finally { $('#resume-button').disabled = false; }
}
async function finishGame() {
  if (!['playing', 'paused', 'finish-error'].includes(state)) return;
  const duration = state === 'finish-error' ? game.finishElapsed : Math.max(.1, elapsed());
  game.finishElapsed = duration; game.pauseAt ??= now(); state = 'finishing'; show('#pause-screen', false);
  try {
    const result = await api('/api/finish', { session: game.session, elapsed: duration, hits: game.hits, clicks: game.clicks });
    state = 'finished'; lastResult = result; loadStats();
    holes.forEach(h => { h.real = false; h.hide(); });
    show('#hud', false); show('#pause-button', false); document.body.classList.remove('paused'); setPlaying(false);
    showResult(result);
  } catch (e) {
    state = 'finish-error'; $('#pause-title').textContent = '기록을 저장하지 못했어요'; $('#pause-text').textContent = e.message; $('#resume-button').textContent = '다시 시도'; show('#quit-button', false); show('#pause-screen'); toast(e.message);
  }
}

/* ---------- result + one-step ranking / guestbook registration ---------- */
function registerNote(msg, err = false) { const n = $('#register-note'); n.textContent = msg; n.classList.toggle('err', err); }
function countUp(el, value, ms = 900) {
  const t0 = now(), step = () => { const k = clamp((now() - t0) / ms), e = 1 - (1 - k) ** 3; el.textContent = format(Math.round(value * e)); if (k < 1) requestAnimationFrame(step); };
  step();
}
function showResult(r) {
  countUp($('#result-score'), r.score); $('#result-hits').textContent = r.hits; $('#result-accuracy').textContent = r.accuracy + '%';
  $('#result-reaction').textContent = r.reaction ? format(r.reaction) : '—'; $('#result-combo').textContent = r.combo;
  $('#result-kicker').textContent = (r.elapsed >= game.duration - .5 ? 'TIME UP' : 'RESULT') + ' · ' + levels[difficulty] + (r.bunnies ? ` · 토끼 ${r.bunnies}번 콩` : '');
  $('#reg-name').disabled = false; $('#register-button').disabled = false; $('#register-form').hidden = !r.hits;
  $('#reg-name').value = storage.get('nickname', '');
  registerNote(cheerers.length ? `응원단 토끼 ${cheerers.length}마리가 함께했어요!` : '');
  if (!r.hits) registerNote('');
  show('#result-screen');
  if (r.hits) { play.fanfare(); holes.slice(0, 4).forEach((h, i) => setTimeout(() => burst(h.root.position.clone().setY(HOLE_Y + 1), { count: 24, shape: 1, size: .16 }), i * 150)); }
  if (r.hits) setTimeout(() => $('#reg-name').focus({ preventScroll: true }), 400);
}
$('#register-form').addEventListener('submit', async e => {
  e.preventDefault();
  const nickname = $('#reg-name').value.trim(), button = $('#register-button');
  if (!nickname) { registerNote('닉네임을 입력해 주세요.', true); return; }
  button.disabled = true; registerNote('등록하고 있어요…');
  try {
    await api('/api/register', { session: game.session, nickname });
    storage.set('nickname', nickname); $('#guest-name').value ||= nickname;
    registerNote('랭킹에 등록했어요. 왼쪽 명예의 전당을 확인해 보세요!');
    $('#reg-name').disabled = true;
    boardDifficulty = difficulty; renderBoardChips();
    loadBoard({ nickname, score: lastResult.score });
  } catch (err) { registerNote(err.message, true); button.disabled = false; }
});

/* ---------- ranking podium + guestbook notes ---------- */
function renderBoardChips() { $$('[data-board-difficulty]').forEach(b => b.classList.toggle('on', b.dataset.boardDifficulty === boardDifficulty)); }
const dateFmt = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric' });
const isMe = (r, me) => me && r.nickname === me.nickname && r.score === me.score;
let boardRequest = 0;
async function loadBoard(highlight) {
  const podium = $('#podium'), list = $('#board'), id = ++boardRequest;
  try {
    const data = await api('/api/leaderboard?' + new URLSearchParams({ difficulty: boardDifficulty }));
    if (id !== boardRequest) return;
    const crowns = ['👑', '', ''];
    podium.replaceChildren(...[0, 1, 2].map(i => {
      const r = data.items[i], place = node('div', `place p${i + 1}${r ? '' : ' empty'}${r && isMe(r, highlight) ? ' me' : ''}`);
      place.append(node('span', 'crown', crowns[i]), node('span', 'name', r ? r.nickname : '비어 있음'), node('span', 'pts', r ? format(r.score) : '—'), node('span', 'block', i + 1));
      if (r) place.title = `정확도 ${r.accuracy}% · 반응 ${r.reaction ? format(r.reaction) + 'ms' : '—'} · 최대 콤보 ${r.combo}`;
      return place;
    }));
    const rest = data.items.slice(3, 20);
    list.replaceChildren(...rest.map(r => {
      const li = node('li', isMe(r, highlight) ? 'me' : ''), who = node('div', 'who');
      who.append(node('b', '', r.nickname), node('small', '', `${r.accuracy}% · ${r.reaction ? format(r.reaction) + 'ms' : '—'}`));
      li.append(who, node('span', 'pts', format(r.score))); return li;
    }));
    if (!data.items.length) list.replaceChildren(node('li', 'empty', '첫 번째 주인공이 되어 보세요!'));
  } catch (e) { if (id === boardRequest) list.replaceChildren(node('li', 'empty', e.message)); }
}
// A tiny mole / bunny / golden-mole face for each note, picked from the nickname.
const CRITTERS = [
  '<svg viewBox="0 0 24 24" class="critter"><circle cx="12" cy="13" r="10" fill="#a8714c" stroke="#3a2a22" stroke-width="1.4"/><circle cx="8.5" cy="12" r="1.3" fill="#231a16"/><circle cx="15.5" cy="12" r="1.3" fill="#231a16"/><ellipse cx="12" cy="15" rx="2" ry="1.5" fill="#ff8fa3"/><ellipse cx="6.5" cy="15.5" rx="1.6" ry="1" fill="#ff9fb2"/><ellipse cx="17.5" cy="15.5" rx="1.6" ry="1" fill="#ff9fb2"/></svg>',
  '<svg viewBox="0 0 24 24" class="critter"><path d="M8 7C7 1 9 0 10 6M16 7c1-6-1-7-2-1" fill="#fff" stroke="#3a2a22" stroke-width="1.3"/><circle cx="12" cy="14" r="9" fill="#fff" stroke="#3a2a22" stroke-width="1.4"/><circle cx="9" cy="13.5" r="1.2" fill="#231a16"/><circle cx="15" cy="13.5" r="1.2" fill="#231a16"/><ellipse cx="12" cy="16" rx="1.1" ry=".8" fill="#ff8fa8"/><ellipse cx="6.8" cy="16.5" rx="1.5" ry=".9" fill="#ffc2d1"/><ellipse cx="17.2" cy="16.5" rx="1.5" ry=".9" fill="#ffc2d1"/></svg>',
  '<svg viewBox="0 0 24 24" class="critter"><path d="M7 6l2 2 3-3 3 3 2-2v3H7z" fill="#ffa51f" stroke="#3a2a22" stroke-width="1"/><circle cx="12" cy="14.5" r="9" fill="#ffcd3c" stroke="#3a2a22" stroke-width="1.4"/><circle cx="8.8" cy="14" r="1.2" fill="#231a16"/><circle cx="15.2" cy="14" r="1.2" fill="#231a16"/><ellipse cx="12" cy="16.6" rx="1.8" ry="1.3" fill="#ff8fa3"/></svg>',
];
function critterIcon(seed) { const t = document.createElement('template'); t.innerHTML = CRITTERS[seed % CRITTERS.length]; return t.content.firstChild; }
function hash(text) { let h = 0; for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0; return h; }
async function loadGuestbook(fresh) {
  const list = $('#guestbook');
  try {
    const data = await api('/api/guestbook');
    list.replaceChildren(...data.items.map((r, i) => {
      const h = hash(r.nickname + r.created), li = node('li', `note-card c${h % 5}${i === 0 && fresh === r.nickname ? ' fresh' : ''}`), foot = node('footer'), time = node('time', '', dateFmt.format(new Date(r.created)));
      li.style.setProperty('--tilt', `${((h >>> 3) % 5) - 2}deg`); li.style.setProperty('--tape', `${((h >>> 6) % 9) - 4}deg`); li.style.animationDelay = Math.min(i, 8) * 40 + 'ms';
      foot.append(critterIcon(h >>> 9), node('b', '', r.nickname), time);
      li.append(node('p', '', r.message), foot); return li;
    }));
    $('#note-count').textContent = data.items.length ? `쪽지 ${data.items.length}장` : '';
    if (!data.items.length) list.replaceChildren(node('li', 'empty', '첫 번째 쪽지를 남겨 주세요 ✿'));
    else if (fresh) list.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) { list.replaceChildren(node('li', 'empty', e.message)); }
}
function guestNote(msg, err = false) { const n = $('#guest-note'); n.textContent = msg; n.classList.toggle('err', err); }
$('#guest-message').addEventListener('input', e => $('#guest-count').textContent = `${e.target.value.length}/140`);
$('#guest-form').addEventListener('submit', async e => {
  e.preventDefault();
  const nickname = $('#guest-name').value.trim(), message = $('#guest-message').value.trim(), button = $('#guest-button');
  if (!nickname || !message) { guestNote('닉네임과 내용을 모두 적어 주세요.', true); return; }
  button.disabled = true; guestNote('');
  try {
    await api('/api/guestbook', { nickname, message });
    storage.set('nickname', nickname); $('#guest-message').value = ''; $('#guest-count').textContent = '0/140';
    play.cheer(); loadGuestbook(nickname);
  } catch (err) { guestNote(err.message, true); } finally { button.disabled = false; }
});
$('#guest-name').value = storage.get('nickname', '');

/* ---------- main loop ---------- */
const clock = new THREE.Clock();
let time = 0;
function frame() {
  const dt = Math.min(clock.getDelta(), .05); time += dt;
  smooth.lerp(pointer, 1 - Math.exp(-dt * 2));
  const k = 1 - Math.exp(-dt * 2.2), sway = reducedMotion || document.body.classList.contains('playing') ? 0 : 1;
  view.curTarget.lerp(view.target, k); view.curPos.lerp(view.pos, k);
  shake = Math.max(0, shake - dt * .8);
  camera.position.copy(view.curPos).add(tmpV.set(smooth.x * 1.2 * sway + (Math.random() - .5) * shake, smooth.y * .6 * sway + (Math.random() - .5) * shake, 0));
  camera.lookAt(view.curTarget);
  if (state === 'playing') { const t = elapsed(); updateGame(t); if (state === 'playing') renderClock(t); }
  updateIdle(dt);
  for (const h of holes) h.update(dt, time);
  updateCheerers(dt, time);
  for (const c of clouds) { c.position.x += c.userData.speed * dt; if (c.position.x > 110) c.position.x = -110; }
  butterflies.forEach(b => {
    const { l, r, seed, r0 } = b.userData, a = time * .35 + seed;
    b.position.set(Math.cos(a) * r0, 1.6 + Math.sin(time * 1.3 + seed) * .5, Math.sin(a * 1.3) * r0 * .55 - 2);
    b.rotation.y = -a; const flap = Math.sin(time * 18 + seed) * .9; l.rotation.y = flap; r.rotation.y = -flap;
  });
  sparks.update(dt); updateRings(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

/* ================================================================
   UI wiring
   ================================================================ */
function setDifficulty(level) {
  difficulty = level; storage.set('difficulty', level);
  $$('[data-difficulty]').forEach(b => b.classList.toggle('on', b.dataset.difficulty === level));
  buildBoard(level); frameBoard();
}
addEventListener('keydown', e => {
  if (e.target.closest?.('input, textarea')) return;
  if (e.key === 'Escape' || e.key === 'p') { if (state === 'playing') pauseGame(); else if (state === 'paused') resumeGame(); }
  else if ((e.key === ' ' || e.key === 'Enter') && !$('#start-screen').hidden && e.target === document.body) { e.preventDefault(); startGame(); }
});
addEventListener('pointerdown', () => audioCtx(), { once: true });
document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'playing') pauseGame(); });
addEventListener('beforeunload', e => { if (busy()) { e.preventDefault(); e.returnValue = ''; } });

$$('[data-difficulty]').forEach(b => b.addEventListener('click', () => { if (b.dataset.difficulty !== difficulty) { setDifficulty(b.dataset.difficulty); play.ui(); } }));
$$('[data-board-difficulty]').forEach(b => b.addEventListener('click', () => { boardDifficulty = b.dataset.boardDifficulty; renderBoardChips(); loadBoard(); }));
$('#start-button').addEventListener('click', startGame);
$('#retry-button').addEventListener('click', startGame);
$('#home-button').addEventListener('click', () => { show('#result-screen', false); show('#start-screen'); state = 'idle'; clearCheerers(); play.ui(); });
$('#pause-button').addEventListener('click', pauseGame);
$('#resume-button').addEventListener('click', resumeGame);
$('#quit-button').addEventListener('click', finishGame);
function renderSound() {
  const b = $('#sound-toggle'); b.setAttribute('aria-pressed', String(prefs.sound)); b.setAttribute('aria-label', prefs.sound ? '소리 끄기' : '소리 켜기');
  b.querySelector('use').setAttribute('href', prefs.sound ? '#i-sound' : '#i-mute');
}
$('#sound-toggle').addEventListener('click', () => { prefs.sound = !prefs.sound; storage.set('prefs', prefs); renderSound(); play.ui(); });

renderSound(); renderBoardChips();
setDifficulty(difficulty); resize();
view.curPos.copy(view.pos).add(new THREE.Vector3(0, 6, 10)); view.curTarget.copy(view.target);
requestAnimationFrame(frame);
requestAnimationFrame(() => document.body.classList.remove('loading'));
async function loadStats() { try { const { games } = await api('/api/stats'); $('#play-count').textContent = `지금까지 ${format(games)}판`; } catch {} }
loadBoard(); loadGuestbook(); loadStats(); renderPortraits();

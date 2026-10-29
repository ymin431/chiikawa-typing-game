import * as THREE from '/three.module.min.js';

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const now = () => performance.now();
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = list => list[Math.floor(Math.random() * list.length)];
const easeOutBack = t => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2;
const format = n => Number(n).toLocaleString('ko-KR');
const levels = { easy: '쉬움', normal: '보통', hard: '어려움' };
const NAMES = { chiikawa: '치이카와', hachiware: '하치와레', usagi: '우사기', rakko: '랏코', momonga: '모몽가', kurimanju: '쿠리만쥬', shisa: '시사', kani: '카니' };
const storage = {
  get(k, f) { try { return JSON.parse(localStorage.getItem('typefall.' + k)) ?? f; } catch { return f; } },
  set(k, v) { try { localStorage.setItem('typefall.' + k, JSON.stringify(v)); } catch {} },
};
const prefs = storage.get('prefs', { sound: true });
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let difficulty = storage.get('difficulty', 'normal'), language = storage.get('language', 'ko');
let boardDifficulty = difficulty, boardLanguage = language;
let state = 'idle', game = null, lastResult = null, toastTimer = 0;
let assets = { fall: {}, profiles: {}, names: Object.keys(NAMES) };

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
   Sound: keyboard.mp3 for key presses (synth fallback), synth chimes
   ================================================================ */
const sound = { ctx: null, master: null, click: null, raw: null, onset: 0 };
fetch('/keyboard.mp3').then(r => r.ok ? r.arrayBuffer() : null).then(b => { sound.raw = b; decodeClick(); }).catch(() => {});
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
  try {
    const buf = await sound.ctx.decodeAudioData(raw), data = buf.getChannelData(0);
    // Skip leading silence so the click lands exactly on the key press.
    let peak = 0; for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    let i = 0; while (i < data.length && Math.abs(data[i]) < peak * .1) i++;
    sound.onset = Math.max(0, i / buf.sampleRate - .004); sound.click = buf;
  } catch {}
}
function tone(freq, { type = 'sine', at = 0, dur = .4, gain = .2, to = null, attack = .005 } = {}) {
  const ctx = sound.ctx, t = ctx.currentTime + at, osc = ctx.createOscillator(), amp = ctx.createGain();
  osc.type = type; osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur * .8);
  amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(gain, t + attack); amp.gain.exponentialRampToValueAtTime(.0001, t + dur);
  osc.connect(amp).connect(sound.master); osc.start(t); osc.stop(t + dur + .02);
}
const play = {
  key() {
    if (!prefs.sound || !audioCtx()) return;
    const ctx = sound.ctx, t = ctx.currentTime;
    if (sound.click) {
      const src = ctx.createBufferSource(), g = ctx.createGain();
      src.buffer = sound.click; src.playbackRate.value = rand(.95, 1.05);
      g.gain.setValueAtTime(1, t); g.gain.setTargetAtTime(0, t + .18, .03);
      src.connect(g).connect(sound.master); src.start(t, sound.onset, .3);
      return;
    }
    tone(rand(1500, 1700), { dur: .05, gain: .12, to: 900, attack: .001 });
    tone(rand(380, 420), { type: 'triangle', dur: .07, gain: .1, to: 260, attack: .001 });
  },
  chime(combo) {
    if (!prefs.sound || !audioCtx()) return;
    const steps = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24], f = 659 * 2 ** (steps[Math.min(combo - 1, 10)] / 12);
    tone(f, { dur: .45, gain: .13 }); tone(f * 2, { dur: .25, gain: .03 }); tone(f * 1.5, { at: .06, dur: .4, gain: .07 });
  },
  fanfare() { if (!prefs.sound || !audioCtx()) return; [0, 4, 7, 12].forEach((s, i) => tone(784 * 2 ** (s / 12), { at: i * .07, dur: .5, gain: .08 })); },
  miss() { if (!prefs.sound || !audioCtx()) return; tone(420, { dur: .3, gain: .16, to: 150 }); },
  wrong() { if (!prefs.sound || !audioCtx()) return; tone(240, { type: 'triangle', dur: .14, gain: .1, to: 180 }); },
  beep(high) { if (!prefs.sound || !audioCtx()) return; tone(high ? 1047 : 698, { dur: high ? .45 : .18, gain: .1 }); },
};

/* ================================================================
   Three.js scene
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

const scene = new THREE.Scene();
const FOV = 40, CAM_Z = 12, LOOK = new THREE.Vector3(0, -.2, 0);
const camera = new THREE.PerspectiveCamera(FOV, 1, .1, 120);
const baseCam = camera.clone();
camera.position.set(0, .4, CAM_Z); baseCam.position.copy(camera.position); baseCam.lookAt(LOOK);

/* ---------- living painting background ---------- */
const BG_Z = -30;
const bgUniforms = {
  uMap: { value: null }, uCover: { value: new THREE.Vector2(1, 1) }, uMouse: { value: new THREE.Vector2() },
  uTime: { value: 0 }, uReady: { value: 0 }, uHorizon: { value: .69 },
};
let imgAspect = 1432 / 836;
const bg = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
  uniforms: bgUniforms, depthWrite: false, toneMapped: false,
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
  fragmentShader: `
    uniform sampler2D uMap; uniform vec2 uCover, uMouse; uniform float uTime, uReady, uHorizon;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
      return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
    float fbm(vec2 p){ float v = 0., a = .5; for(int i = 0; i < 4; i++){ v += a*noise(p); p *= 2.03; a *= .5; } return v; }
    void main(){
      vec2 uv = (vUv - .5) * uCover + .5;
      float ground = smoothstep(uHorizon + .01, uHorizon - .02, uv.y);
      float depth = clamp((uHorizon - uv.y) / uHorizon, 0., 1.);
      // pseudo-depth parallax: the near meadow slides more than the far hills
      uv += uMouse * (.003 + depth * .012);
      uv = clamp(uv, .001, .999);
      vec3 col = texture2D(uMap, uv).rgb;
      // soft cloud shadows drifting over the meadow
      float n = fbm(vec2(uv.x * 2.2 - uTime * .025, uv.y * 4.5 + uTime * .01));
      col *= 1. + ground * (n - .5) * .12;
      // drifting haze in the sky
      float haze = fbm(vec2(uv.x * 3. + uTime * .015, uv.y * 5.));
      col = mix(col, vec3(1.), (1. - ground) * smoothstep(.45, .8, haze) * .22);
      // light leak from the top-left and a gentle vignette
      col += vec3(1., .97, .9) * exp(-length((uv - vec2(.05, 1.05)) * vec2(1.4, 2.2)) * 2.6) * .22;
      float vig = smoothstep(1.25, .35, length((vUv - .5) * vec2(1.25, 1.)));
      col *= mix(.86, 1., vig);
      gl_FragColor = vec4(mix(vec3(.8, .9, .78), col, uReady), 1.);
      #include <colorspace_fragment>
    }`,
}));
bg.position.z = BG_Z; bg.renderOrder = -10; scene.add(bg);

/* ---------- canvas-drawn textures ---------- */
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
const radial = stops => canvasTex(128, 128, g => {
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); stops.forEach(([o, c]) => gr.addColorStop(o, c));
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
});
const glowTex = radial([[0, 'rgba(255,255,255,1)'], [.4, 'rgba(255,255,255,.5)'], [1, 'rgba(255,255,255,0)']]);
const shadowTex = radial([[0, 'rgba(30,70,30,.9)'], [.5, 'rgba(30,70,30,.4)'], [1, 'rgba(30,70,30,0)']]);
const leafTex = [
  canvasTex(128, 128, g => { // white clover blossom
    g.translate(64, 64);
    for (let i = 0; i < 9; i++) { g.rotate(Math.PI * 2 / 9); g.fillStyle = '#ffffff'; g.beginPath(); g.ellipse(0, -30, 11, 24, 0, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#f3e3a2'; g.beginPath(); g.arc(0, 0, 12, 0, Math.PI * 2); g.fill();
  }),
  canvasTex(128, 128, g => { // clover leaf
    g.translate(64, 64); g.fillStyle = '#7fbf6a';
    for (let i = 0; i < 3; i++) {
      g.save(); g.rotate(i * Math.PI * 2 / 3); g.beginPath(); g.moveTo(0, 0); g.bezierCurveTo(-34, -20, -30, -54, -10, -50); g.quadraticCurveTo(0, -46, 0, -38); g.quadraticCurveTo(0, -46, 10, -50); g.bezierCurveTo(30, -54, 34, -20, 0, 0); g.fill(); g.restore();
    }
  }),
];
// Shown for a character whose image failed to load.
const missingTex = canvasTex(128, 128, g => { g.fillStyle = '#ffffff'; g.beginPath(); g.arc(64, 64, 56, 0, Math.PI * 2); g.fill(); g.strokeStyle = '#3e3532'; g.lineWidth = 5; g.stroke(); });

/* ---------- character images ---------- */
const textures = new Map();
function loadTexture(url) {
  return new Promise(resolve => new THREE.TextureLoader().load(url, t => {
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy(); textures.set(url, t); resolve();
  }, undefined, () => { textures.set(url, missingTex); resolve(); }));
}
let texturesLoaded = false;
const assetsReady = api('/api/assets').then(a => { assets = a; renderAvatarPicker(); return Promise.all(Object.values(a.fall).flat().map(loadTexture)); }).catch(() => {}).finally(() => texturesLoaded = true);
function characterTexture() {
  const names = Object.keys(assets.fall);
  return names.length ? textures.get(pick(assets.fall[pick(names)])) || missingTex : missingTex;
}

/* ---------- falling friends ---------- */
const FRIEND_H = 1.45;
const planeGeo = new THREE.PlaneGeometry(1, 1), shadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const dangerTint = new THREE.Color(1, .62, .62), white = new THREE.Color(1, 1, 1);

class Friend {
  constructor() {
    this.mat = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: .02, side: THREE.DoubleSide, toneMapped: false });
    this.glowMat = new THREE.SpriteMaterial({ map: glowTex, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
    this.group = new THREE.Group();
    this.body = new THREE.Mesh(planeGeo, this.mat);
    const glow = new THREE.Sprite(this.glowMat); glow.scale.setScalar(2.4); glow.position.z = -.05;
    this.group.add(glow, this.body);
    this.shadow = new THREE.Mesh(shadowGeo, new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false, opacity: 0 }));
    scene.add(this.group, this.shadow);
    this.active = false; this.group.visible = this.shadow.visible = false;
  }
  spawn({ x, z, texture, item = null, fall }) {
    Object.assign(this, { x, z, item, fall, active: true, dying: null, progress: 0, danger: false, targeted: false, seed: Math.random(), glow: 0 });
    this.mat.map = texture; this.mat.opacity = 1; this.mat.color.copy(white); this.mat.needsUpdate = true;
    const img = texture.image, aspect = img && img.width ? img.width / img.height : 1;
    this.w = FRIEND_H * aspect; this.body.scale.set(this.w, FRIEND_H, 1);
    this.group.visible = this.shadow.visible = true;
    if (item) { this.label = node('div', 'label'); this.label.append(node('span', 'typed'), node('span', '', item.text)); this.typedLen = 0; $('#labels').append(this.label); }
  }
  setTyped(n) {
    if (!this.label || n === this.typedLen) return;
    this.typedLen = n; const text = this.item.text;
    this.label.firstChild.textContent = text.slice(0, n); this.label.lastChild.textContent = text.slice(n);
  }
  place(progress, time) {
    this.progress = progress;
    const y = lerp(layout.topY, layout.groundY + FRIEND_H / 2, progress);
    const sway = Math.sin(time * 1.1 + this.seed * 6) * .14 * (1 - progress * .7);
    this.group.position.set(this.x + sway, y + Math.sin(time * 2.4 + this.seed * 9) * .04, this.z);
    this.group.rotation.set(0, Math.sin(time * .9 + this.seed * 5) * .32, Math.sin(time * 1.6 + this.seed * 4) * .1);
    this.group.scale.setScalar(easeOutBack(clamp(progress * this.fall / .5)));
    this.shadow.position.set(this.x + sway, layout.groundY + .01, this.z);
    this.shadow.scale.set(this.w * lerp(1.2, .8, progress), 1, lerp(1, .55, progress));
    this.shadow.material.opacity = .04 + .26 * progress * progress;
    const danger = !!this.item && progress > .78;
    if (danger !== this.danger) { this.danger = danger; this.label?.classList.toggle('danger', danger); }
    this.mat.color.copy(white).lerp(dangerTint, danger ? .25 + .25 * Math.sin(time * 12) : 0);
    this.glow = lerp(this.glow, this.targeted ? 1 : 0, .2);
    this.glowMat.opacity = this.glow * (.85 + .15 * Math.sin(time * 7));
  }
  release() {
    this.active = false; this.group.visible = this.shadow.visible = false; this.item = null;
    if (this.label) { const l = this.label; this.label = null; l.classList.add('gone'); setTimeout(() => l.remove(), 260); }
  }
}
const pool = [];
function getFriend() { let f = pool.find(f => !f.active); if (!f) pool.push(f = new Friend()); return f; }

/* ---------- effects: glints, confetti, ripples ---------- */
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
      gl_FragColor = vec4(mix(vColor, vec3(1.), exp(-d * d * 140.) * (1. - vShape * .6)), a);
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
    Object.assign(p, { gravity: 0, drag: 1.8, spinV: rand(-4, 4), spin: rand(0, 6), shape: 0, twinkle: 0, alphaScale: 1 }, o);
    p.max = p.life; p.color = new THREE.Color(o.color);
  }
  update(dt, time) {
    for (let i = 0; i < this.n; i++) {
      const p = this.p[i];
      if (p.life <= 0) { this.alpha.array[i] = 0; continue; }
      if (p.ambient && p.pos.y > 8) p.pos.y = -6;
      p.life -= dt; p.vel.y -= p.gravity * dt; p.vel.multiplyScalar(Math.exp(-p.drag * dt)); p.pos.addScaledVector(p.vel, dt); p.spin += p.spinV * dt;
      const k = clamp(p.life / p.max), tw = p.twinkle ? .6 + .4 * Math.sin(time * p.twinkle + i) : 1;
      this.pos.setXYZ(i, p.pos.x, p.pos.y, p.pos.z); this.col.setXYZ(i, p.color.r, p.color.g, p.color.b);
      this.size.array[i] = p.size * (p.shape ? 1 : Math.sin(Math.min(1, (1 - k) * 4) * Math.PI / 2) * (.4 + .6 * k));
      this.alpha.array[i] = Math.min(1, k * 2.2) * tw * p.alphaScale; this.spin.array[i] = p.spin; this.shape.array[i] = p.shape;
    }
    for (const a of [this.pos, this.col, this.size, this.alpha, this.spin, this.shape]) a.needsUpdate = true;
  }
}
const sparks = new Sparks(700);
const GLINTS = [0xffffff, 0xfff1b8, 0xd9f7e6], CONFETTI = [0xffffff, 0xf7d774, 0x9fd8b5, 0xa9d6f5, 0xf5b8c8];
function burst(pos, { count = 24, speed = 4.5, colors = GLINTS, size = .3, life = .9, gravity = 2.5, shape = 0 } = {}) {
  for (let i = 0; i < count; i++) {
    const a = rand(0, Math.PI * 2), e = rand(-.6, .6), v = speed * rand(.45, 1);
    sparks.emit({ pos: pos.clone(), vel: new THREE.Vector3(Math.cos(a) * Math.cos(e) * v, Math.sin(a) * Math.cos(e) * v + 1, Math.sin(e) * v), life: life * rand(.7, 1.2), size: size * rand(.6, 1.3), color: colors[i % colors.length], gravity, shape });
  }
}
function dust(pos, count = 14) {
  for (let i = 0; i < count; i++) sparks.emit({ pos: pos.clone().add(new THREE.Vector3(rand(-.5, .5), 0, rand(-.2, .2))), vel: new THREE.Vector3(rand(-1.4, 1.4), rand(.4, 1.6), rand(-.3, .3)), life: rand(.6, 1), size: rand(.15, .3), color: 0xffffff, shape: 1, drag: 2.5, alphaScale: .8 });
}

const ringGeo = new THREE.RingGeometry(.94, 1, 72);
const rings = Array.from({ length: 16 }, () => {
  const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
  m.visible = false; scene.add(m); return { m, life: 0 };
});
let ringNext = 0;
function ripple(pos, { flat = false, size = 1.3, color = 0xffffff, life = .6 } = {}) {
  const r = rings[ringNext]; ringNext = (ringNext + 1) % rings.length;
  Object.assign(r, { life, max: life, size }); r.m.position.copy(pos); r.m.rotation.set(flat ? -Math.PI / 2 : 0, 0, 0); r.m.material.color.set(color); r.m.visible = true;
}
function updateRings(dt) {
  for (const r of rings) {
    if (r.life <= 0) { r.m.visible = false; continue; }
    r.life -= dt; const k = 1 - clamp(r.life / r.max), e = 1 - (1 - k) ** 3;
    r.m.scale.setScalar(.15 + r.size * e); r.m.material.opacity = (1 - k) * .85;
  }
}

/* ---------- ambient: drifting blossoms, clover and light motes ---------- */
const LEAVES_PER = reducedMotion ? 4 : 12;
const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpV = new THREE.Vector3();
const leaves = leafTex.map(map => {
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map, transparent: true, alphaTest: .2, side: THREE.DoubleSide, depthWrite: false, toneMapped: false, opacity: .9 }), LEAVES_PER);
  mesh.frustumCulled = false; scene.add(mesh);
  return { mesh, data: Array.from({ length: LEAVES_PER }, () => resetLeaf({}, true)) };
});
function resetLeaf(p, anywhere) {
  const z = rand(-14, 6), half = (CAM_Z - z) * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * Math.max(1.6, camera.aspect) + 2;
  Object.assign(p, { half, pos: new THREE.Vector3(anywhere ? rand(-half, half) : -half, anywhere ? rand(-half * .6, half * .8) : rand(0, half * .9), z),
    vel: new THREE.Vector3(rand(.35, .8), rand(-.4, -.12), 0), rot: new THREE.Euler(rand(0, 6), rand(0, 6), rand(0, 6)),
    spin: new THREE.Vector3(rand(-1.5, 1.5), rand(-1.5, 1.5), rand(-1, 1)), size: .26 * rand(.7, 1.2), seed: rand(0, 9) });
  return p;
}
function updateLeaves(dt, time) {
  for (const { mesh, data } of leaves) {
    data.forEach((p, i) => {
      p.pos.x += (p.vel.x + Math.sin(time * .7 + p.seed) * .25) * dt; p.pos.y += (p.vel.y + Math.cos(time * 1.1 + p.seed) * .12) * dt;
      p.rot.x += p.spin.x * dt; p.rot.y += p.spin.y * dt; p.rot.z += p.spin.z * dt;
      if (p.pos.x > p.half || p.pos.y < -p.half * .7) resetLeaf(p, false);
      tmpM.compose(p.pos, tmpQ.setFromEuler(p.rot), tmpS.setScalar(p.size)); mesh.setMatrixAt(i, tmpM);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }
}
for (let i = 0; i < (reducedMotion ? 20 : 50); i++) {
  sparks.emit({ pos: new THREE.Vector3(rand(-14, 14), rand(-5, 7), rand(-12, 3)), vel: new THREE.Vector3(rand(-.1, .1), rand(.05, .2), 0), drag: 0, spinV: 0, life: 1e9, size: rand(.1, .24), color: 0xffffff, shape: 1, twinkle: rand(.8, 2.2), alphaScale: .5, ambient: true });
}

/* ---------- layout (screen-space anchors in world units) ---------- */
const layout = { topY: 5, groundY: -2.5, span: 4 };
function ndcToWorld(x, y, z = 0) {
  const v = new THREE.Vector3(x, y, .5).unproject(baseCam), dir = v.sub(baseCam.position).normalize();
  return baseCam.position.clone().addScaledVector(dir, (z - baseCam.position.z) / dir.z);
}
function resize() {
  const w = innerWidth, h = innerHeight, aspect = w / h;
  renderer.setSize(w, h, false);
  camera.aspect = baseCam.aspect = aspect; camera.updateProjectionMatrix(); baseCam.updateProjectionMatrix();
  const dist = CAM_Z - BG_Z, vh = 2 * dist * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * 1.1;
  // Centre the painting on the camera's (slightly downward) line of sight.
  bg.scale.set(vh * aspect, vh, 1); bg.position.y = baseCam.position.y + (LOOK.y - baseCam.position.y) * dist / CAM_Z;
  bgUniforms.uCover.value.set(aspect > imgAspect ? 1 : aspect / imgAspect, aspect > imgAspect ? imgAspect / aspect : 1);
  layout.topY = ndcToWorld(0, 1.18).y;
  layout.groundY = ndcToWorld(0, h < 600 ? -.42 : -.5).y;
  layout.span = Math.min(ndcToWorld(1, 0).x * (w < 640 ? .66 : .76), 6.4);
  sparkMat.uniforms.uScale.value = h * renderer.getPixelRatio() / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
}
addEventListener('resize', resize); resize();

new THREE.TextureLoader().load('/meadow.webp', tex => {
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  bgUniforms.uMap.value = tex; imgAspect = tex.image.width / tex.image.height; resize();
  document.body.classList.remove('loading');
  const t0 = now(); const fade = () => { bgUniforms.uReady.value = clamp((now() - t0) / 900); if (bgUniforms.uReady.value < 1) requestAnimationFrame(fade); }; fade();
}, undefined, () => { bgUniforms.uReady.value = 1; document.body.classList.remove('loading'); });

/* ---------- camera motion ---------- */
const pointer = new THREE.Vector2(), smooth = new THREE.Vector2();
let shake = 0;
addEventListener('pointermove', e => { pointer.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight * 2 - 1)); });

/* ================================================================
   Game
   ================================================================ */
const idleFriends = new Set();
let idleTimer = 1;
const screenPos = new THREE.Vector3();
function toScreen(v) { screenPos.copy(v).project(camera); return { x: (screenPos.x + 1) / 2 * innerWidth, y: (1 - screenPos.y) / 2 * innerHeight }; }
function popText(text, v, cls = '') { const s = toScreen(v), n = node('div', 'pop ' + cls, text); n.style.left = s.x + 'px'; n.style.top = s.y + 'px'; document.body.append(n); setTimeout(() => n.remove(), 950); }
function placeLabel(f) {
  const s = toScreen(tmpV.set(f.group.position.x, f.group.position.y - FRIEND_H / 2 - .05, f.z));
  f.label.style.transform = `translate3d(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px, 0) translateX(-50%)`;
}

function busy() { return ['starting', 'playing', 'pausing', 'paused', 'resuming', 'finishing', 'finish-error'].includes(state); }
function elapsed() { return game ? Math.min(game.duration, (game.pauseAt ?? now()) / 1000 - game.started - game.paused) : 0; }
function editDistance(a, b) { let row = Array.from({ length: b.length + 1 }, (_, i) => i); for (let i = 0; i < a.length; i++) { const next = [i + 1]; for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] !== b[j]))); row = next; } return row[b.length]; }
function activeFriends() { return [...game.friends.values()].filter(f => !f.dying); }
function targetFor(value) {
  const list = activeFriends().sort((a, b) => b.progress - a.progress);
  return list.find(f => f.item.text === value) || list.find(f => value && f.item.text.startsWith(value)) || list.find(f => f.item.id === game.target) || list[0];
}

function show(id, on = true) { $(id).hidden = !on; }
function heartIcon() { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#i-heart'); s.append(u); return s; }
function renderHud() {
  if (!game) return;
  const left = Math.max(0, game.lives - game.misses), hearts = $('#hearts');
  hearts.setAttribute('aria-label', '남은 하트 ' + left + '개');
  if (hearts.childElementCount !== game.lives) hearts.replaceChildren(...Array.from({ length: game.lives }, heartIcon));
  [...hearts.children].forEach((h, i) => { const empty = i >= left; if (empty && !h.classList.contains('empty')) h.classList.add('lost'); h.classList.toggle('empty', empty); });
  $('#score').textContent = format(game.score);
}
function renderClock(t) {
  const remain = Math.max(0, Math.ceil(game.duration - t)), c = $('#clock');
  c.textContent = remain; c.style.setProperty('--p', (100 * (1 - t / game.duration)).toFixed(1) + '%'); c.classList.toggle('hurry', remain <= 10);
}
function feedback(msg) { $('#feedback').textContent = msg; }
function setPlaying(on) { document.body.classList.toggle('playing', on); if (on) document.body.classList.remove('side-open'); }

async function startGame() {
  if (busy()) return;
  state = 'starting'; play.key(); setPlaying(true);
  show('#start-screen', false); show('#result-screen', false);
  try {
    const [config] = await Promise.all([api('/api/start', { mode: 'rain', difficulty, language }), assetsReady]);
    game = { ...config, started: 0, paused: 0, pauseAt: null, attempts: [], friends: new Map(), score: 0, good: 0, total: 0, combo: 0, best: 0, correctChars: 0, hits: 0, misses: 0, target: null, nextSpawn: 0, spawning: 0 };
    for (const f of idleFriends) { burst(f.group.position, { count: 10, speed: 3, size: .24 }); f.release(); }
    idleFriends.clear();
    show('#hud'); renderHud(); renderClock(0); show('#typing-form'); show('#pause-button'); feedback('');
    $('#typing-input').value = ''; $('#typing-input').disabled = true;
    show('#countdown');
    for (const text of ['3', '2', '1', 'GO']) {
      const c = $('#count'); c.textContent = text; c.classList.toggle('go', text === 'GO'); c.style.animation = 'none'; void c.offsetWidth; c.style.animation = '';
      play.beep(text === 'GO'); await new Promise(r => setTimeout(r, text === 'GO' ? 450 : 700));
    }
    show('#countdown', false);
    game.started = now() / 1000; state = 'playing';
    $('#typing-input').disabled = false; $('#typing-input').focus();
    if (document.hidden) pauseGame();
  } catch (e) {
    state = 'idle'; setPlaying(false); show('#countdown', false); show('#hud', false); show('#typing-form', false); show('#pause-button', false); show('#start-screen'); toast(e.message);
  }
}

function updateGame(t, time) {
  while (game.nextSpawn < game.deck.length && game.deck[game.nextSpawn].at <= t && game.deck[game.nextSpawn].at < game.duration) {
    const item = game.deck[game.nextSpawn++], f = getFriend();
    f.spawn({ item, x: (item.lane / 6 * 2 - 1) * layout.span, z: ((item.id * 5) % 7 / 6 * 2 - 1) * 1.2, texture: characterTexture(), fall: game.rule.fall });
    game.friends.set(item.id, f);
  }
  for (const [id, f] of game.friends) {
    if (f.dying) continue;
    const progress = (t - f.item.at) / game.rule.fall;
    if (progress >= 1) { missFriend(f); if (game.misses >= game.lives) { finishGame(); return; } continue; }
    f.place(progress, time); placeLabel(f);
  }
  if (t >= game.duration) finishGame();
}
function missFriend(f) {
  game.misses++; game.combo = 0; game.target = null;
  const p = new THREE.Vector3(f.group.position.x, layout.groundY + .05, f.z);
  f.dying = { type: 'miss', t: 0 }; f.label?.classList.add('gone');
  dust(p, 18); ripple(p, { flat: true, size: 1.6, life: .7 });
  shake = .18; $('#flash').classList.add('on'); requestAnimationFrame(() => requestAnimationFrame(() => $('#flash').classList.remove('on')));
  popText('MISS', p, 'miss'); play.miss(); feedback('놓친 단어 · ' + f.item.text);
  renderHud(); onInput();
}
function animateDying(f, dt) {
  const k = f.dying;
  k.t += dt;
  if (k.type === 'hit') {
    const e = clamp(k.t / .2); f.group.scale.setScalar(1 + .35 * e); f.mat.opacity = 1 - e; f.glowMat.opacity = 1 - e;
    if (k.t > .2) finishFriend(f);
  } else {
    const e = clamp(k.t / .35); f.group.scale.set(1 + .25 * e, 1 - .55 * e, 1); f.group.rotation.set(0, 0, 0);
    f.group.position.y = layout.groundY + FRIEND_H / 2 * (1 - .55 * e); f.mat.opacity = 1 - clamp((k.t - .2) / .3); f.shadow.material.opacity *= .92;
    if (k.t > .5) finishFriend(f);
  }
}
function finishFriend(f) { if (game && f.item) game.friends.delete(f.item.id); idleFriends.delete(f); f.release(); }

function submit() {
  if (state !== 'playing') return;
  const input = $('#typing-input'), value = input.value.normalize('NFC').trim();
  if (!value) return;
  lastSubmit = now();
  const at = elapsed(); if (at >= game.duration) { finishGame(); return; }
  const f = targetFor(value);
  if (!f) { feedback('다음 친구가 내려오면 입력해 주세요.'); return; }
  const target = f.item;
  game.attempts.push({ id: target.id, value, at: Number(at.toFixed(3)) });
  const span = Math.max(target.text.length, value.length); game.total += span; game.good += Math.max(0, span - editDistance(target.text, value));
  const form = $('#typing-form');
  if (value === target.text) {
    game.combo++; game.best = Math.max(game.best, game.combo);
    const points = Math.round(target.text.length * 10 * game.rule.factor) + Math.min(game.combo, 20) * 5;
    game.score += points; game.hits++; game.correctChars += target.text.length;
    input.value = ''; game.target = null;
    const p = f.group.position.clone();
    f.dying = { type: 'hit', t: 0 }; f.label.classList.add('gone');
    burst(p, { count: 22 + Math.min(game.combo, 10) * 2 }); burst(p, { count: 14, colors: CONFETTI, shape: 1, size: .14, speed: 5, gravity: 5 });
    ripple(p, { size: 1.5 }); ripple(p, { size: 1, life: .45 });
    popText('+' + points, p); play.chime(game.combo);
    form.classList.remove('right'); void form.offsetWidth; form.classList.add('right'); setTimeout(() => form.classList.remove('right'), 260);
    if (game.combo > 1) { const c = $('#combo'); c.replaceChildren(node('b', '', game.combo), document.createTextNode('COMBO')); c.classList.remove('show'); void c.offsetWidth; c.classList.add('show'); }
    if (game.combo % 10 === 0) { play.fanfare(); for (let i = 0; i < 5; i++) burst(ndcToWorld(rand(-.8, .8), rand(.2, .8), rand(-1, 1)), { count: 16, speed: 3.5, colors: CONFETTI, shape: 1, size: .14, gravity: 4 }); }
    feedback('');
  } else {
    game.combo = 0; play.wrong();
    form.classList.remove('wrong'); void form.offsetWidth; form.classList.add('wrong'); setTimeout(() => form.classList.remove('wrong'), 320);
    feedback('조금 달라요. 고쳐서 다시 Enter');
  }
  renderHud(); onInput();
}
function onInput() {
  if (state !== 'playing') return;
  const value = $('#typing-input').value.normalize('NFC'), target = value ? targetFor(value) : null;
  game.target = target?.item.id ?? null;
  for (const f of activeFriends()) {
    const on = f === target; f.targeted = on; f.label.classList.toggle('target', on);
    f.setTyped(on && f.item.text.startsWith(value) ? value.length : 0);
  }
}

async function pauseGame() {
  if (state !== 'playing') return;
  game.pauseAt = now(); state = 'pausing'; $('#typing-input').disabled = true;
  try {
    await api('/api/pause', { session: game.session });
    state = 'paused'; $('#pause-title').textContent = '잠시 멈춤'; $('#pause-text').textContent = '준비되면 이어서 해요.'; $('#resume-button').textContent = '이어서 하기'; show('#quit-button'); show('#pause-screen');
  } catch (e) { game.pauseAt = null; state = 'playing'; $('#typing-input').disabled = false; toast(e.message); }
}
async function resumeGame() {
  if (state === 'finish-error') { finishGame(); return; }
  if (state !== 'paused') return;
  state = 'resuming'; $('#resume-button').disabled = true;
  try {
    await api('/api/resume', { session: game.session });
    game.paused += (now() - game.pauseAt) / 1000; game.pauseAt = null; state = 'playing';
    show('#pause-screen', false); $('#typing-input').disabled = false; $('#typing-input').focus();
  } catch (e) { state = 'paused'; toast(e.message); } finally { $('#resume-button').disabled = false; }
}
async function finishGame() {
  if (!['playing', 'paused', 'finish-error'].includes(state)) return;
  const duration = state === 'finish-error' ? game.finishElapsed : Math.max(.1, elapsed());
  game.finishElapsed = duration; game.pauseAt ??= now(); state = 'finishing';
  $('#typing-input').disabled = true; show('#pause-screen', false);
  try {
    const result = await api('/api/finish', { session: game.session, elapsed: duration, attempts: game.attempts });
    state = 'finished'; lastResult = result;
    for (const f of game.friends.values()) { if (!f.dying) burst(f.group.position, { count: 8, speed: 2.5, size: .22 }); f.release(); }
    game.friends.clear();
    show('#hud', false); show('#typing-form', false); show('#pause-button', false); feedback(''); setPlaying(false);
    showResult(result);
  } catch (e) {
    state = 'finish-error'; $('#pause-title').textContent = '기록을 저장하지 못했어요'; $('#pause-text').textContent = e.message; $('#resume-button').textContent = '다시 시도'; show('#quit-button', false); show('#pause-screen'); toast(e.message);
  }
}

/* ---------- result + one-step ranking / guestbook registration ---------- */
let avatar = storage.get('avatar', 'chiikawa');
function avatarImg(name, cls = 'avatar') {
  const img = node('img', cls); img.alt = NAMES[name] || ''; img.loading = 'lazy'; img.decoding = 'async';
  img.src = assets.profiles[name] || assets.profiles[Object.keys(assets.profiles)[0]] || '/favicon.svg';
  img.onerror = () => { img.onerror = null; img.src = '/favicon.svg'; };
  return img;
}
function renderAvatarPicker() {
  const names = assets.names?.length ? assets.names : Object.keys(NAMES);
  if (!names.includes(avatar)) avatar = names[0];
  $('#avatar-picker').replaceChildren(...names.map(name => {
    const b = node('button'); b.type = 'button'; b.role = 'radio'; b.dataset.avatar = name; b.setAttribute('aria-checked', String(name === avatar)); b.setAttribute('aria-label', NAMES[name] || name);
    b.append(avatarImg(name, ''), node('span', 'name', NAMES[name] || name));
    b.addEventListener('click', () => { avatar = name; storage.set('avatar', name); $$('#avatar-picker button').forEach(x => x.setAttribute('aria-checked', String(x === b))); });
    return b;
  }));
}
function registerNote(msg, err = false) { const n = $('#register-note'); n.textContent = msg; n.classList.toggle('err', err); }
function showResult(r) {
  $('#result-score').textContent = format(r.score); $('#result-hits').textContent = r.hits; $('#result-accuracy').textContent = r.accuracy + '%'; $('#result-cpm').textContent = format(r.cpm); $('#result-combo').textContent = r.combo;
  $('#result-kicker').textContent = (r.misses >= game.lives ? 'OUT OF HEARTS' : r.elapsed >= game.duration - .5 ? 'TIME UP' : 'RESULT') + ' · ' + levels[difficulty] + ' · ' + (language === 'ko' ? '한글' : 'English');
  const form = $('#register-form'); form.hidden = false; $('#register-button').disabled = false;
  $('#reg-name').value = storage.get('nickname', ''); $('#reg-message').value = '';
  registerNote(r.hits ? '점수는 랭킹에, 한마디는 방명록에 올라가요.' : '잡은 친구가 없어서 방명록만 남길 수 있어요.');
  show('#result-screen');
  if (r.hits) { play.fanfare(); for (let i = 0; i < 4; i++) setTimeout(() => burst(ndcToWorld(rand(-.7, .7), rand(-.1, .6), 0), { count: 18, colors: CONFETTI, shape: 1, size: .14, gravity: 4 }), i * 160); }
  setTimeout(() => (storage.get('nickname', '') ? $('#reg-message') : $('#reg-name')).focus({ preventScroll: true }), 400);
}
$('#register-form').addEventListener('submit', async e => {
  e.preventDefault();
  const nickname = $('#reg-name').value.trim(), message = $('#reg-message').value.trim(), button = $('#register-button');
  if (!nickname) { registerNote('닉네임을 입력해 주세요.', true); return; }
  button.disabled = true; registerNote('등록하고 있어요…');
  try {
    const res = await api('/api/register', { session: game.session, nickname, avatar, message });
    storage.set('nickname', nickname);
    registerNote(res.ranked && res.note ? '랭킹과 방명록에 등록했어요.' : res.ranked ? '랭킹에 등록했어요.' : '방명록에 남겼어요.');
    $('#register-form').querySelectorAll('input, textarea').forEach(el => el.disabled = true);
    boardDifficulty = difficulty; boardLanguage = language; renderBoardChips();
    loadBoard({ nickname, score: lastResult.score }); loadGuestbook();
    setTab(res.ranked ? 'rank' : 'guest');
  } catch (err) { registerNote(err.message, true); button.disabled = false; }
});
function resetRegisterForm() { $('#register-form').querySelectorAll('input, textarea').forEach(el => el.disabled = false); }

/* ---------- left panel ---------- */
function setTab(tab) {
  $$('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  show('#panel-rank', tab === 'rank'); show('#panel-guest', tab === 'guest');
}
function renderBoardChips() {
  $$('[data-board-difficulty]').forEach(b => b.classList.toggle('on', b.dataset.boardDifficulty === boardDifficulty));
  $$('[data-board-language]').forEach(b => b.classList.toggle('on', b.dataset.boardLanguage === boardLanguage));
}
const dateFmt = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric' });
let boardRequest = 0;
async function loadBoard(highlight) {
  const list = $('#board'), id = ++boardRequest;
  try {
    const data = await api('/api/leaderboard?' + new URLSearchParams({ mode: 'rain', difficulty: boardDifficulty, language: boardLanguage }));
    if (id !== boardRequest) return;
    list.replaceChildren(...data.items.map((r, i) => {
      const li = node('li', highlight && r.nickname === highlight.nickname && r.score === highlight.score ? 'me' : ''), who = node('div', 'who');
      who.append(node('b', '', r.nickname), node('small', '', `${r.accuracy}% · ${format(r.cpm)}타`));
      li.append(node('span', 'n', i + 1), avatarImg(r.avatar || 'chiikawa'), who, node('span', 'pts', format(r.score)));
      return li;
    }));
    if (!data.items.length) list.replaceChildren(node('li', 'empty', '아직 기록이 없어요.'));
  } catch (e) { if (id === boardRequest) list.replaceChildren(node('li', 'empty', e.message)); }
}
async function loadGuestbook() {
  const list = $('#guestbook');
  try {
    const data = await api('/api/guestbook');
    list.replaceChildren(...data.items.map(r => {
      const li = node('li'), who = node('div', 'who');
      who.append(node('b', '', r.nickname), node('small', '', dateFmt.format(new Date(r.created))), node('p', '', r.message));
      li.append(avatarImg(r.avatar), who); return li;
    }));
    if (!data.items.length) list.replaceChildren(node('li', 'empty', '첫 번째 한마디를 남겨 주세요.'));
  } catch (e) { list.replaceChildren(node('li', 'empty', e.message)); }
}

/* ---------- idle scene: friends drift down behind the menu ---------- */
function updateIdle(dt, time) {
  if (texturesLoaded && !busy() && !document.hidden && (idleTimer -= dt) <= 0 && idleFriends.size < 6) {
    idleTimer = rand(1.4, 2.2);
    const f = getFriend(); f.spawn({ x: rand(-1, 1) * layout.span * 1.1, z: rand(-3, 1), texture: characterTexture(), fall: rand(7, 9.5) }); f.born = time; idleFriends.add(f);
  }
  for (const f of idleFriends) {
    if (f.dying) continue;
    const progress = (time - f.born) / f.fall;
    if (progress >= 1) { const p = new THREE.Vector3(f.group.position.x, layout.groundY + .05, f.z); dust(p, 8); ripple(p, { flat: true, size: 1.1 }); f.dying = { type: 'miss', t: 0 }; }
    else f.place(progress, time);
  }
}

/* ---------- main loop ---------- */
const clock = new THREE.Clock();
let time = 0;
function frame() {
  const dt = Math.min(clock.getDelta(), .05); time += dt;
  smooth.lerp(pointer, 1 - Math.exp(-dt * 2.5));
  const sway = reducedMotion ? 0 : 1; shake = Math.max(0, shake - dt * .9);
  camera.position.set(smooth.x * .5 * sway + (Math.random() - .5) * shake, .4 + smooth.y * .28 * sway + (Math.random() - .5) * shake, CAM_Z);
  camera.lookAt(LOOK);
  bgUniforms.uTime.value = time; bgUniforms.uMouse.value.set(-smooth.x * sway, -smooth.y * sway);
  if (state === 'playing') { const t = elapsed(); updateGame(t, time); if (state === 'playing') renderClock(t); }
  else if (game && ['pausing', 'paused', 'resuming', 'finishing', 'finish-error'].includes(state)) { for (const f of game.friends.values()) if (!f.dying) placeLabel(f); }
  updateIdle(dt, time);
  for (const f of pool) if (f.active && f.dying) animateDying(f, dt);
  sparks.update(dt, time); updateRings(dt); if (!reducedMotion || time < .1) updateLeaves(dt, time);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ================================================================
   Input & UI wiring
   ================================================================ */
const input = $('#typing-input');
let composing = false, wantSubmit = false, lastSubmit = 0;
input.addEventListener('compositionstart', () => composing = true);
input.addEventListener('compositionend', () => {
  composing = false; onInput();
  // Enter pressed while a Hangul syllable was still composing: submit once it commits.
  if (wantSubmit) { wantSubmit = false; setTimeout(() => { if (now() - lastSubmit > 60) submit(); }, 0); }
});
input.addEventListener('keydown', e => {
  if (state !== 'playing') return;
  if (e.code === 'Enter' || e.key === 'Enter' || e.code === 'NumpadEnter') {
    e.preventDefault();
    if ((e.isComposing || e.keyCode === 229) && composing) { wantSubmit = true; return; }
    if (now() - lastSubmit > 60) submit();
    return;
  }
  if (!e.repeat && !e.metaKey && !e.ctrlKey && !['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'Escape'].includes(e.key)) play.key();
});
input.addEventListener('input', onInput);
input.addEventListener('paste', e => { e.preventDefault(); toast('게임 중에는 직접 입력해 주세요.'); });
input.addEventListener('drop', e => e.preventDefault());
$('#typing-form').addEventListener('submit', e => e.preventDefault());
addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (state === 'playing') pauseGame(); else if (state === 'paused') resumeGame(); else document.body.classList.remove('side-open'); }
  else if (e.key === 'Enter' && e.target === document.body && !$('#start-screen').hidden) startGame();
});
addEventListener('pointerdown', () => audioCtx(), { once: true });
document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'playing') pauseGame(); });
addEventListener('beforeunload', e => { if (busy()) { e.preventDefault(); e.returnValue = ''; } });

function setChoice(attr, value) { $$(`[data-${attr}]`).forEach(b => b.classList.toggle('on', b.dataset[attr] === value)); }
$$('[data-difficulty]').forEach(b => b.addEventListener('click', () => { difficulty = b.dataset.difficulty; storage.set('difficulty', difficulty); setChoice('difficulty', difficulty); play.key(); }));
$$('[data-language]').forEach(b => b.addEventListener('click', () => { language = b.dataset.language; storage.set('language', language); setChoice('language', language); play.key(); }));
setChoice('difficulty', difficulty); setChoice('language', language);
$$('[data-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
$$('[data-board-difficulty]').forEach(b => b.addEventListener('click', () => { boardDifficulty = b.dataset.boardDifficulty; renderBoardChips(); loadBoard(); }));
$$('[data-board-language]').forEach(b => b.addEventListener('click', () => { boardLanguage = b.dataset.boardLanguage; renderBoardChips(); loadBoard(); }));
$('#side-open').addEventListener('click', () => document.body.classList.add('side-open'));
$('#side-close').addEventListener('click', () => document.body.classList.remove('side-open'));
$('#start-button').addEventListener('click', startGame);
$('#retry-button').addEventListener('click', () => { resetRegisterForm(); startGame(); });
$('#home-button').addEventListener('click', () => { resetRegisterForm(); show('#result-screen', false); show('#start-screen'); state = 'idle'; });
$('#pause-button').addEventListener('click', pauseGame);
$('#resume-button').addEventListener('click', resumeGame);
$('#quit-button').addEventListener('click', finishGame);
function renderSound() {
  const b = $('#sound-toggle'); b.setAttribute('aria-pressed', String(prefs.sound)); b.setAttribute('aria-label', prefs.sound ? '소리 끄기' : '소리 켜기');
  b.querySelector('use').setAttribute('href', prefs.sound ? '#i-sound' : '#i-mute');
}
$('#sound-toggle').addEventListener('click', () => { prefs.sound = !prefs.sound; storage.set('prefs', prefs); renderSound(); play.key(); if (state === 'playing') input.focus(); });
renderSound(); renderBoardChips(); renderAvatarPicker();
assetsReady.then(() => { loadBoard(); loadGuestbook(); });

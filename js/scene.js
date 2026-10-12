import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { ELEMENTS } from './data.js';

/* ----------------------------------------------------------------------
   ثابت‌ها — هندسهٔ جدول مستقل از اندازهٔ صفحه است؛ فقط دوربین با صفحه تنظیم می‌شود.
   ---------------------------------------------------------------------- */
const CARD_W = 118, CARD_H = 152, GAP = 12;
const STEP_X = CARD_W + GAP, STEP_Y = CARD_H + GAP;
const TABLE_W = 17 * STEP_X + CARD_W;
const TABLE_H = 9 * STEP_Y + CARD_H;
const SPHERE_R = 1100;
const FOV = 40;
const MAX_DELAY = 0.35;          // پخش‌شدن شروع انیمیشن بین کارت‌ها (موج)
const TRANSITION_MS = 1500;
const MIN_DIST = 450;
const LIMITS = {
  table:  { yaw: 1.15, pitch: 0.95 },
  sphere: { yaw: Infinity, pitch: 1.45 }
};

const clamp = THREE.MathUtils.clamp;
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const wrapPi = a => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const TAN_HALF_FOV = Math.tan(THREE.MathUtils.degToRad(FOV / 2));

export class PeriodicScene {
  constructor(container, { onSelect, onLayout } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.onLayout = onLayout;

    this.layout = 'table';
    this.autoRotate = false;
    this.userZoomed = false;
    this.selected = -1;
    this.hovered = -1;
    this.anim = null;
    this.dirty = true;
    this.fit = 3000;
    this.maxDist = 6000;

    // view = مقدار فعلی (روی صفحه)، target = مقداری که ورودی‌ها تعیین می‌کنند.
    this.view = { yaw: 0, pitch: 0, x: 0, y: 0, dist: 3000 };
    this.target = { ...this.view };
    this.vel = { yaw: 0, pitch: 0 };         // اینرسی بعد از رها کردن انگشت

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 10, 30000);
    this.scene = new THREE.Scene();
    this.group = new THREE.Group();
    this.group.rotation.order = 'YXZ';
    this.scene.add(this.group);

    this.renderer = new CSS3DRenderer();
    container.appendChild(this.renderer.domElement);

    this._build();
    this.resize();
    this.view.dist = this.target.dist = this.fit * 1.35;   // شروع از کمی دورتر، سپس نزدیک می‌شود
    this.setLayout('table', { intro: true });

    let pending = false;
    const onResize = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; this.resize(); });
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    this.last = performance.now();
    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);
  }

  /* ------------------------------ ساخت صحنه ------------------------------ */
  _build() {
    const n = ELEMENTS.length;
    const dummy = new THREE.Object3D();
    this.items = [];
    this.tablePos = [];
    this.spherePos = [];
    this.sphereQuat = [];

    ELEMENTS.forEach((e, i) => {
      const el = document.createElement('div');
      el.className = 'element';
      el.dataset.i = i;
      el.innerHTML =
        `<div class="card cat-${e.cat}">` +
        `<span class="num">${e.z}</span><span class="sym">${e.symbol}</span><span class="nm">${e.name}</span>` +
        `</div>`;
      el.style.width = CARD_W + 'px';
      el.style.height = CARD_H + 'px';

      const obj = new CSS3DObject(el);
      obj.position.set((Math.random() - 0.5) * 6000, (Math.random() - 0.5) * 6000, (Math.random() - 0.5) * 6000);
      this.group.add(obj);

      this.tablePos.push(new THREE.Vector3((e.col - 9.5) * STEP_X, -(e.row - 5.5) * STEP_Y, 0));

      // کره: پخش یکنواخت (فیبوناچی)؛ هر کارت رو به بیرون
      const phi = Math.acos(-1 + (2 * (i + 0.5)) / n);
      const theta = Math.sqrt(n * Math.PI) * phi;
      const p = new THREE.Vector3().setFromSphericalCoords(SPHERE_R, phi, theta);
      this.spherePos.push(p);
      dummy.position.copy(p);
      dummy.lookAt(p.x * 2, p.y * 2, p.z * 2);
      this.sphereQuat.push(dummy.quaternion.clone());

      this.items.push({
        obj, el,
        fromP: new THREE.Vector3(), toP: new THREE.Vector3(),
        fromQ: new THREE.Quaternion(), toQ: new THREE.Quaternion()
      });
    });
    this.identity = new THREE.Quaternion();
  }

  /* ------------------------------ اندازه و فاصله ------------------------------ */
  fitDist(layout = this.layout) {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    const aspect = w / h;
    const tanV = TAN_HALF_FOV;
    const tanH = tanV * aspect;
    if (layout === 'table') {
      const needH = (TABLE_W / 2) / tanH;
      const needV = (TABLE_H / 2) / tanV;
      return Math.max(needH * 1.04, needV * 1.16);       // جا برای نوار پایین
    }
    const r = SPHERE_R + CARD_H / 2;
    const half = Math.atan(Math.min(tanV, tanH));
    return (r / Math.sin(half)) * 1.04;
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fit = this.fitDist();
    this.maxDist = this.fit * 1.6;
    if (!this.userZoomed) this.target.dist = this.fit;
    this._clampTarget();
    this.dirty = true;
  }

  /** چند پیکسل صفحه به ازای هر واحد دنیا در فاصلهٔ فعلی */
  _pxPerUnit(dist = this.target.dist) {
    return (this.container.clientHeight || window.innerHeight) / (2 * dist * TAN_HALF_FOV);
  }

  isZoomedIn() { return this.target.dist < this.fit * 0.82; }

  /* ------------------------------ چیدمان و انیمیشن ------------------------------ */
  setLayout(name, { intro = false } = {}) {
    if (!intro && name === this.layout && !this.anim) return;
    this.layout = name;
    if (name === 'table') {
      // اگر کره چرخانده شده بود، کوتاه‌ترین مسیر بازگشت
      this.view.yaw = wrapPi(this.view.yaw);
    }
    const tp = name === 'table' ? this.tablePos : this.spherePos;
    this.items.forEach((it, i) => {
      it.fromP.copy(it.obj.position);
      it.fromQ.copy(it.obj.quaternion);
      it.toP.copy(tp[i]);
      it.toQ.copy(name === 'table' ? this.identity : this.sphereQuat[i]);
    });
    this.anim = { t0: performance.now(), dur: intro ? 2000 : TRANSITION_MS };

    this.target.yaw = 0; this.target.pitch = 0; this.target.x = 0; this.target.y = 0;
    this.userZoomed = false;
    this.fit = this.fitDist();
    this.maxDist = this.fit * 1.6;
    this.target.dist = this.fit;
    this._clampTarget();
    this.dirty = true;
    this.onLayout?.(name);
  }

  resetView() {
    Object.assign(this.target, { yaw: 0, pitch: 0, x: 0, y: 0 });
    this.vel.yaw = this.vel.pitch = 0;
    this.userZoomed = false;
    this.target.dist = this.fit;
    this.dirty = true;
  }

  /* ------------------------------ ورودی‌های نما ------------------------------ */
  _clampTarget() {
    const t = this.target, L = LIMITS[this.layout];
    t.yaw = clamp(t.yaw, -L.yaw, L.yaw);
    t.pitch = clamp(t.pitch, -L.pitch, L.pitch);
    const panX = this.layout === 'table' ? TABLE_W / 2 : SPHERE_R;
    const panY = this.layout === 'table' ? TABLE_H / 2 : SPHERE_R;
    t.x = clamp(t.x, -panX, panX);
    t.y = clamp(t.y, -panY, panY);
    t.dist = clamp(t.dist, MIN_DIST, this.maxDist);
  }

  rotateBy(dyaw, dpitch) {
    this.target.yaw += dyaw;
    this.target.pitch += dpitch;
    this._clampTarget();
  }

  zoomBy(factor) {
    this.target.dist *= factor;
    this.userZoomed = true;
    this._clampTarget();
  }

  panBy(dxPx, dyPx) {
    const wpp = 1 / this._pxPerUnit();           // واحد دنیا به ازای هر پیکسل
    this.target.x -= dxPx * wpp;
    this.target.y += dyPx * wpp;
    this._clampTarget();
  }

  /* ------------------------------ انتخاب و هاور ------------------------------ */
  pickAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    const card = hit && hit.closest ? hit.closest('.element') : null;
    return card ? +card.dataset.i : -1;
  }

  setHover(i) {
    if (i === this.hovered) return;
    if (this.hovered >= 0) this.items[this.hovered].el.classList.remove('hover');
    if (i >= 0) this.items[i].el.classList.add('hover');
    this.hovered = i;
  }

  select(i, { focus = true } = {}) {
    if (i < 0 || i >= this.items.length) return;
    if (this.selected >= 0) this.items[this.selected].el.classList.remove('sel');
    this.items[i].el.classList.add('sel');
    this.selected = i;
    this.onSelect?.(ELEMENTS[i], i);
    if (focus) this._focusIfSmall(i);
  }

  clearSelection() {
    if (this.selected >= 0) this.items[this.selected].el.classList.remove('sel');
    this.selected = -1;
  }

  /** روی صفحهٔ کوچک، کارت ریز را به اندازهٔ قابل‌لمس بزرگ می‌کند. */
  _focusIfSmall(i) {
    if (this.layout !== 'table') return;
    if (this._pxPerUnit() * CARD_W >= 84) return;
    const h = this.container.clientHeight || window.innerHeight;
    const wantPx = 150 / CARD_W;
    const dist = h / (2 * TAN_HALF_FOV * wantPx);
    const p = this.tablePos[i];
    const small = (this.container.clientWidth || window.innerWidth) <= 640;
    this.target.dist = dist;
    this.target.yaw = 0; this.target.pitch = 0;
    this.target.x = p.x;
    this.target.y = p.y - (small ? (h * 0.12) / this._pxPerUnit(dist) : 0);  // جا برای کارت اطلاعات
    this.userZoomed = true;
    this._clampTarget();
  }

  /* ------------------------------ حلقهٔ رندر ------------------------------ */
  _tick(now) {
    requestAnimationFrame(this._tick);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    let active = false;
    const v = this.view, t = this.target;

    // اینرسی (بعد از رها کردن انگشت)
    if (Math.abs(this.vel.yaw) > 0.02 || Math.abs(this.vel.pitch) > 0.02) {
      this.rotateBy(this.vel.yaw * dt, this.vel.pitch * dt);
      const f = Math.exp(-dt * 3.2);
      this.vel.yaw *= f; this.vel.pitch *= f;
      active = true;
    } else { this.vel.yaw = this.vel.pitch = 0; }

    if (this.autoRotate) {
      if (this.layout === 'sphere') t.yaw += dt * 0.4;
      else { t.yaw = Math.sin(now * 0.00045) * 0.5; t.pitch = Math.sin(now * 0.0003) * 0.12; }
      active = true;
    }

    // میرایی نمایی — مستقل از نرخ فریم
    for (const [k, rate, eps] of [['yaw', 12, 5e-4], ['pitch', 12, 5e-4], ['x', 10, 0.05], ['y', 10, 0.05], ['dist', 8, 0.1]]) {
      const d = t[k] - v[k];
      if (Math.abs(d) > eps) { v[k] = damp(v[k], t[k], rate, dt); active = true; }
      else if (d !== 0) { v[k] = t[k]; active = true; }
    }

    if (this.anim) {
      const p = Math.min(1, (now - this.anim.t0) / this.anim.dur);
      const n = this.items.length;
      for (let i = 0; i < n; i++) {
        const it = this.items[i];
        const l = clamp((p - (i / n) * MAX_DELAY) / (1 - MAX_DELAY), 0, 1);
        const e = easeInOut(l);
        it.obj.position.lerpVectors(it.fromP, it.toP, e);
        it.obj.quaternion.slerpQuaternions(it.fromQ, it.toQ, e);
      }
      if (p >= 1) this.anim = null;
      active = true;
    }

    if (active || this.dirty) {
      this.group.rotation.set(v.pitch, v.yaw, 0);
      this.camera.position.set(v.x, v.y, v.dist);
      this.renderer.render(this.scene, this.camera);
      this.dirty = false;
    }
  }
}

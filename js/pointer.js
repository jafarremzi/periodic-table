/**
 * کنترل ماوس و لمس با Pointer Events (یک کد برای موبایل و دسکتاپ):
 *  - یک انگشت/ماوس: چرخش (با اینرسی). وقتی جدول زوم‌شده است: جابه‌جایی.
 *  - دو انگشت: زوم (پینچ) + جابه‌جایی
 *  - تپ کوتاه: انتخاب عنصر    - چرخ ماوس / پینچ تاچ‌پد: زوم
 *  - دکمهٔ راست یا Shift + درگ: جابه‌جایی
 */
const ROT_K = 0.0052;       // رادیان بر پیکسل
const TAP_MOVE = 8;         // بیشینهٔ جابه‌جایی برای تشخیص «تپ»
const TAP_MS = 600;

export function attachPointer(stage, scene) {
  const pts = new Map();
  let g = null;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  stage.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button > 2) return;
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey });
    scene.vel.yaw = scene.vel.pitch = 0;
    const now = performance.now();
    if (pts.size === 1) {
      g = { t: now, lt: now, moved: 0, vyaw: 0, vpitch: 0, rotated: false };
    } else if (pts.size === 2 && g) {
      const [a, b] = [...pts.values()];
      g.pd = dist(a, b);
      g.pc = mid(a, b);
      g.moved = 999;                         // دیگر تپ حساب نمی‌شود
    }
  });

  stage.addEventListener('pointermove', e => {
    const p = pts.get(e.pointerId);
    if (!p || !g) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;

    if (pts.size === 1) {
      g.moved += Math.hypot(dx, dy);
      if (g.moved < TAP_MOVE) return;
      if (p.pan || (scene.layout === 'table' && scene.isZoomedIn())) {
        scene.panBy(dx, dy);
      } else {
        scene.rotateBy(dx * ROT_K, dy * ROT_K);
        const now = performance.now();
        const dt = Math.max(1, now - g.lt) / 1000;
        g.vyaw = 0.7 * g.vyaw + 0.3 * (dx * ROT_K) / dt;
        g.vpitch = 0.7 * g.vpitch + 0.3 * (dy * ROT_K) / dt;
        g.lt = now;
        g.rotated = true;
      }
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = dist(a, b), c = mid(a, b);
      if (g.pd > 0 && d > 0) scene.zoomBy(g.pd / d);
      scene.panBy(c.x - g.pc.x, c.y - g.pc.y);
      g.pd = d; g.pc = c;
    }
  });

  const end = e => {
    if (!pts.has(e.pointerId)) return;
    const wasSingle = pts.size === 1;
    pts.delete(e.pointerId);
    if (!g) return;
    if (wasSingle) {
      const now = performance.now();
      if (e.type === 'pointerup' && g.moved < TAP_MOVE && now - g.t < TAP_MS) {
        const i = scene.pickAt(e.clientX, e.clientY);
        if (i >= 0) scene.select(i);
      } else if (g.rotated && now - g.lt < 90) {
        scene.vel.yaw = g.vyaw;                 // اینرسی فقط اگر انگشت هنگام رها شدن در حرکت بود
        scene.vel.pitch = g.vpitch;
      }
      g = null;
    } else {
      g.moved = 999; g.rotated = false;          // انگشت باقی‌مانده نباید تپ/اینرسی بسازد
    }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);

  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const dy = Math.max(-120, Math.min(120, e.deltaY));
    scene.zoomBy(Math.exp(dy * (e.ctrlKey ? 0.012 : 0.0014)));   // ctrlKey = پینچ تاچ‌پد
  }, { passive: false });

  stage.addEventListener('contextmenu', e => e.preventDefault());
}

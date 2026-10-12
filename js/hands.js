/**
 * کنترل با دست — MediaPipe Tasks Vision (GestureRecognizer)
 *
 * چه چیزی نسبت به نسخهٔ قبل قوی‌تر شده:
 *  ۱) فیلتر One-Euro روی مختصات (لرزش را حذف می‌کند، ولی تأخیر حرکت سریع را زیاد نمی‌کند)
 *  ۲) پایدارسازی ژست: یک ژست باید چند فریم پشت‌سرهم دیده شود و با افت لحظه‌ای تشخیص نمی‌پرد
 *  ۳) ترکیب مدل + هندسهٔ انگشتان: وقتی مدل مطمئن نیست، وضعیت انگشتان تصمیم می‌گیرد
 *  ۴) پینچ با هیسترزیس (آستانهٔ بستن و باز کردن جدا) و قفل‌شدن موقعیت نشانگر هنگام کلیک
 *  ۵) ژست‌های گسسته (V، شست بالا، ILoveYou) فقط بعد از نگه‌داشتن کوتاه اجرا می‌شوند
 *  ۶) هر حالت (چرخش/زوم/نشانگر) وضعیت خودش را دارد و هنگام تعویض صفر می‌شود، بدون پرش
 *  ۷) هر ورودی بر پایهٔ زمان محاسبه می‌شود، نه تعداد فریم؛ روی گوشی کند هم رفتار یکسان است
 */

const VISION_VERSION = '1.1.0';
const VISION_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}`;
const VISION_URL = `${VISION_BASE}/vision_bundle.mjs`;
const WASM_URL = `${VISION_BASE}/wasm`;
// ابتدا مسیر رسمی فعلی و مسیر رسمی قدیمی امتحان می‌شود؛ فایل محلی نیز آخرین گزینه است.
const MODEL_URLS = [
  'https://storage.googleapis.com/mediapipe-tasks/gesture_recognizer/gesture_recognizer.task',
  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task',
  'models/gesture_recognizer.task'
];
// نسخهٔ جایگزین، مدل hand-landmark را از CDN جاوااسکریپت می‌گیرد و به دانلود فایل .task از Google Storage وابسته نیست.
const LEGACY_VERSION = '0.4.1675469240';
const LEGACY_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/hands@${LEGACY_VERSION}`;
const LOAD_TIMEOUT = 30000;
const FALLBACK_TIMEOUT = 25000;
const FALLBACK_AFTER_NO_HAND_MS = 4500;
const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],
  [10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],
  [18,19],[19,20],[0,17]
];
const withTimeout = (p, ms, label = 'load timeout') => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(label), { name: 'LoadTimeout' })), ms))
]);
let legacyHandsScriptPromise = null;
function loadLegacyHandsScript() {
  if (globalThis.Hands) return Promise.resolve(globalThis.Hands);
  if (legacyHandsScriptPromise) return legacyHandsScriptPromise;
  legacyHandsScriptPromise = withTimeout(new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${LEGACY_BASE}/hands.js`;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => globalThis.Hands ? resolve(globalThis.Hands) : reject(new Error('MediaPipe Hands script loaded without the Hands API'));
    script.onerror = () => reject(new Error('Could not download the fallback MediaPipe Hands library'));
    document.head.appendChild(script);
  }), FALLBACK_TIMEOUT, 'fallback library timeout').catch(err => {
    legacyHandsScriptPromise = null;
    throw err;
  });
  return legacyHandsScriptPromise;
}

const DWELL_SELECT = 750;     // ms ثابت ماندن نشانگر روی یک عنصر = انتخاب
const DWELL_ACTION = 450;     // ms نگه‌داشتن ژست گسسته تا اجرا
const ACTION_COOLDOWN = 900;
const PINCH_ON = 0.32, PINCH_OFF = 0.50;     // نسبت فاصلهٔ شست–اشاره به اندازهٔ دست
const DISCRETE = new Set(['Victory', 'Thumb_Up', 'ILoveYou']);

const LABEL = {
  Victory: '✌️ جدول/کره', Thumb_Up: '👍 بازنشانی نما', ILoveYou: '🤟 چرخش خودکار'
};

/* ------------------------------ فیلتر One-Euro ------------------------------ */
class OneEuro {
  constructor(minCutoff = 1.0, beta = 0.02, dCutoff = 1.0) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.reset();
  }
  reset() { this.t = null; this.x = 0; this.dx = 0; }
  _alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(x, tMs) {
    const t = tMs / 1000;
    if (this.t === null) { this.t = t; this.x = x; this.dx = 0; return x; }
    const dt = Math.max(1e-3, t - this.t);
    this.t = t;
    const rawD = (x - this.x) / dt;
    const aD = this._alpha(this.dCutoff, dt);
    this.dx = aD * rawD + (1 - aD) * this.dx;
    const a = this._alpha(this.minCutoff + this.beta * Math.abs(this.dx), dt);
    this.x = a * x + (1 - a) * this.x;
    return this.x;
  }
}

/* ------------------------------ پایدارساز ژست ------------------------------ */
class Stabilizer {
  constructor(frames = 3, holdMs = 250) {
    this.need = frames; this.hold = holdMs;
    this.reset();
  }
  reset() { this.cand = 'None'; this.n = 0; this.stable = 'None'; this.lastGood = 0; }
  update(raw, tMs) {
    if (raw === this.cand) this.n++; else { this.cand = raw; this.n = 1; }
    if (raw !== 'None') this.lastGood = tMs;
    if (this.n >= this.need && raw !== this.stable) {
      // افت لحظه‌ای به None ژست پایدار را نمی‌شکند
      if (raw !== 'None' || tMs - this.lastGood > this.hold) this.stable = raw;
    }
    return this.stable;
  }
}

/* ------------------------------ ابزارهای هندسی ------------------------------ */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const palmCenter = lm => ({
  x: (lm[0].x + lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 5,
  y: (lm[0].y + lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 5
});
const handSize = lm => Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) || 1e-3;

/** حالت زوم تک‌دستی: اشاره باز، سه انگشت دیگر جمع، و شست برای کنترل فاصله آزاد باشد. */
function isFingerZoomPose(lm) {
  if (!Array.isArray(lm) || lm.length < 21) return false;
  const w = lm[0];
  const fromWrist = p => Math.hypot(p.x - w.x, p.y - w.y);
  const extended = (pip, tip) => fromWrist(lm[tip]) > fromWrist(lm[pip]) * 1.08;
  const indexUp = extended(6, 8);
  const middleUp = extended(10, 12);
  const ringUp = extended(14, 16);
  const pinkyUp = extended(18, 20);
  const thumbOut = Math.hypot(lm[4].x - lm[5].x, lm[4].y - lm[5].y) >
    Math.hypot(lm[3].x - lm[5].x, lm[3].y - lm[5].y) * 0.94;
  return indexUp && !middleUp && !ringUp && !pinkyUp && thumbOut;
}

/** ژست‌سنج هندسی؛ در موتور جایگزین هم ژست‌های اصلی را بدون مدل طبقه‌بندی تشخیص می‌دهد. */
function geometricGesture(lm) {
  if (!Array.isArray(lm) || lm.length < 21) return 'None';
  const w = lm[0];
  const d = p => Math.hypot(p.x - w.x, p.y - w.y);
  const ext = [[6, 8], [10, 12], [14, 16], [18, 20]].map(([pip, tip]) => d(lm[tip]) > d(lm[pip]) * 1.08);
  const [i, m, r, p] = ext;
  const thumbOut = Math.hypot(lm[4].x - lm[5].x, lm[4].y - lm[5].y) >
    Math.hypot(lm[3].x - lm[5].x, lm[3].y - lm[5].y) * 1.08;
  const n = ext.filter(Boolean).length;
  if (i && m && !r && !p) return 'Victory';
  if (i && !m && !r && p && thumbOut) return 'ILoveYou';
  if (n === 0 && thumbOut && lm[4].y < lm[3].y) return 'Thumb_Up';
  if (i && !m && !r && !p) return 'Pointing_Up';
  if (n >= 4) return 'Open_Palm';
  if (n === 0) return 'Closed_Fist';
  return 'None';
}

export class HandController {
  /**
   * @param {object} o
   * @param {import('./scene.js').PeriodicScene} o.scene
   * @param {HTMLVideoElement} o.video
   * @param {HTMLCanvasElement} o.canvas
   * @param {object} o.ui       setBadge, cursor, toast, setCameraState
   * @param {object} o.actions  toggleLayout, reset, toggleAuto
   */
  constructor({ scene, video, canvas, ui, actions }) {
    Object.assign(this, { scene, video, canvas, ui, actions });
    this.ctx = canvas.getContext('2d');
    this.running = false;
    this.recognizer = null;
    this.stream = null;
    this.modelPromise = null;
    this.legacyHands = null;
    this.fallbackPromise = null;
    this.engine = 'none';
    this.legacyBusy = false;
    this.frameScheduled = false;
    this.loopGeneration = 0;
    this.sessionId = 0;
    this.mobile = matchMedia('(pointer:coarse)').matches || innerWidth < 700;
    this.minInterval = this.mobile ? 33 : 16;    // سقف نرخ استنتاج (ms)

    this.f = {
      cx: new OneEuro(1.0, 0.015), cy: new OneEuro(1.0, 0.015),
      ix: new OneEuro(1.4, 0.06),  iy: new OneEuro(1.4, 0.06),
      size: new OneEuro(1.0, 0.01), d2: new OneEuro(1.0, 0.01),
      fingerGap: new OneEuro(1.8, 0.025)
    };
    this.stab = new Stabilizer(3, 250);
    this._onFrame = this._onFrame.bind(this);
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.running) this.stop(); });
    this._resetState();
  }

  _resetState() {
    Object.values(this.f).forEach(f => f.reset());
    this.stab.reset();
    this.mode = 'idle';
    this.prev = null; this.prevSize = null; this.prevD = null; this.prevFingerGap = null;
    this.pinch = false; this.free = null; this.approach = false; this.hist = [];
    this.dwellIdx = -1; this.dwellT0 = 0; this.dwellDone = false;
    this.holdT0 = 0; this.fired = false; this.lastFire = 0;
    this.twoCount = 0; this.lastSeen = 0;
    this.lastVT = -1; this.lastInfer = 0; this.lastTs = 0;
    this.lastDetectionAt = 0; this.gestureStartedAt = 0; this.inferenceErrors = 0;
    this.legacyLastVT = -1; this.legacyBusy = false;
  }

  /* ------------------------------ راه‌اندازی ------------------------------ */
  async _loadModel() {
    const { GestureRecognizer, FilesetResolver } = await import(VISION_URL);
    this.GR = GestureRecognizer;
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    const make = (modelAssetPath, delegate) => GestureRecognizer.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate },
      runningMode: 'VIDEO', numHands: 2,
      minHandDetectionConfidence: 0.45,
      minHandPresenceConfidence: 0.45,
      minTrackingConfidence: 0.45
    });
    let lastErr;
    for (const url of MODEL_URLS) {
      for (const delegate of ['GPU', 'CPU']) {
        try {
          this.recognizer = await make(url, delegate);
          console.info('[hands] GestureRecognizer ready', { url, delegate, version: VISION_VERSION });
          return;
        } catch (err) {
          lastErr = err;
          console.warn('[hands] task model load failed', { url, delegate, err });
        }
      }
    }
    throw lastErr || new Error('GestureRecognizer model could not be loaded');
  }

  _stopStream() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  async _requestCameraStream() {
    // ابتدا کیفیت مناسب را امتحان می‌کنیم و در صورت ناسازگاری، به محدودیت‌های ساده‌تر برمی‌گردیم.
    const constraints = [
      {
        video: {
          facingMode: { ideal: 'user' },
          width: { ideal: this.mobile ? 320 : 480 },
          height: { ideal: this.mobile ? 240 : 360 },
          frameRate: { ideal: 30, max: 30 }
        },
        audio: false
      },
      { video: { facingMode: { ideal: 'user' } }, audio: false },
      { video: true, audio: false }
    ];
    let lastError;
    for (const constraint of constraints) {
      try {
        return await navigator.mediaDevices.getUserMedia(constraint);
      } catch (err) {
        lastError = err;
        // رد شدن مجوز را با درخواست‌های تکراری دوربین بدتر نمی‌کنیم.
        if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(err?.name)) throw err;
      }
    }
    throw lastError || new Error('Camera unavailable');
  }

  async start() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('Camera requires HTTPS or localhost'), { name: 'SecurityError' });
    }

    this.ui.setCameraState(true);
    this.ui.setBadge('در حال باز کردن دوربین…');

    try {
      const hasLiveCamera = this.stream?.getVideoTracks().some(track => track.readyState === 'live');
      if (!hasLiveCamera) this.stream = await this._requestCameraStream();

      // این خصوصیات را صریح تنظیم می‌کنیم تا پخش زنده روی Safari/iOS هم قابل‌اعتمادتر باشد.
      this.video.autoplay = true;
      this.video.playsInline = true;
      this.video.muted = true;
      this.video.srcObject = this.stream;
      await this.video.play();
    } catch (err) {
      this._stopStream();
      this.running = false;
      this.ui.setCameraState(false);
      throw err;
    }

    // دوربین مستقل از مدل روشن می‌ماند؛ خطای CDN دیگر پیش‌نمایش دوربین را نمی‌بندد.
    this._resetState();
    this.sessionId = (Number.isFinite(this.sessionId) ? this.sessionId : 0) + 1;
    this.loopGeneration += 1;
    this.frameScheduled = false;
    this.running = true;
    this.ui.setBadge('دوربین روشن است؛ در حال بارگذاری مدل دست…');
    this._loadRecognizerInBackground(this.sessionId);
  }

  _loadRecognizerInBackground(sessionId) {
    if (this.engine === 'legacy' && this.legacyHands) {
      if (this.running && sessionId === this.sessionId) {
        this.ui.setBadge('موتور جایگزین آماده است؛ دست را نشان دهید');
        this._schedule();
      }
      return;
    }
    if (this.recognizer) {
      if (this.running && sessionId === this.sessionId && this.engine !== 'legacy') {
        this.engine = 'gesture';
        this.gestureStartedAt = performance.now();
        this.ui.setBadge('مدل فعال است؛ دست را روبه‌روی دوربین بگیرید');
        this._schedule();
      }
      return;
    }

    if (!this.modelPromise) this.modelPromise = this._loadModel();
    const pending = this.modelPromise;
    pending.then(() => {
      if (this.modelPromise === pending) this.modelPromise = null;
      if (!this.running || sessionId !== this.sessionId || this.engine === 'legacy') return;
      this.engine = 'gesture';
      this.gestureStartedAt = performance.now();
      this.ui.setBadge('مدل فعال است؛ دست را روبه‌روی دوربین بگیرید');
      this._schedule();
    }).catch(err => {
      if (this.modelPromise === pending) this.modelPromise = null;
      if (!this.running || sessionId !== this.sessionId) return;
      console.error('[hands] GestureRecognizer initialization failed; switching engine', err);
      this._activateLegacyFallback('task model failed', sessionId);
    });

    // حتی اگر مدل مدرن روی CDN کند/مسدود شود، مدل جایگزین از CDN جداگانهٔ جاوااسکریپت امتحان می‌شود.
    withTimeout(pending, LOAD_TIMEOUT, 'GestureRecognizer model timeout').catch(err => {
      if (err?.name !== 'LoadTimeout' || !this.running || sessionId !== this.sessionId) return;
      console.warn('[hands] GestureRecognizer timed out; switching to fallback', err);
      this._activateLegacyFallback('task model timeout', sessionId);
    });
  }

  async _activateLegacyFallback(reason, sessionId = this.sessionId) {
    if (!this.running || sessionId !== this.sessionId || this.engine === 'legacy' || this.fallbackPromise) return;
    this.ui.setBadge('در حال بارگذاری موتور جایگزین تشخیص دست…');
    const pending = (async () => {
      const HandsCtor = await loadLegacyHandsScript();
      if (!this.running || sessionId !== this.sessionId) return;

      const legacy = new HandsCtor({ locateFile: file => `${LEGACY_BASE}/${file}` });
      legacy.setOptions({
        maxNumHands: 2,
        modelComplexity: 1,
        minDetectionConfidence: 0.45,
        minTrackingConfidence: 0.45
      });
      legacy.onResults(results => {
        // نمونهٔ فعال را بررسی می‌کنیم، نه شناسهٔ نشست capture شده؛ این کار خاموش/روشن کردن دوربین را هم پایدار می‌کند.
        if (!this.running || this.engine !== 'legacy' || this.legacyHands !== legacy) return;
        const landmarks = Array.isArray(results.multiHandLandmarks) ? results.multiHandLandmarks : [];
        if (landmarks.length) this.lastDetectionAt = performance.now();
        this._process({ landmarks, gestures: [] }, performance.now());
      });

      if (typeof legacy.initialize === 'function') {
        await withTimeout(legacy.initialize(), FALLBACK_TIMEOUT, 'MediaPipe Hands initialization timeout');
      }
      if (!this.running || sessionId !== this.sessionId) {
        try { legacy.close?.(); } catch { /* no-op */ }
        return;
      }
      this.legacyHands = legacy;
      this.engine = 'legacy';
      this.legacyLastVT = -1;
      this.legacyBusy = false;
      this.ui.setBadge('موتور جایگزین آماده است؛ دست را نشان دهید');
      console.info('[hands] Legacy MediaPipe Hands ready:', reason);
      this._schedule();
    })();
    this.fallbackPromise = pending;
    try {
      await pending;
    } catch (err) {
      console.error('[hands] fallback engine failed', err);
      if (this.running && sessionId === this.sessionId) {
        this.ui.setBadge('مدل دست بارگذاری نشد');
        this.ui.toast('موتور تشخیص دست بارگذاری نشد. دسترسی به cdn.jsdelivr.net را بررسی و صفحه را دوباره بارگذاری کنید.', 9000);
      }
    } finally {
      if (this.fallbackPromise === pending) this.fallbackPromise = null;
    }
  }

  stop() {
    this.sessionId = (Number.isFinite(this.sessionId) ? this.sessionId : 0) + 1;
    this.running = false;
    this.loopGeneration += 1;
    this.frameScheduled = false;
    this._stopStream();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.scene.setHover(-1);
    this.ui.cursor(null);
    this.ui.setCameraState(false);
  }

  _schedule() {
    if (!this.running || this.frameScheduled) return;
    this.frameScheduled = true;
    const generation = this.loopGeneration;
    const callback = () => this._onFrame(generation);
    if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(callback);
    else requestAnimationFrame(callback);
  }

  _onFrame(generation = this.loopGeneration) {
    // callbackهای مانده از دوربین/نشست قبلی اجازه ندارند یک حلقهٔ دوم بسازند.
    if (generation !== this.loopGeneration) return;
    this.frameScheduled = false;
    if (!this.running) return;
    const t = performance.now();
    const v = this.video;

    if (this.engine === 'gesture' && this.recognizer && v.readyState >= 2 &&
        v.currentTime !== this.lastVT && t - this.lastInfer >= this.minInterval) {
      this.lastVT = v.currentTime;
      this.lastInfer = t;
      const ts = Math.max(t, this.lastTs + 1);
      this.lastTs = ts;
      try {
        const result = this.recognizer.recognizeForVideo(v, ts);
        this.inferenceErrors = 0;
        const count = Array.isArray(result?.landmarks) ? result.landmarks.length : 0;
        if (count) this.lastDetectionAt = t;
        this._process(result || { landmarks: [], gestures: [] }, t);
        // اگر مدل راه افتاده اما چند ثانیه هیچ مختصاتی برنمی‌گرداند، موتور جایگزین را امتحان می‌کنیم.
        if (!count && !this.lastDetectionAt && this.gestureStartedAt && t - this.gestureStartedAt > FALLBACK_AFTER_NO_HAND_MS) {
          this._activateLegacyFallback('no landmarks from task model', this.sessionId);
        } else if (!count && this.lastDetectionAt && t - this.lastDetectionAt > 8000) {
          this._activateLegacyFallback('tracking lost for too long', this.sessionId);
        }
      } catch (err) {
        console.error('[hands] recognizeForVideo failed', err);
        this.inferenceErrors++;
        if (this.inferenceErrors >= 3) this._activateLegacyFallback('repeated inference errors', this.sessionId);
      }
    } else if (this.engine === 'legacy' && this.legacyHands && v.readyState >= 2 &&
               v.currentTime !== this.legacyLastVT && !this.legacyBusy) {
      this.legacyLastVT = v.currentTime;
      this.legacyBusy = true;
      try {
        Promise.resolve(this.legacyHands.send({ image: v }))
          .catch(err => {
            console.error('[hands] fallback inference failed', err);
            this.ui.setBadge('خطا در پردازش دست؛ در حال تلاش مجدد…');
          })
          .finally(() => { this.legacyBusy = false; });
      } catch (err) {
        this.legacyBusy = false;
        console.error('[hands] fallback inference failed', err);
      }
    }
    this._schedule();
  }

  /* ------------------------------ پردازش هر فریم ------------------------------ */
  _process(res, t) {
    const hands = (res.landmarks || []).map((lm, i) => ({ lm, model: res.gestures?.[i]?.[0] || null }));
    this._draw(hands);

    if (!hands.length) { this._lost(t); return; }
    this.lastSeen = t;

    this.twoCount = hands.length >= 2 ? this.twoCount + 1 : 0;
    if (this.twoCount >= 4) { this._twoHands(hands, t); return; }

    // دستِ اصلی = بزرگ‌ترین دست (در برابر تشخیص‌های کاذب کوچک مقاوم‌تر است)
    const primary = hands.reduce((a, b) => (handSize(b.lm) > handSize(a.lm) ? b : a));
    this._single(primary, t);
  }

  _lost(t) {
    if (t - this.lastSeen < 350) return;
    if (this.mode === 'idle') {
      this.ui.setBadge(this.engine === 'legacy' ? 'موتور آماده است؛ دست را روبه‌روی دوربین بگیرید' : 'مدل فعال است؛ دست را روبه‌روی دوربین بگیرید');
      return;
    }
    if (this.mode !== 'idle') {
      this._enter('idle');
      this.scene.setHover(-1);
      this.ui.cursor(null);
      this.ui.setBadge('در انتظار دست…');
      this.stab.reset();
      this.pinch = false;
    }
  }

  _enter(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.prev = null; this.prevSize = null; this.prevD = null; this.prevFingerGap = null;
    this.f.cx.reset(); this.f.cy.reset(); this.f.size.reset(); this.f.d2.reset(); this.f.fingerGap.reset();
    this.dwellIdx = -1; this.dwellDone = false;
    this.holdT0 = 0; this.fired = false;
    if (mode !== 'pointer') { this.scene.setHover(-1); this.ui.cursor(null); }
  }

  /* ------------------------------ دو دست: زوم ------------------------------ */
  _twoHands(hands, t) {
    const a = palmCenter(hands[0].lm), b = palmCenter(hands[1].lm);
    const d = this.f.d2.filter(Math.hypot(a.x - b.x, a.y - b.y), t);
    if (this.mode !== 'zoom2') { this._enter('zoom2'); this.f.d2.filter(d, t); this.prevD = d; }
    else {
      const r = d / this.prevD;
      if (Math.abs(Math.log(r)) > 0.004) this.scene.zoomBy(clamp(Math.pow(1 / r, 1.5), 0.9, 1.1));
      this.prevD = d;
    }
    this.ui.setBadge('🤲 زوم با دو دست');
  }

  /* ------------------------------ یک دست ------------------------------ */
  _classify(h, lm) {
    const m = h.model;
    if (m && m.categoryName !== 'None') {
      const need = DISCRETE.has(m.categoryName) ? 0.7 : 0.5;
      if (m.score >= need) return m.categoryName;
    }
    return geometricGesture(lm);
  }

  _single(h, t) {
    const lm = h.lm, size = handSize(lm);

    // زوم تک‌دستی از فاصلهٔ شست تا اشاره؛ این حالت قبل از تشخیص پینچ/کلیک بررسی می‌شود
    // تا بستن و باز کردن انگشت‌ها به‌اشتباه روی کارت کلیک نکند.
    if (isFingerZoomPose(lm)) {
      this._fingerZoom(lm, t);
      return;
    }

    const stable = this.stab.update(this._classify(h, lm), t);

    // موقعیت نوک انگشت اشاره روی صفحه (همیشه فیلتر می‌شود تا موقع ورود به حالت نشانگر پرش نداشته باشد)
    const fx = this.f.ix.filter(clamp((1 - lm[8].x - 0.10) / 0.80, 0, 1) * innerWidth, t);
    const fy = this.f.iy.filter(clamp((lm[8].y - 0.08) / 0.72, 0, 1) * innerHeight, t);

    // نوک اشاره هنگام بستن پینچ ناخواسته جابه‌جا می‌شود. تاریخچهٔ کوتاه نگه می‌داریم و لحظهٔ شروع بسته‌شدن
    // به موقعیتِ ~۱۸۰ms قبل برمی‌گردیم (جایی که کاربر واقعاً نشانه رفته بود) و تا پایان پینچ قفل می‌کنیم.
    this.hist.push({ t, x: fx, y: fy });
    while (this.hist.length > 2 && t - this.hist[0].t > 400) this.hist.shift();
    const ratio = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y, lm[4].z - lm[8].z) / size;
    if (ratio > PINCH_OFF) { this.free = { x: fx, y: fy }; this.approach = false; }
    else if (!this.approach) {
      this.approach = true;
      const past = this.hist.find(h => h.t >= t - 180) || this.hist[0];
      this.free = { x: past.x, y: past.y };
    }
    let pinchRise = false;
    if (!this.pinch && ratio < PINCH_ON && stable !== 'Closed_Fist') { this.pinch = true; pinchRise = true; }
    else if (this.pinch && ratio > PINCH_OFF) this.pinch = false;

    if (DISCRETE.has(stable)) return this._discrete(stable, t);
    if (this.pinch || stable === 'Pointing_Up') {
      const pos = ratio <= PINCH_OFF && this.free ? this.free : { x: fx, y: fy };
      return this._pointer(pos, stable, pinchRise, t);
    }
    if (stable === 'Closed_Fist') return this._fist(size, t);
    if (stable === 'Open_Palm') return this._rotate(lm, t);

    this._enter('idle');
    this.ui.setBadge('✋ دست را باز کنید');
  }

  _discrete(name, t) {
    const key = 'd:' + name;
    if (this.mode !== key) { this._enter(key); this.holdT0 = t; this.fired = false; }
    if (this.fired) { this.ui.setBadge(LABEL[name] + ' ✓'); return; }
    if (t - this.holdT0 >= DWELL_ACTION && t - this.lastFire > ACTION_COOLDOWN) {
      this.fired = true; this.lastFire = t;
      if (name === 'Victory') this.actions.toggleLayout();
      else if (name === 'Thumb_Up') this.actions.reset();
      else this.actions.toggleAuto();
      this.ui.setBadge(LABEL[name] + ' ✓');
    } else {
      const pct = Math.min(99, Math.round(((t - this.holdT0) / DWELL_ACTION) * 100));
      this.ui.setBadge(`${LABEL[name]} … ${pct.toLocaleString('fa-IR')}٪`);
    }
  }

  _pointer(pos, stable, pinchRise, t) {
    if (this.mode !== 'pointer') { this._enter('pointer'); }
    const sc = this.scene;
    const hover = sc.pickAt(pos.x, pos.y);
    sc.setHover(hover);
    let progress = 0;

    if (pinchRise) {
      if (hover >= 0) sc.select(hover);
    } else if (!this.pinch && stable === 'Pointing_Up' && hover >= 0 && hover !== sc.selected) {
      if (hover !== this.dwellIdx) { this.dwellIdx = hover; this.dwellT0 = t; this.dwellDone = false; }
      else if (!this.dwellDone) {
        progress = Math.min(1, (t - this.dwellT0) / DWELL_SELECT);
        if (progress >= 1) { sc.select(hover); this.dwellDone = true; }
      }
    } else if (hover !== this.dwellIdx) { this.dwellIdx = -1; this.dwellDone = false; }

    this.ui.cursor(pos.x, pos.y, { pinch: this.pinch, progress });
    this.ui.setBadge(this.pinch ? '👌 کلیک' : '☝️ نگه دارید تا انتخاب شود');
  }

  /** شست و اشاره را باز/بسته کنید: بازتر = زوم به داخل، بسته‌تر = زوم به بیرون. */
  _fingerZoom(lm, t) {
    const gap = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y) / handSize(lm);
    const current = this.f.fingerGap.filter(gap, t);
    if (this.mode !== 'finger-zoom' || !Number.isFinite(this.prevFingerGap)) {
      this._enter('finger-zoom');
      // _enter فیلترها را صفر می‌کند؛ فاصلهٔ شروع را از نو ثبت می‌کنیم تا زوم جهشی نباشد.
      this.prevFingerGap = this.f.fingerGap.filter(gap, t);
      this.ui.setBadge('🤏 زوم: شست و اشاره را باز و بسته کنید');
      return;
    }

    const previous = Math.max(this.prevFingerGap, 0.04);
    const ratio = current / previous;
    if (Math.abs(Math.log(Math.max(ratio, 1e-4))) > 0.008) {
      // محدودیت هر فریم حرکت را نرم می‌کند؛ باز شدن انگشت‌ها جدول را نزدیک می‌آورد.
      this.scene.zoomBy(clamp(Math.pow(1 / ratio, 1.45), 0.94, 1.06));
    }
    this.prevFingerGap = current;
    this.ui.setBadge('🤏 زوم: بازتر = نزدیک‌تر · بسته‌تر = دورتر');
  }

  /** مشت: نزدیک/دور کردن دست به دوربین = زوم */
  _fist(size, t) {
    const s = this.f.size.filter(size, t);
    if (this.mode !== 'fist') { this._enter('fist'); this.f.size.filter(size, t); this.prevSize = s; }
    else {
      const r = s / this.prevSize;
      if (Math.abs(Math.log(r)) > 0.006) this.scene.zoomBy(clamp(Math.pow(1 / r, 2.2), 0.9, 1.1));
      this.prevSize = s;
    }
    this.ui.setBadge('✊ زوم: دست را نزدیک/دور کنید');
  }

  /** کف دست باز: چرخش؛ اگر جدول زوم‌شده باشد: جابه‌جایی */
  _rotate(lm, t) {
    if (this.mode !== 'rotate') this._enter('rotate');
    const c = palmCenter(lm);
    const cx = this.f.cx.filter(1 - c.x, t);        // آینه‌ای: حرکت دست به راست = حرکت جدول به راست
    const cy = this.f.cy.filter(c.y, t);
    if (this.prev) {
      const dx = cx - this.prev.x, dy = cy - this.prev.y;
      if (Math.hypot(dx, dy) > 0.0012) {              // ناحیهٔ مرده
        if (this.scene.layout === 'table' && this.scene.isZoomedIn()) {
          this.scene.panBy(dx * innerWidth * 1.4, dy * innerHeight * 1.4);
        } else {
          this.scene.rotateBy(clamp(dx * 5, -0.25, 0.25), clamp(dy * 4, -0.25, 0.25));
        }
      }
    }
    this.prev = { x: cx, y: cy };
    this.ui.setBadge(this.scene.isZoomedIn() && this.scene.layout === 'table' ? '🖐️ جابه‌جایی' : '🖐️ چرخش');
  }

  /* ------------------------------ پیش‌نمایش دوربین ------------------------------ */
  _draw(hands) {
    const c = this.canvas, v = this.video;
    if (!v.videoWidth || !v.videoHeight) return;
    if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
      c.width = v.videoWidth;
      c.height = v.videoHeight;
    }
    this.ctx.clearRect(0, 0, c.width, c.height);
    const ctx = this.ctx;
    const color = this.pinch ? '#f472b6' : '#7dd3fc';
    for (const hand of hands) {
      const lm = hand.lm;
      if (!Array.isArray(lm) || lm.length < 21) continue;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(2, c.width / 240);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        ctx.moveTo(lm[a].x * c.width, lm[a].y * c.height);
        ctx.lineTo(lm[b].x * c.width, lm[b].y * c.height);
      }
      ctx.stroke();
      ctx.fillStyle = '#fff';
      const radius = Math.max(2, c.width / 200);
      for (const point of lm) {
        ctx.beginPath();
        ctx.arc(point.x * c.width, point.y * c.height, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = color;
      }
    }
  }
}

export function cameraErrorText(err) {
  switch (err?.name) {
    case 'NotAllowedError': case 'PermissionDeniedError':
      return 'اجازهٔ دوربین رد شد. از تنظیمات مرورگر، Camera را برای این صفحه Allow کنید.';
    case 'NotFoundError': case 'DevicesNotFoundError': return 'دوربینی پیدا نشد؛ اتصال دوربین و مجوز سیستم را بررسی کنید.';
    case 'NotReadableError': case 'TrackStartError': return 'دوربین در دسترس نیست یا توسط برنامهٔ دیگری استفاده می‌شود.';
    case 'OverconstrainedError': case 'ConstraintNotSatisfiedError': return 'تنظیمات انتخاب‌شده با دوربین سازگار نیست؛ یک دوربین دیگر را امتحان کنید.';
    case 'LoadTimeout': return 'بارگذاری مدل دست زمان‌بر شد. اتصال به cdn.jsdelivr.net را بررسی کنید؛ نسخهٔ جایگزین نیز از همین CDN بارگیری می‌شود.';
    case 'SecurityError': return 'دوربین فقط روی HTTPS یا localhost کار می‌کند.';
    default:
      if (!window.isSecureContext) return 'دوربین فقط روی HTTPS یا localhost کار می‌کند.';
      return 'بارگذاری مدل یا دوربین انجام نشد. اینترنت را بررسی کنید.';
  }
}

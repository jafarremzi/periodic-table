import { PeriodicScene } from './scene.js';
import { attachPointer } from './pointer.js';
import { createUI } from './ui.js';
import { HandController, cameraErrorText } from './hands.js';

const $ = id => document.getElementById(id);
const ui = createUI();
const stage = $('stage');

const scene = new PeriodicScene(stage, {
  onSelect: e => ui.showInfo(e),
  onLayout: l => ui.setLayout(l)
});
attachPointer(stage, scene);

// کنش‌های مشترک بین دکمه‌ها و ژست‌های دست
const actions = {
  toggleLayout() {
    const next = scene.layout === 'table' ? 'sphere' : 'table';
    scene.setLayout(next);
    ui.toast(next === 'table' ? 'حالت جدول' : 'حالت کره');
  },
  reset() { scene.resetView(); ui.toast('نما بازنشانی شد'); },
  toggleAuto() {
    scene.autoRotate = !scene.autoRotate;
    ui.setAuto(scene.autoRotate);
    ui.toast(scene.autoRotate ? 'چرخش خودکار روشن' : 'چرخش خودکار خاموش');
  }
};

$('btnTable').onclick = () => scene.setLayout('table');
$('btnSphere').onclick = () => scene.setLayout('sphere');
$('btnReset').onclick = actions.reset;
$('btnAuto').onclick = actions.toggleAuto;

// کنترل‌کننده محلی از قبل آماده است تا درخواست مجوز دوربین مستقیماً از کلیک کاربر آغاز شود.
const hands = new HandController({ scene, video: $('camVideo'), canvas: $('camCanvas'), ui, actions });
$('btnCamera').onclick = async () => {
  const btn = $('btnCamera');
  if (hands.running) { hands.stop(); return; }
  btn.disabled = true;
  try {
    await hands.start();
  } catch (err) {
    console.error(err);
    ui.toast(cameraErrorText(err), 8000);
    ui.setCameraState(false);
  } finally { btn.disabled = false; }
};

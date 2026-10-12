import { CATEGORY_FA, CATEGORY_COLOR } from './data.js';

const $ = id => document.getElementById(id);
const fa = n => Number(n).toLocaleString('fa-IR', { useGrouping: false });

export function createUI() {
  const info = $('info'), toastEl = $('toast'), cursorEl = $('cursor'), badge = $('badge');
  const cam = $('cam'), btnCam = $('btnCamera'), btnTable = $('btnTable'), btnSphere = $('btnSphere');
  const btnAuto = $('btnAuto');
  let toastTimer = 0;

  $('infoClose').onclick = () => info.classList.remove('open');
  const help = $('help');
  $('btnHelp').onclick = () => help.classList.add('open');
  help.addEventListener('click', () => help.classList.remove('open'));
  addEventListener('keydown', e => {
    if (e.key === 'Escape') { info.classList.remove('open'); help.classList.remove('open'); }
  });

  return {
    toast(msg, ms = 1800) {
      toastEl.textContent = msg;
      toastEl.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
    },
    showInfo(e) {
      $('infoNumber').textContent = fa(e.z);
      $('infoSymbol').textContent = e.symbol;
      $('infoName').textContent = e.name;
      const chip = $('infoCat');
      chip.textContent = CATEGORY_FA[e.cat];
      chip.style.background = CATEGORY_COLOR[e.cat];
      $('infoPeriod').textContent = fa(e.period);
      $('infoGroup').textContent = e.group ? fa(e.group) : '—';
      info.classList.add('open');
    },
    hideInfo() { info.classList.remove('open'); },
    setBadge(t) { if (badge.textContent !== t) badge.textContent = t; },
    cursor(x, y, s = {}) {
      if (x == null) { cursorEl.style.display = 'none'; return; }
      cursorEl.style.display = 'block';
      cursorEl.style.transform = `translate3d(${x}px,${y}px,0)`;
      cursorEl.classList.toggle('pinch', !!s.pinch);
      cursorEl.style.setProperty('--p', s.progress || 0);
    },
    setLayout(l) {
      btnTable.classList.toggle('active', l === 'table');
      btnSphere.classList.toggle('active', l === 'sphere');
    },
    setAuto(on) { btnAuto.classList.toggle('active', on); },
    setCameraState(on) {
      cam.classList.toggle('open', on);
      badge.classList.toggle('visible', on);
      btnCam.classList.toggle('active', on);
      btnCam.querySelector('.lb').textContent = on ? 'توقف دست' : 'کنترل دست';
    }
  };
}

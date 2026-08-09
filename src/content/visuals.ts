import { byId, state, type LayoutPreset, type LyricsAnchorY, type LyricsTextAlign } from './state';

interface MaskStyles {
  maskImage: string;
  webkitMaskImage: string;
  clipPath: string;
}

let layoutShiftTimer: number | null = null;

const NORMAL_LINE_MARGIN_EM = 0.42;
const CURRENT_LINE_MARGIN_EM = 1.1;
const CURRENT_LINE_SCALE = 1.15;

export interface LayoutPresetDefinition {
  x: number;
  y: number;
  textAlign: LyricsTextAlign;
  anchorY: LyricsAnchorY;
  label: string;
}

export const LAYOUT_PRESETS: Record<Exclude<LayoutPreset, 'custom'>, LayoutPresetDefinition> = {
  'top-left': { x: 3, y: 8, textAlign: 'left', anchorY: 'top', label: 'Top Left' },
  'top-center': { x: 50, y: 8, textAlign: 'center', anchorY: 'top', label: 'Top Center' },
  'top-right': { x: 97, y: 8, textAlign: 'right', anchorY: 'top', label: 'Top Right' },
  'middle-left': { x: 3, y: 50, textAlign: 'left', anchorY: 'center', label: 'Middle Left' },
  center: { x: 50, y: 50, textAlign: 'center', anchorY: 'center', label: 'Center' },
  'middle-right': { x: 97, y: 50, textAlign: 'right', anchorY: 'center', label: 'Middle Right' },
  'bottom-left': { x: 3, y: 92, textAlign: 'left', anchorY: 'bottom', label: 'Bottom Left' },
  'bottom-center': { x: 50, y: 92, textAlign: 'center', anchorY: 'bottom', label: 'Bottom Center' },
  'bottom-right': { x: 97, y: 92, textAlign: 'right', anchorY: 'bottom', label: 'Bottom Right' }
};

function getHorizontalTranslate() {
  if (state.userSettings.textAlign === 'left') return 0;
  if (state.userSettings.textAlign === 'right') return -100;
  return -50;
}

export function getLyricTransform(activeEl: HTMLElement | null = null, yOffset?: number) {
  let verticalOffset = yOffset ?? 0;

  if (activeEl && yOffset === undefined) {
    if (state.userSettings.anchorY === 'top') {
      verticalOffset = -activeEl.offsetTop;
    } else if (state.userSettings.anchorY === 'bottom') {
      verticalOffset = -(activeEl.offsetTop + activeEl.offsetHeight);
    } else {
      verticalOffset = -(activeEl.offsetTop + activeEl.offsetHeight / 2);
    }
  }

  return `translate(${getHorizontalTranslate()}%, ${verticalOffset}px)`;
}

export function updateQuickLayoutPadUI() {
  document.querySelectorAll<HTMLButtonElement>('.yl-layout-pad-btn').forEach((button) => {
    const isSelected = button.dataset.layout === state.userSettings.layoutPreset;
    button.classList.toggle('selected', isSelected);
    button.setAttribute('aria-pressed', String(isSelected));
  });

}

export function markLayoutCustom() {
  if (state.userSettings.layoutPreset === 'custom') return;
  state.userSettings.layoutPreset = 'custom';
  updateQuickLayoutPadUI();
}

export function positionPlateForActiveLine(plate: HTMLDivElement, activeEl: HTMLElement) {
  const xOffset = state.userSettings.textAlign === 'left'
    ? activeEl.offsetWidth / 2
    : state.userSettings.textAlign === 'right'
      ? -activeEl.offsetWidth / 2
      : 0;
  const yOffset = state.userSettings.anchorY === 'top'
    ? activeEl.offsetHeight / 2
    : state.userSettings.anchorY === 'bottom'
      ? -activeEl.offsetHeight / 2
      : 0;

  plate.style.left = `calc(${state.userSettings.horizontalPos}% + ${xOffset}px)`;
  plate.style.top = `calc(${state.userSettings.verticalPos}% + ${yOffset}px)`;
}

// オフセット表示は Dynamic Island 内の単一ラベルを更新するだけに絞る。
// 高頻度で更新される数値のため、DOM全体の再レンダリングを回避してパフォーマンスの低下を抑えるため。
export function updateIslandStatus() {
  const statusEl = byId<HTMLSpanElement>('yl-island-text');
  if (!statusEl) return;

  const sign = state.globalOffset > 0 ? '+' : '';
  statusEl.innerText = `${sign}${state.globalOffset.toFixed(1)}s`;

  if (state.globalOffset !== 0) {
    statusEl.classList.add('active');
  } else {
    statusEl.classList.remove('active');
    statusEl.style.color = '';
  }
}

// Visible Lines の badge は、スライダー上限を超える状態を "Max" に丸めて表示する。
// 内部的な制限解除フラグの数値をそのまま見せるより、ユーザーにとって直感的な「無制限」という表現にするため。
export function updateLinesBadge() {
  const el = byId<HTMLSpanElement>('yl-lines-val');
  if (!el) return;

  el.innerText = state.userSettings.visibleLines >= 10 ? 'Max' : String(state.userSettings.visibleLines);
}

export function updateBgModeButton() {
  const plateToggle = byId<HTMLButtonElement>('yl-plate-toggle');
  if (!plateToggle) return;

  const status = byId<HTMLSpanElement>('yl-plate-status');

  if (state.userSettings.bgMode === 'cinematic') {
    if (status) status.innerText = 'BG: Cinematic';
    plateToggle.style.background = 'rgba(175, 82, 222, 0.3)';
    plateToggle.style.color = '#fff';
  } else if (state.userSettings.bgMode === 'plate') {
    if (status) status.innerText = 'BG: Plate';
    plateToggle.style.background = 'rgba(10, 132, 255, 0.3)';
    plateToggle.style.color = '#fff';
  } else {
    if (status) status.innerText = 'BG: Off';
    plateToggle.style.background = '';
    plateToggle.style.color = '';
  }
}

export function updateSettingsModalUI() {
  const linesSlider = byId<HTMLInputElement>('yl-lines-slider');
  if (linesSlider) {
    // 内部値 100 は「Max」を意味するが、UI スライダー上は 10 に丸めて扱う。
    linesSlider.value = String(state.userSettings.visibleLines >= 10 ? 10 : state.userSettings.visibleLines);
  }

  const fontSlider = byId<HTMLInputElement>('yl-font-slider');
  if (fontSlider) {
    fontSlider.value = String(state.userSettings.fontSize || 28);
  }

  const lineHeightSlider = byId<HTMLInputElement>('yl-lh-slider');
  if (lineHeightSlider) {
    lineHeightSlider.value = String(state.userSettings.lineHeight || 140);
  }

  updateLinesBadge();
  updateBgModeButton();
  updateQuickLayoutPadUI();
}

function getMaskStyles(): MaskStyles {
  const lines = state.userSettings.visibleLines;
  if (lines >= 15) {
    return {
      maskImage: 'none',
      webkitMaskImage: 'none',
      clipPath: 'none'
    };
  }

  const center = parseFloat(String(state.userSettings.verticalPos));
  const container = byId<HTMLDivElement>('yl-container');
  const wrapper = byId<HTMLDivElement>('yl-scroll-wrapper');
  const line = wrapper?.querySelector<HTMLDivElement>('.yl-line') || null;
  const containerHeight = container?.getBoundingClientRect().height || 0;
  const fontSizePx = line ? parseFloat(window.getComputedStyle(line).fontSize) : 0;
  const lineHeightValue = Number(state.userSettings.lineHeight || 140) / 100;
  const safeLines = Math.max(1, lines);
  const maskScale = Math.max(0.34, safeLines / 3);
  const maskLines = safeLines / 3;
  const fallbackSpread = maskLines * 7;

  let spread = fallbackSpread;
  let fade = 5;

  if (containerHeight > 0 && fontSizePx > 0) {
    const normalLineHeight = fontSizePx * lineHeightValue + fontSizePx * NORMAL_LINE_MARGIN_EM * 2;
    const currentLineHeight = fontSizePx * lineHeightValue * CURRENT_LINE_SCALE + fontSizePx * CURRENT_LINE_MARGIN_EM * 2;
    const visibleHeightPx = currentLineHeight * maskScale + Math.max(0, maskLines - 1) * normalLineHeight;

    spread = Math.min(100, (visibleHeightPx / containerHeight) * 100);
    fade = Math.min(12, Math.max(3, (normalLineHeight * 0.65 / containerHeight) * 100));
  }

  let topStop = center - spread / 2;
  let bottomStop = center + spread / 2;
  if (state.userSettings.anchorY === 'top') {
    topStop = center;
    bottomStop = center + spread;
  } else if (state.userSettings.anchorY === 'bottom') {
    topStop = center - spread;
    bottomStop = center;
  }
  const gradient = `linear-gradient(to bottom,
    transparent ${Math.max(0, topStop - fade)}%,
    black ${Math.max(0, topStop)}%,
    black ${Math.min(100, bottomStop)}%,
    transparent ${Math.min(100, bottomStop + fade)}%
  )`;
  const clipTop = Math.max(0, topStop - fade);
  const clipBottom = 100 - Math.min(100, bottomStop + fade);

  return {
    maskImage: gradient,
    webkitMaskImage: gradient,
    clipPath: `inset(${clipTop}% 0 ${clipBottom}% 0)`
  };
}

export function clearMaskLayer(maskLayer: HTMLDivElement | null) {
  if (!maskLayer) return;

  maskLayer.style.maskImage = 'none';
  maskLayer.style.webkitMaskImage = 'none';
  maskLayer.style.clipPath = 'none';
}

export function applyMaskLayer(maskLayer: HTMLDivElement | null) {
  if (!maskLayer) return;

  const styles = getMaskStyles();
  maskLayer.style.maskImage = styles.maskImage;
  maskLayer.style.webkitMaskImage = styles.webkitMaskImage;
  maskLayer.style.clipPath = styles.clipPath;
}

// 見た目に関する設定は wrapper / plate / mask を同じタイミングで更新する。
// フォントと背景板が別々のタイミングでリフローされると、UI全体が一瞬崩れて明滅するような視覚的ノイズを避けるため。
export function applyVisualSettings() {
  const wrapper = byId<HTMLDivElement>('yl-scroll-wrapper');
  const maskLayer = byId<HTMLDivElement>('yl-mask-layer');
  const plate = byId<HTMLDivElement>('yl-bg-plate');

  if (wrapper) {
    // 座標とタイポグラフィ系の CSS 変数は wrapper に集約し、各行へ継承させる。
    wrapper.style.top = `${state.userSettings.verticalPos}%`;
    wrapper.style.left = `${state.userSettings.horizontalPos}%`;
    wrapper.style.alignItems = state.userSettings.textAlign === 'left'
      ? 'flex-start'
      : state.userSettings.textAlign === 'right'
        ? 'flex-end'
        : 'center';
    wrapper.style.transform = getLyricTransform(wrapper.querySelector<HTMLElement>('.yl-line.current'));
    wrapper.dataset.textAlign = state.userSettings.textAlign;
    wrapper.dataset.anchorY = state.userSettings.anchorY;
    wrapper.style.setProperty('--yl-base-font-size', String(state.userSettings.fontSize));

    const lineHeightValue = Number(state.userSettings.lineHeight || 140) / 100;
    wrapper.style.setProperty('--yl-line-height', String(lineHeightValue));

    const fontMap: Record<string, string> = {
        standard: 'var(--yl-font-standard)',
        serif: 'var(--yl-font-serif)',
        antique: 'var(--yl-font-antique)',
        rounded: 'var(--yl-font-rounded)',
        hachi: 'var(--yl-font-hachi)',
        dot: 'var(--yl-font-dot)',
        rampart: 'var(--yl-font-rampart)',
        kurenaido: 'var(--yl-font-kurenaido)'
      };

    // fontFamily の文字列は state 上の列挙値で持ち、実際のフォントスタックだけここで解決する。
    wrapper.style.setProperty('--yl-font-current', fontMap[state.userSettings.fontFamily || 'serif']);
  }

  const container = byId<HTMLDivElement>('yl-container');
  if (container) {
    container.classList.toggle('cinematic-bg', state.userSettings.bgMode === 'cinematic');
  }

  document.querySelectorAll<HTMLElement>('.yl-line').forEach((line) => {
    line.style.textAlign = state.userSettings.textAlign;
    line.style.transformOrigin = `${state.userSettings.textAlign} center`;
  });

  if (plate) {
    if (state.userSettings.bgMode === 'plate') {
      // プレートの座標は wrapper と常に同期させ、サイズだけ同期ループ側で現在行に追従させる。
      plate.classList.add('visible');
      plate.style.top = `${state.userSettings.verticalPos}%`;
      plate.style.left = `${state.userSettings.horizontalPos}%`;
      plate.style.opacity = '1';

      if (!plate.style.width) {
        plate.style.width = '200px';
        plate.style.height = '100px';
      }
    } else {
      // 非表示時はサイズを温存し、再表示時の初回計算前でも見た目が破綻しないようにする。
      plate.classList.remove('visible');
      plate.style.opacity = '0';
    }
  }

  applyMaskLayer(maskLayer);
}

export function beginLayoutShift() {
  const container = byId<HTMLDivElement>('yl-container');
  if (!container) return;

  container.classList.add('yl-layout-shifting');

  if (layoutShiftTimer) window.clearTimeout(layoutShiftTimer);

  // 操作やリサイズが止まってから150ms後にアニメーションを復帰させる
  layoutShiftTimer = window.setTimeout(() => {
    container.classList.remove('yl-layout-shifting');
  }, 150);
}

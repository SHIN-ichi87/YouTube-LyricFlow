import { render } from 'preact';

import { byId, state, type DropdownContainerElement, type DropdownOption, type OutsideClickBinding } from './state';
import { DynamicIslandMarkup, EditorMarkup, ModeSelectorMarkup, SettingsModalMarkup } from './markup';
import { applyVisualSettings, beginLayoutShift, updateBgModeButton, updateLinesBadge, updateSettingsModalUI } from './visuals';
import { adjustOffset, setupDragAndDrop, setupDraggable, setupInteractionEvents, setupKeyboardEvents, showToast, stampCurrentTime } from './interactions';
import { checkIsMusicVideo, startTimedTextObserver, tryAutoImportCaptions, updateTrackListUI } from './captions';
import { cleanUpStorage, downloadLRC, loadLyricsFromStorage, loadSettings, loadLyricsFromText, saveLyricsToStorage, saveSettings } from './lyrics';

const SVG_NS = 'http://www.w3.org/2000/svg';

function runUiCleanup() {
  // すでに実行済みのクリーンアップ関数を再度呼ばないよう、配列を空にしつつ取得する。
  const cleanupFns = state.uiCleanupFns.splice(0);
  cleanupFns.forEach((cleanup) => cleanup());
  state.outsideClickBindings = [];
  state.isEditorOpen = false;
  state.isSettingsOpen = false;
}

function registerUiCleanup(cleanup: () => void) {
  state.uiCleanupFns.push(cleanup);
}

function registerOutsideClick(root: HTMLElement, onOutsideClick: () => void) {
  // メニューやモーダルの外側をクリックした時に閉じる共通処理を登録する。
  const binding: OutsideClickBinding = { root, onOutsideClick };
  state.outsideClickBindings.push(binding);

  return () => {
    state.outsideClickBindings = state.outsideClickBindings.filter((entry) => entry !== binding);
  };
}

function setupOutsideClickHandler() {
  const onDocumentClick = (event: MouseEvent) => {
    // クリックされた対象がDOMツリー内に存在しない（削除された要素など）場合は無視する。
    const target = event.target;
    if (!(target instanceof Node)) return;

    state.outsideClickBindings = state.outsideClickBindings.filter((binding) => binding.root.isConnected);
    state.outsideClickBindings.forEach((binding) => {
      if (!binding.root.contains(target)) {
        binding.onOutsideClick();
      }
    });
  };

  document.addEventListener('click', onDocumentClick);
  return () => document.removeEventListener('click', onDocumentClick);
}

function closeOpenDropdowns(except: HTMLElement | null = null) {
  // 複数のドロップダウンが同時に開いたままになるのを防ぐため、指定の要素以外をすべて閉じる。
  document.querySelectorAll<HTMLDivElement>('.yl-select-options.open').forEach((element) => {
    if (element !== except) element.classList.remove('open');
  });
}

function createSvgElement<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string> = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
}

function createMusicNoteIcon(isDoubleNote = false, size = 24) {
  const svg = createSvgElement('svg', {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2.5',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    width: String(size),
    height: String(size)
  });

  if (isDoubleNote) {
    svg.append(
      createSvgElement('path', { d: 'M9 18V5l12-2v13' }),
      createSvgElement('circle', { cx: '6', cy: '18', r: '3' }),
      createSvgElement('circle', { cx: '18', cy: '16', r: '3' })
    );
  } else {
    svg.append(
      createSvgElement('path', { d: 'M9 18V5V3a2 2 0 012-2h4a2 2 0 012 2v3a2 2 0 01-1.18 1.82L11 10.3' }),
      createSvgElement('circle', { cx: '6', cy: '18', r: '3' })
    );
  }

  return svg;
}

function createChevronIcon(size = 12) {
  const svg = createSvgElement('svg', {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    width: String(size),
    height: String(size)
  });
  svg.append(createSvgElement('path', { d: 'M6 9l6 6 6-6' }));
  return svg;
}

function createLyricsContainer() {
  const container = document.createElement('div');
  container.id = 'yl-container';

  const plate = document.createElement('div');
  plate.id = 'yl-bg-plate';

  const maskLayer = document.createElement('div');
  maskLayer.id = 'yl-mask-layer';

  const scrollWrapper = document.createElement('div');
  scrollWrapper.id = 'yl-scroll-wrapper';
  maskLayer.append(scrollWrapper);

  const dropZone = document.createElement('div');
  dropZone.id = 'yl-drop-zone';
  dropZone.textContent = 'Drop LRC File Here';

  container.append(plate, maskLayer, dropZone);
  return container;
}

function createToggleButton() {
  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'yl-toggle-btn';
  toggleBtn.append(createMusicNoteIcon(true, 16));

  const label = document.createElement('span');
  label.id = 'yl-btn-label';
  label.textContent = 'Lyrics';
  toggleBtn.append(label);

  return toggleBtn;
}

// Dynamic Island と Mode Selector は横並びのため、ラベル変更時に FLIP でズレを吸収する。
// 文字数の異なるモード名に切り替えた際、隣接するUI要素がカクッと瞬時にワープして不格好に見えるのを防ぐため。
function animateTopControlsLayout(firstRects: Map<Element, DOMRect> | null = null) {
  const container = byId<HTMLDivElement>('yl-top-controls');
  if (!container) return;

  const children = Array.from(container.children);
  const baseRects = firstRects || new Map(children.map((el) => [el, el.getBoundingClientRect()]));

  requestAnimationFrame(() => {
    children.forEach((el) => {
      const first = baseRects.get(el);
      if (!first) return;

      const last = el.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;

      if (dx === 0 && dy === 0) return;

      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], {
        duration: 320,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
      });
    });
  });
}

// 設定モーダルは overflow の切り替えを遅らせ、開閉アニメーション中のはみ出しを防ぐ。
// トランジション中に内部の要素が枠を飛び出したり、一瞬だけスクロールバーが見えてしまう視覚上のグリッチを避けるため。
export function toggleSettingsModal() {
  const modal = byId<HTMLDivElement>('yl-settings-modal');
  if (!modal) return;

  const willOpen = !modal.classList.contains('active');

  if (willOpen) {
    modal.style.overflow = 'hidden';
    modal.classList.add('active');
    state.isSettingsOpen = true;

    if (state.settingsOverflowTimer) window.clearTimeout(state.settingsOverflowTimer);
    state.settingsOverflowTimer = window.setTimeout(() => {
      if (modal.classList.contains('active')) {
        modal.style.overflow = 'visible';
      }
    }, 400);
  } else {
    modal.style.overflow = 'hidden';
    if (state.settingsOverflowTimer) window.clearTimeout(state.settingsOverflowTimer);

    modal.classList.remove('active');
    state.isSettingsOpen = false;

    window.setTimeout(() => {
      if (!modal.classList.contains('active')) {
        modal.style.top = '';
        modal.style.left = '';
        modal.style.right = '';
        modal.style.bottom = '';
        modal.style.transform = '';
        modal.style.margin = '';
      }
    }, 400);
  }
}

// エディタを閉じるときは、ドラッグ後の絶対配置や開きっぱなしの UI も一緒に戻す。
// 次に開いた時にエディタが画面外に吹き飛んだままになったり、不要なサブメニューが出っ放しになる不具合を事前にリセットするため。
export function toggleEditor() {
  const editor = byId<HTMLDivElement>('yl-editor');
  if (!editor) return;

  editor.classList.toggle('active');
  state.isEditorOpen = editor.classList.contains('active');

  if (state.isEditorOpen) {
    const modeSelector = byId<HTMLDivElement>('yl-mode-selector');
    if (modeSelector?.classList.contains('active')) {
      modeSelector.classList.remove('active');
    }
  }

  if (!state.isEditorOpen) {
    window.setTimeout(() => {
      if (!editor.classList.contains('active')) {
        editor.style.top = '';
        editor.style.left = '';
        editor.style.right = '';
        editor.style.bottom = '';
        editor.style.transform = '';
        editor.style.margin = '';
      }
    }, 300);

    const modal = byId<HTMLDivElement>('yl-settings-modal');
    if (modal?.classList.contains('active')) {
      toggleSettingsModal();
    }

    closeOpenDropdowns();
  }
}

// ON/OFF は表示制御だけでなく、YouTube SPA 上での復帰ラベルもここで統一する。
// DOMの表示と非表示をバラバラに行うと、動画切り替え時にボタンの文字と実際の状態がズレるなど、状態の不整合が起きやすいため。
export function setAppPower(isOn: boolean, isManualAction: boolean = false) {
  state.userSettings.isEnabled = isOn;
  if (isManualAction) {
    state.userSettings.isManuallyDisabled = !isOn;
  }
  saveSettings();

  const uiRoot = byId<HTMLDivElement>('yl-ui');
  const btnLabel = byId<HTMLSpanElement>('yl-btn-label');
  const container = byId<HTMLDivElement>('yl-container');
  const island = byId<HTMLDivElement>('yl-island');

  if (isOn) {
    uiRoot?.classList.remove('yl-app-disabled');
    if (container) container.style.display = '';
    if (btnLabel) btnLabel.innerText = 'Lyrics';
    //showToast('Lyrics Studio: Started');
  } else {
    const toggleBtn = byId<HTMLButtonElement>('yl-toggle-btn');
    if (toggleBtn) toggleBtn.classList.remove('turning-on');
    // 展開状態のまま全体をフェードさせると、幅収縮と opacity 変化が競合して島だけガタつく。
    // 先に閉じ状態へ戻し、次フレームでオフ用の退場アニメーションへ移る。
    island?.classList.remove('is-open');

    if (container) container.style.display = 'none';

    const modeSelector = byId<HTMLDivElement>('yl-mode-selector');
    if (modeSelector) modeSelector.classList.remove('active');
    if (state.isEditorOpen) toggleEditor();
    closeOpenDropdowns();

    window.requestAnimationFrame(() => {
      if (!state.userSettings.isEnabled) {
        uiRoot?.classList.add('yl-app-disabled');
      }
    });

    //showToast('Lyrics Studio: Off');
  }
}

// ネイティブ select の代わりに、基準版どおりのアニメ付きドロップダウンを組み立てる。
// ネイティブの<select>要素はOS依存のデザインになりCSSでの柔軟なアニメーション制御が不可能なため。
function createCustomDropdown(
  label: string | null,
  id: string,
  options: DropdownOption[],
  onChange: (value: string) => void,
  initialValue: string | null = null
) {
  const container = document.createElement('div') as DropdownContainerElement;
  container.className = 'yl-dropdown-container';

  if (!label) {
    container.style.marginBottom = '0';
  }

  if (label) {
    const labelEl = document.createElement('div');
    labelEl.className = 'yl-dropdown-label';
    labelEl.innerText = label;
    container.appendChild(labelEl);
  }

  const selectEl = document.createElement('div');
  selectEl.className = 'yl-custom-select';
  selectEl.id = id;
  let selectedValue = initialValue;

  let displayText = 'Select...';
  if (initialValue) {
    const found = options.find((option) => option.value === initialValue);
    if (found) displayText = found.label;
  }

  const currentValue = document.createElement('span');
  currentValue.className = 'current-val';
  currentValue.textContent = displayText;
  selectEl.append(currentValue, createChevronIcon());

  const optionsEl = document.createElement('div');
  optionsEl.className = 'yl-select-options';

  const renderOptions = (currentOptions: DropdownOption[]) => {
    const highlightEl = document.createElement('div');
    highlightEl.className = 'yl-option-highlight';
    optionsEl.replaceChildren(highlightEl);

    currentOptions.forEach((option) => {
      const optionDiv = document.createElement('div');
      optionDiv.className = 'yl-option';
      optionDiv.dataset.value = option.value;

      const labelSpan = document.createElement('span');
      labelSpan.textContent = option.label;
      const checkSpan = document.createElement('span');
      checkSpan.className = 'yl-option-check';
      checkSpan.textContent = '✓';
      optionDiv.append(labelSpan, checkSpan);

      if (selectedValue === option.value) {
        optionDiv.classList.add('selected');
      }

      optionDiv.addEventListener('mouseenter', () => {
        highlightEl.style.opacity = '1';
        highlightEl.style.transform = `translateY(${optionDiv.offsetTop}px)`;
        highlightEl.style.height = `${optionDiv.offsetHeight}px`;
      });

      optionDiv.onclick = (event) => {
        event.stopPropagation();
        onChange(option.value);
        selectedValue = option.value;

        currentValue.innerText = option.label;

        optionsEl.querySelectorAll('.yl-option').forEach((element) => element.classList.remove('selected'));
        optionDiv.classList.add('selected');
        optionsEl.classList.remove('open');
        highlightEl.style.opacity = '0';
      };

      optionsEl.appendChild(optionDiv);
    });

    optionsEl.onmouseleave = () => {
      highlightEl.style.opacity = '0';
    };
  };

  renderOptions(options);

  selectEl.onclick = (event) => {
    event.stopPropagation();

    closeOpenDropdowns(optionsEl);

    const playerContainer = byId<HTMLDivElement>('yl-container');
    if (playerContainer) {
      const containerRect = playerContainer.getBoundingClientRect();
      const selectRect = selectEl.getBoundingClientRect();
      optionsEl.classList.toggle('drop-up', containerRect.bottom - selectRect.bottom < 250);
    }

    optionsEl.classList.toggle('open');
  };
  registerUiCleanup(registerOutsideClick(container, () => optionsEl.classList.remove('open')));

  container.appendChild(selectEl);
  container.appendChild(optionsEl);
  container.updateOptions = renderOptions;
  container.setValue = (value: string) => {
    selectedValue = value;
    const found = options.find((option) => option.value === value);
    currentValue.innerText = found?.label || 'Select...';
    renderOptions(options);
  };

  return container;
}

// 言語選択 UI は保存即反映にし、選択変更時は常に字幕の自動再取り込みを試みる。
// ユーザーが言語設定を変えた瞬間に古い言語の歌詞が見え続けると混乱するため、即座に字幕のフェッチと再構築を走らせる。
function renderLanguageControls() {
  const wrapper = byId<HTMLDivElement>('yl-lang-controls');
  if (!wrapper) return;

  wrapper.replaceChildren();

  wrapper.appendChild(
    createCustomDropdown('Primary Lyrics (Source)', 'yl-primary-select', [{ label: 'Auto (Follow Video)', value: 'auto' }], (value) => {
      state.userSettings.primaryLang = value;
      saveSettings();
      void tryAutoImportCaptions(true);
    })
  );

  wrapper.appendChild(
    createCustomDropdown(
      'Secondary Lyrics (Translation)',
      'yl-secondary-select',
      [
        { label: 'None', value: 'none' },
        { label: 'Japanese', value: 'ja' },
        { label: 'English', value: 'en' },
        { label: 'Korean', value: 'ko' },
        { label: 'Chinese (Simp)', value: 'zh-Hans' },
        { label: 'Spanish', value: 'es' },
        { label: 'French', value: 'fr' }
      ],
      (value) => {
        state.userSettings.secondaryLang = value;
        saveSettings();
        void tryAutoImportCaptions(true);
      }
    )
  );
}

// Dynamic Island のボタン配線は Preact の静的マークアップに後付けする。
function createDynamicIsland() {
  const host = document.createElement('div');
  render(<DynamicIslandMarkup />, host);
  const island = host.firstElementChild as HTMLDivElement | null;
  if (!island) return host;

  // island 内の各ボタンは親へ伝播させると別 UI が開くため、すべて stopPropagation 前提。
  // Dynamic Island自体に「ホバー／クリックで開く」判定があるため、子ボタンのクリックが親に伝わると予期せぬ挙動になる。
  island.querySelector<HTMLButtonElement>('#yl-power-off-btn')!.onclick = (event) => {
    event.stopPropagation();
    setAppPower(false, true);
  };

  island.querySelector<HTMLButtonElement>('#yl-island-toggle')!.onclick = (event) => {
    event.stopPropagation();
    toggleSettingsModal();
  };

  island.querySelector<HTMLButtonElement>('#yl-island-minus')!.onclick = (event) => {
    event.stopPropagation();
    adjustOffset(-0.1);
  };

  island.querySelector<HTMLButtonElement>('#yl-island-plus')!.onclick = (event) => {
    event.stopPropagation();
    adjustOffset(0.1);
  };

  island.querySelector<HTMLButtonElement>('#yl-island-sync')!.onclick = (event) => {
    event.stopPropagation();
    stampCurrentTime();

    // 成功時はトーストではなく、ボタン自身の色変化で即時フィードバックを返す。
    // 同期ボタンは頻繁に押される可能性が高いため、その都度トーストが画面を塞ぐと体験を損なうと判断したため。
    const btn = event.currentTarget as HTMLButtonElement;
    btn.style.color = '#0A84FF';
    window.setTimeout(() => {
      btn.style.color = '';
    }, 300);
  };

  return island;
}

// 設定モーダルは各ボタンが state.userSettings を直接更新する基準版構成を踏襲する。
function createSettingsModal(root: HTMLElement) {
  const modal = document.createElement('div');
  modal.id = 'yl-settings-modal';
  root.appendChild(modal);
  render(<SettingsModalMarkup />, modal);

  // モーダルはヘッダー部分だけを持ち手にし、フォーム操作との競合を避ける。
  // モーダル全体をドラッグ領域にすると、スライダーやテキスト入力欄を触ろうとした際にも誤ってドラッグが発動してしまうため。
  setupDraggable(modal, modal.querySelector<HTMLElement>('.yl-modal-header'));

  const fontWrapper = modal.querySelector<HTMLDivElement>('#yl-font-custom-wrapper');
  let fontDropdown: DropdownContainerElement | null = null;
  if (fontWrapper) {
    // Appearance のフォント選択だけは汎用 dropdown を再利用して見た目を統一する。
    fontDropdown = createCustomDropdown(
      null,
      'yl-font-select-custom',
      [
        { label: 'Rounded (Soft)', value: 'rounded' },
        { label: 'Standard (Modern)', value: 'standard' },
        { label: 'Serif (Cinema)', value: 'serif' },
        { label: 'Mono (Code)', value: 'mono' }
      ],
      (value) => {
        state.userSettings.fontFamily = value as typeof state.userSettings.fontFamily;
        applyVisualSettings();
        saveSettings();
      },
      state.userSettings.fontFamily || 'serif'
    );
    fontWrapper.appendChild(fontDropdown);
  }

  // Reset 群は slider の見た目値と state の内部値を同時に戻す必要がある。
  // 状態(state)だけ変更しても、非コントロールであるスライダー(input)の表示位置は自動同期されないため手動適応が必要。
  byId<HTMLButtonElement>('yl-reset-lines-btn')!.onclick = () => {
    state.userSettings.visibleLines = 3;
    const slider = byId<HTMLInputElement>('yl-lines-slider');
    if (slider) slider.value = '3';
    updateLinesBadge();
    applyVisualSettings();
    saveSettings();
  };

  const plateToggle = byId<HTMLButtonElement>('yl-plate-toggle');
  updateBgModeButton();

  if (plateToggle) {
    plateToggle.onclick = () => {
      if (state.userSettings.bgMode === 'none') {
        state.userSettings.bgMode = 'plate';
      } else if (state.userSettings.bgMode === 'plate') {
        state.userSettings.bgMode = 'cinematic';
      } else {
        state.userSettings.bgMode = 'none';
      }

      updateBgModeButton();
      applyVisualSettings();
      saveSettings();
    };
  }

  byId<HTMLButtonElement>('yl-reset-appearance-btn')!.onclick = () => {
    state.userSettings.fontFamily = 'serif';
    state.userSettings.bgMode = 'none';
    fontDropdown?.setValue?.('serif');
    updateBgModeButton();
    applyVisualSettings();
    saveSettings();
    showToast('Appearance Reset');
  };

  byId<HTMLButtonElement>('yl-close-settings-btn')!.onclick = toggleSettingsModal;
  byId<HTMLInputElement>('yl-lines-slider')!.oninput = (event) => {
    beginLayoutShift();
    const value = parseInt((event.target as HTMLInputElement).value, 10);
    // UI 上の 10 は「100 行」ではなく Max を表す内部値 100 に変換する。
    // 10という数値をそのまま行数制約に使うのではなく、事実上「無制限に表示」という特殊フラグとして予約しているため。
    state.userSettings.visibleLines = value === 10 ? 100 : value;
    updateLinesBadge();
    applyVisualSettings();
    saveSettings();
  };

  byId<HTMLButtonElement>('yl-reset-v-btn')!.onclick = () => {
    state.userSettings.verticalPos = 50;
    const positionSlider = byId<HTMLInputElement>('yl-pos-slider');
    if (positionSlider) positionSlider.value = '50';
    applyVisualSettings();
    saveSettings();
    showToast('Vertical Position Reset');
  };

  byId<HTMLButtonElement>('yl-reset-h-btn')!.onclick = () => {
    state.userSettings.horizontalPos = 50;
    applyVisualSettings();
    saveSettings();
    showToast('Horizontal Position Reset');
  };

  byId<HTMLButtonElement>('yl-reset-position-btn')!.onclick = () => {
    state.userSettings.verticalPos = 50;
    state.userSettings.horizontalPos = 50;
    const positionSlider = byId<HTMLInputElement>('yl-pos-slider');
    if (positionSlider) positionSlider.value = '50';
    applyVisualSettings();
    saveSettings();
    showToast('Position Reset');
  };

  byId<HTMLButtonElement>('yl-close-all-btn')!.onclick = () => {
    // Close All は editor / settings / dropdown / mode menu を一度に閉じる最終退避操作。
    // 「画面がごちゃごちゃした時にリセットしたい」というユーザーの要望に応えるための緊急パニックボタンとしての役割。
    if (state.isSettingsOpen) toggleSettingsModal();
    if (state.isEditorOpen) toggleEditor();

    const modeSelector = byId<HTMLDivElement>('yl-mode-selector');
    if (modeSelector) modeSelector.classList.remove('active');

    closeOpenDropdowns();
  };
}

// 音符パーティクルは視覚効果専用で、選択状態や同期ロジックには影響させない。
export function spawnFloatingNotes(sourceEl: HTMLElement) {
  const rect = sourceEl.getBoundingClientRect();

  for (let i = 0; i < 3; i += 1) {
    const note = document.createElement('div');
    note.className = `yl-floating-note yl-note-anim-${i + 1}`;
    note.append(createMusicNoteIcon(i === 1));

    const radii = [83, 89, 108];
    const radius = radii[i];
    const angleDeg = Math.random() * 60 + 15;
    const angleRad = angleDeg * (Math.PI / 180);
    const rotation = `${([25, 45, -20][i] + (Math.random() * 20 - 10)).toFixed(1)}deg`;

    note.style.setProperty('--note-tx', `${(radius * Math.cos(angleRad)).toFixed(1)}px`);
    note.style.setProperty('--note-ty', `${(-radius * Math.sin(angleRad)).toFixed(1)}px`);
    note.style.setProperty('--note-rot', rotation);
    note.style.left = `${rect.left + rect.width / 2}px`;
    note.style.top = `${rect.top + rect.height / 2}px`;

    document.body.appendChild(note);
    window.setTimeout(() => note.remove(), 1600);
  }
}

// プレイヤー直下に必要な DOM を一度だけ差し込み、YouTube の DOM 再構築にも耐える形にする。
// YouTubeは動画遷移時に動画プレイヤー周辺のDOMを激しく書き換えるため、拡張機能のUIが消滅してしまうのを防ぐ防波堤。
export function initUI() {
  const player =
    document.querySelector<HTMLElement>('.html5-video-player') ||
    byId<HTMLElement>('movie_player') ||
    document.querySelector('video')?.parentElement;

  if (!player) return;

  const existingContainer = byId<HTMLDivElement>('yl-container');
  const existingUiRoot = byId<HTMLDivElement>('yl-ui');
  const needsRebuild =
    !existingContainer ||
    !existingUiRoot ||
    existingContainer.parentElement !== player ||
    existingUiRoot.parentElement !== player;

  if (!needsRebuild) return;

  runUiCleanup();
  existingContainer?.remove();
  existingUiRoot?.remove();

  // 歌詞表示コンテナ本体。mask / plate / drop zone は最初に同時生成しておく。
  const container = createLyricsContainer();
  player.appendChild(container);

  const uiRoot = document.createElement('div');
  uiRoot.id = 'yl-ui';
  player.appendChild(uiRoot);
  registerUiCleanup(setupOutsideClickHandler());

  // toast は他 UI より前面の固定レイヤーとして先に差し込む。
  // DOMの挿入順序を工夫することで、巨大なz-indexを使わずとも自然に要素が上になるようにし、予期せぬ表示重なりを防ぐ。
  const toast = document.createElement('div');
  toast.id = 'yl-offset-toast';
  uiRoot.appendChild(toast);

  const toggleBtn = createToggleButton();
  toggleBtn.onclick = () => {
    if (!state.userSettings.isEnabled) {
      toggleBtn.classList.add('turning-on');
      setAppPower(true, true);
    } else {
      toggleEditor();
    }
  };

  toggleBtn.addEventListener('mouseleave', () => {
    toggleBtn.classList.remove('turning-on');
  });

  uiRoot.appendChild(toggleBtn);

  // 右上補助 UI 群は topControls にまとめ、横並びアニメーションの対象にする。
  const topControls = document.createElement('div');
  topControls.id = 'yl-top-controls';
  uiRoot.appendChild(topControls);

  const island = createDynamicIsland();
  const islandZone = document.createElement('div');
  islandZone.id = 'yl-island-zone';
  islandZone.appendChild(island);
  topControls.appendChild(islandZone);

  // 開く判定は島本体、閉じる判定は広い islandZone に分けて hover ミスを減らす。
  island.addEventListener('mouseenter', () => island.classList.add('is-open'));
  islandZone.addEventListener('mouseleave', () => island.classList.remove('is-open'));

  const modeSelector = document.createElement('div');
  modeSelector.id = 'yl-mode-selector';
  render(<ModeSelectorMarkup />, modeSelector);
  topControls.appendChild(modeSelector);

  // 音符経由で開いた場合だけ note-active を残し、色味の状態も基準版と揃える。
  const toggleMenu = (isNoteTrigger = false) => {
    const willOpen = !modeSelector.classList.contains('active');

    if (willOpen) {
      // モードメニューは editor や dropdown と競合するため、開く前に他 UI を閉じる。
      if (state.isEditorOpen) toggleEditor();
      closeOpenDropdowns();
      modeSelector.classList.toggle('note-active', isNoteTrigger);
    } else {
      modeSelector.classList.remove('note-active');
    }

    modeSelector.classList.toggle('active');
  };

  modeSelector.querySelector<HTMLElement>('#yl-music-note-btn')!.onclick = (event) => {
    event.stopPropagation();
    // 音符ボタン経由では演出を出したうえで note-active 色も有効にする。
    spawnFloatingNotes(modeSelector.querySelector<HTMLElement>('#yl-music-note-btn')!);
    toggleMenu(true);
  };

  modeSelector.querySelector<HTMLElement>('#yl-mode-toggle')!.onclick = (event) => {
    event.stopPropagation();
    toggleMenu(false);
  };
  registerUiCleanup(
    registerOutsideClick(modeSelector, () => {
      modeSelector.classList.remove('active');
      modeSelector.classList.remove('note-active');
    })
  );

  modeSelector.querySelectorAll<HTMLDivElement>('.yl-mode-option').forEach((option) => {
    option.onclick = (event) => {
      event.stopPropagation();

      // 現時点では実機能切り替えは無く、見た目の selected / label だけを同期する。
      modeSelector.querySelectorAll('.yl-mode-option').forEach((item) => item.classList.remove('selected'));
      option.classList.add('selected');

      const topControlsEl = byId<HTMLDivElement>('yl-top-controls');
      const firstRects = topControlsEl
        ? new Map(Array.from(topControlsEl.children).map((element) => [element, element.getBoundingClientRect()]))
        : null;

      const label = byId<HTMLSpanElement>('yl-mode-label');
      if (label) label.innerText = option.innerText;

      if (firstRects) animateTopControlsLayout(firstRects);

      modeSelector.classList.remove('active');
    };
  });

  const editor = document.createElement('div');
  editor.id = 'yl-editor';
  render(<EditorMarkup fontSize={state.userSettings.fontSize} lineHeight={state.userSettings.lineHeight} />, editor);
  uiRoot.appendChild(editor);

  const shortcutBtn = editor.querySelector<HTMLButtonElement>('#yl-shortcut-toggle-btn');
  const textarea = editor.querySelector<HTMLTextAreaElement>('#yl-textarea');
  const shortcutGuide = editor.querySelector<HTMLDivElement>('#yl-shortcut-guide');
  const updateShortcutModeUI = () => {
    editor.classList.toggle('shortcut-guide-visible', state.isShortcutModeOn);
    shortcutBtn?.classList.toggle('active', state.isShortcutModeOn);
    shortcutGuide?.classList.toggle('visible', state.isShortcutModeOn);
    shortcutGuide?.setAttribute('aria-hidden', state.isShortcutModeOn ? 'false' : 'true');
  };

  if (shortcutBtn && textarea) {
    updateShortcutModeUI();
    
    // ボタンのクリック時にテキストエリアからフォーカスが外れないよう、mousedown で blur を防ぐ
    shortcutBtn.onmousedown = (event) => event.preventDefault();
    
    shortcutBtn.onclick = () => {
      state.isShortcutModeOn = !state.isShortcutModeOn;
      updateShortcutModeUI();
      showToast(state.isShortcutModeOn ? 'Shortcuts: ON' : 'Shortcuts: OFF');

      // オンにした場合は確実にテキスト入力へフォーカスを戻す
      if (state.isShortcutModeOn) {
        textarea.focus();
      }
    };

    // テキストエリアからフォーカスが外れたら自動でショートカットモードをOFFにする
    // （他の場所をクリックしたときにショートカットが効かないことを明示的に伝えるため）
    const onBlur = () => {
      if (state.isShortcutModeOn) {
        state.isShortcutModeOn = false;
        updateShortcutModeUI();
        showToast('Shortcuts: Auto OFF');
      }
    };
    textarea.addEventListener('blur', onBlur);
    registerUiCleanup(() => textarea.removeEventListener('blur', onBlur));
  }

  // editor の最初の行全体をドラッグハンドルとして使う。
  byId<HTMLButtonElement>('yl-open-settings-btn')!.onclick = toggleSettingsModal;
  const editorHeader = editor.firstElementChild as HTMLElement | null;
  if (editorHeader) {
    editorHeader.style.cursor = 'grab';
    setupDraggable(editor, editorHeader);
  }

  createSettingsModal(uiRoot);
  renderLanguageControls();

  byId<HTMLButtonElement>('yl-save-btn')!.onclick = () => {
    const saveBtn = byId<HTMLButtonElement>('yl-save-btn');
    const text = byId<HTMLTextAreaElement>('yl-textarea')?.value || '';
    if (!saveBtn) return;

    // Apply は textarea の文字列を唯一の正とし、保存と再描画を同じ文字列で実行する。
    // 保存と画面の反映で経路を分けると、保存失敗時などに「画面とデータが違う」という不整合が起きるリスクがあるため。
    saveLyricsToStorage(text);
    loadLyricsFromText(text);

    // Apply は保存後にボタン自身が成功状態へモーフィングするのが基準版の挙動。
    if (saveBtn.classList.contains('is-success')) return;

    // 途中で文言が消えても幅が縮まないよう、現在幅を固定してから成功状態へ入る。
    // UIのSuccessアイコンへの遷移時にフレックスボックスの計算でボタンの大きさがガクガクと変わる不快なレイアウトシフトを防ぐため。
    const originalWidth = saveBtn.offsetWidth;
    saveBtn.style.width = `${originalWidth}px`;
    saveBtn.classList.add('is-success');

    window.setTimeout(() => {
      saveBtn.classList.remove('is-success');

      window.setTimeout(() => {
        // 成功モーフィングが終わった後だけ固定幅を外し、通常のレスポンシブ幅へ戻す。
        saveBtn.style.width = '';
      }, 500);
    }, 1000);
  };

  byId<HTMLButtonElement>('yl-download-btn')!.onclick = downloadLRC;
  byId<HTMLInputElement>('yl-font-slider')!.oninput = (event) => {
    beginLayoutShift();
    // editor 側の即時調整項目は oninput でリアルタイム反映する。
    state.userSettings.fontSize = (event.target as HTMLInputElement).value;
    applyVisualSettings();
    saveSettings();
  };
  byId<HTMLInputElement>('yl-lh-slider')!.oninput = (event) => {
    beginLayoutShift();
    state.userSettings.lineHeight = (event.target as HTMLInputElement).value;
    applyVisualSettings();
    saveSettings();
  };
  byId<HTMLButtonElement>('yl-reset-font-btn')!.onclick = () => {
    beginLayoutShift();
    // Reset は slider UI と state の両方を戻してから保存する。
    state.userSettings.fontSize = 28;
    byId<HTMLInputElement>('yl-font-slider')!.value = '28';
    applyVisualSettings();
    saveSettings();
  };
  byId<HTMLButtonElement>('yl-reset-lh-btn')!.onclick = () => {
    beginLayoutShift();
    state.userSettings.lineHeight = 140;
    byId<HTMLInputElement>('yl-lh-slider')!.value = '140';
    applyVisualSettings();
    saveSettings();
  };

  // すべての DOM が揃った後にだけ、イベントと監視処理を有効化する。
  registerUiCleanup(setupKeyboardEvents());
  registerUiCleanup(setupDragAndDrop(player));
  registerUiCleanup(setupInteractionEvents());
  startTimedTextObserver();

  void loadSettings().then(() => {
    // 永続設定の復元は最後にまとめて行い、初期 DOM 構築中のちらつきを避ける。
    // UI構築途中で各種パラメータを反映し出すと、デフォルト状態から保存状態へと画面がバチバチ切り替わるFOUC現象が起きてしまうため。
    setAppPower(state.userSettings.isEnabled);
    applyVisualSettings();
    updateSettingsModalUI();
    void updateTrackListUI();
  });
}

// 動画ごとのカテゴリ判定と UI 復帰をまとめ、SPA 遷移でも同じ初期化順を保つ。
// YouTubeの画面遷移は通常のリロードと違いイベントフックのタイミングが曖昧なため、自己完結型の起動プロセスが必要。
export async function bootNavigation() {
  const player = document.querySelector('.html5-video-player');
  if (!player) return;

  // bootNavigation は「UI の存在保証」と「動画依存データの復元」の両方を担当する。
  if (!byId('yl-container') || !byId('yl-ui')) {
    initUI();
  }

  const videoId = new URLSearchParams(window.location.search).get('v');
  if (!videoId) return;

  if (state.currentVIdForCategory !== videoId) {
    // 動画が変わった時だけカテゴリ判定をやり直し、同一動画では再利用する。
    state.currentVIdForCategory = videoId;

    const isMusic = await checkIsMusicVideo(videoId);
    // 判定待ち中に別動画へ遷移していたら、この結果は捨てる。
    // APIの応答が遅れた際、すでに別の動画を見ているのに前の動画の判定結果で音楽UIが急に開くといった競合バグを防ぐため。
    if (state.currentVIdForCategory !== videoId) return;

    if (isMusic) {
      // 音楽動画なら自動起動し、保存歌詞または字幕からデータを復元する。
      if (!state.userSettings.isEnabled && !state.userSettings.isManuallyDisabled) {
        setAppPower(true, false);
      }
      loadLyricsFromStorage();
      const { startSyncLyricsLoop } = await import('./runtime');
      startSyncLyricsLoop();
      byId<HTMLDivElement>('yl-container')?.classList.add('active');
    } else if (state.userSettings.isEnabled) {
      // 非音楽動画へ来たら、前の動画の UI を残さないため明示的に OFF に戻す。
      setAppPower(false, false);
    }
  } else if (state.userSettings.isEnabled) {
    // 同一動画で UI だけ作り直されたケースでは、復元処理だけを再実行する。
    loadLyricsFromStorage();
    const { startSyncLyricsLoop } = await import('./runtime');
    startSyncLyricsLoop();
    byId<HTMLDivElement>('yl-container')?.classList.add('active');
  }

  cleanUpStorage();
}

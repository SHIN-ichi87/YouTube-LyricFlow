import { byId, state } from './state';
import { formatTimeLRC } from './parsers';
import { applyVisualSettings, clearMaskLayer } from './visuals';

// 画面上の一時通知は 1 つだけ表示し、後続メッセージでタイマーを上書きする。
export function showToast(message: string) {
  const toast = byId<HTMLDivElement>('yl-offset-toast');
  if (!toast) return;

  toast.innerText = message;
  toast.classList.add('visible');

  if (state.offsetToastTimer) window.clearTimeout(state.offsetToastTimer);
  state.offsetToastTimer = window.setTimeout(() => {
    toast.classList.remove('visible');
  }, 2000);
}

// エディタやモーダルは見た目の座標を固定してからドラッグし、基準版の追従感を揃える。
export function setupDraggable(targetEl: HTMLElement | null, handleEl: HTMLElement | null) {
  if (!targetEl || !handleEl) return;

  handleEl.onmousedown = (event) => {
    const target = event.target as HTMLElement;
    if (event.button !== 0) return;
    // SVG 要素の tagName は小文字で返る環境があるため、判定も基準版に合わせる。
    if (['BUTTON', 'INPUT', 'SELECT', 'A', 'svg', 'path'].includes(target.tagName)) return;

    // transform 中の要素をそのままドラッグすると飛ぶので、見た目位置を絶対座標へ固定する。
    event.preventDefault();

    const parent = (targetEl.offsetParent as HTMLElement | null) || document.body;
    const parentRect = parent.getBoundingClientRect();
    const rect = targetEl.getBoundingClientRect();
    const relativeTop = rect.top - parentRect.top;
    const relativeLeft = rect.left - parentRect.left;

    targetEl.style.top = `${relativeTop}px`;
    targetEl.style.left = `${relativeLeft}px`;
    targetEl.style.right = 'auto';
    targetEl.style.bottom = 'auto';
    targetEl.style.transform = 'none';
    targetEl.style.margin = '0';

    targetEl.classList.add('yl-dragging');
    document.body.style.userSelect = 'none';

    const startX = event.clientX;
    const startY = event.clientY;
    const initialLeft = relativeLeft;
    const initialTop = relativeTop;

    // 以後は relativeTop / relativeLeft を基準に、移動量だけを足していく。
    const onMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      targetEl.style.left = `${initialLeft + deltaX}px`;
      targetEl.style.top = `${initialTop + deltaY}px`;
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      targetEl.classList.remove('yl-dragging');
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
}

export function spawnParticlesFromElement(element: HTMLElement | null) {
  if (!element) return;

  // パーティクルは wrapper 相対で配置しないと、スクロール中に origin がずれる。
  const rect = element.getBoundingClientRect();
  const container = byId<HTMLDivElement>('yl-scroll-wrapper');
  if (!container) return;

  const containerRect = container.getBoundingClientRect();

  for (let i = 0; i < 30; i += 1) {
    // 要素範囲内へランダム配置して、歌詞が崩れて散るような見た目を作る。
    const particle = document.createElement('div');
    particle.classList.add('yl-particle');

    const left = rect.left - containerRect.left + Math.random() * rect.width;
    const top = rect.top - containerRect.top + Math.random() * rect.height;

    particle.style.left = `${left}px`;
    particle.style.top = `${top}px`;
    particle.style.setProperty('--tx', `${(Math.random() - 0.5) * 100}px`);
    particle.style.setProperty('--ty', `${-50 - Math.random() * 100}px`);
    particle.style.setProperty('--d', `${Math.random()}s`);

    container.appendChild(particle);
    window.setTimeout(() => particle.remove(), 2000);
  }
}

export function toggleVideoPlay() {
  const video = document.querySelector<HTMLVideoElement>('video');
  if (!video) return;

  if (video.paused) {
    void video.play();
  } else {
    video.pause();
  }
}

export function adjustOffset(amount: number) {
  // 0.1 秒刻みを保つため、毎回小数 1 桁へ丸めて誤差蓄積を抑える。
  state.globalOffset = Math.round((state.globalOffset + amount) * 10) / 10;
  showToast(`Offset: ${state.globalOffset > 0 ? '+' : ''}${state.globalOffset.toFixed(1)}s`);
  void import('./visuals').then(({ updateIslandStatus }) => updateIslandStatus());
}

// ArrowDown は「最初の未タイムスタンプ行に現在時刻を打つ」基準版の簡易同期フローを再現する。
export function stampCurrentTime() {
  const video = document.querySelector<HTMLVideoElement>('video');
  const textarea = byId<HTMLTextAreaElement>('yl-textarea');
  if (!video || !textarea) return;

  // 基準版どおり、カーソル位置ではなく「最初の未スタンプ行」を対象にする。
  const lines = textarea.value.split('\n');
  const timestamp = formatTimeLRC(video.currentTime);
  const lineIndex = lines.findIndex((line) => !line.match(/\[\d{2}:\d{2}\.\d{2,3}\]/) && line.trim() !== '');

  if (lineIndex !== -1) {
    lines[lineIndex] = `${timestamp} ${lines[lineIndex]}`;
    textarea.value = lines.join('\n');

    // タイムスタンプ打刻は即座に保存・再描画し、プレビューを常に最新へ保つ。
    void import('./lyrics').then(({ saveLyricsToStorage, loadLyricsFromText }) => {
      saveLyricsToStorage(textarea.value);
      loadLyricsFromText(textarea.value);
    });
  }
}

// 手動スクロール中は自動吸着を止め、ホイール量をそのまま transform に反映する。
export function startInteraction() {
  const wrapper = byId<HTMLDivElement>('yl-scroll-wrapper');
  if (state.isUserInteracting || !wrapper) return;

  // 一度操作モードに入ったら、snap back 用の transform 起点もここでリセットする。
  state.isUserInteracting = true;
  wrapper.classList.add('is-interacting');
  state.manualScrollOffset = 0;

  const maskLayer = byId<HTMLDivElement>('yl-mask-layer');
  clearMaskLayer(maskLayer);
}

// 一定時間操作が止まったら、自動同期ループへ制御を戻す。
export function resetInteractionTimer() {
  if (state.interactionTimer) window.clearTimeout(state.interactionTimer);

  state.interactionTimer = window.setTimeout(() => {
    state.isUserInteracting = false;
    state.manualScrollOffset = 0;

    const wrapper = byId<HTMLDivElement>('yl-scroll-wrapper');
    if (wrapper) wrapper.classList.remove('is-interacting');

    applyVisualSettings();
  }, 2500);
}

// ホイールとドラッグを同居させるため、操作開始と終了の状態遷移を明示する。
export function setupInteractionEvents() {
  const wrapper = byId<HTMLDivElement>('yl-scroll-wrapper');
  const plate = byId<HTMLDivElement>('yl-bg-plate');
  if (!wrapper) return () => {};

  let dragStartX = 0;
  let dragStartPosX = 50;

  const onWheel = (event: WheelEvent) => {
    if (state.lyricsData.length === 0) return;

    // ホイールはプレイヤー本体に渡さず、歌詞コンテナ内の手動スクロールとして扱う。
    event.preventDefault();
    event.stopPropagation();
    startInteraction();

    if (state.manualScrollOffset === 0) {
      // 現在の transform を起点にしないと、最初の 1 スクロールで位置が飛ぶ。
      const style = window.getComputedStyle(wrapper);
      const MatrixCtor = window.DOMMatrixReadOnly || (window as Window & { WebKitCSSMatrix?: typeof DOMMatrixReadOnly }).WebKitCSSMatrix;
      const matrix = MatrixCtor ? new MatrixCtor(style.transform) : null;
      state.manualScrollOffset = matrix ? matrix.m42 : 0;
    }

    state.manualScrollOffset -= event.deltaY;
    wrapper.style.transform = `translate(-50%, ${state.manualScrollOffset}px)`;

    resetInteractionTimer();
  };

  const onMouseDown = (event: MouseEvent) => {
    if (state.lyricsData.length === 0 || event.button !== 0) return;

    // wrapper 自体のドラッグは「位置移動」であり、テキスト選択や動画操作には渡さない。
    event.stopPropagation();

    state.isDraggingPos = true;
    state.hasMoved = false;
    state.dragStartY = event.clientY;
    state.dragStartPos = parseFloat(String(state.userSettings.verticalPos));
    dragStartX = event.clientX;
    dragStartPosX = parseFloat(String(state.userSettings.horizontalPos || 50));

    wrapper.classList.add('is-interacting');
    wrapper.style.cursor = 'grabbing';

    if (plate) plate.style.transition = 'none';
  };

  const onMouseMove = (event: MouseEvent) => {
    if (!state.isDraggingPos) return;

    const deltaY = event.clientY - state.dragStartY;
    const deltaX = event.clientX - dragStartX;

    if (Math.abs(deltaY) > 5 || Math.abs(deltaX) > 5) {
      // 微小な揺れは click 判定を残し、一定以上でだけ drag 扱いへ切り替える。
      state.hasMoved = true;
    }

    if (state.hasMoved) {
      event.preventDefault();

      let newPosY = state.dragStartPos + (deltaY / window.innerHeight) * 100;
      let newPosX = dragStartPosX + (deltaX / window.innerWidth) * 100;

      newPosY = Math.max(10, Math.min(90, newPosY));
      newPosX = Math.max(10, Math.min(90, newPosX));

      state.userSettings.verticalPos = newPosY;
      state.userSettings.horizontalPos = newPosX;

      // wrapper / plate / mask をまとめて動かすため、style 個別更新ではなく applyVisualSettings を使う。
      applyVisualSettings();

      const positionSlider = byId<HTMLInputElement>('yl-pos-slider');
      if (positionSlider) positionSlider.value = String(newPosY);
    }
  };

  const onMouseUp = (event: MouseEvent) => {
    if (!state.isDraggingPos) return;

    event.stopPropagation();

    state.isDraggingPos = false;
    wrapper.classList.remove('is-interacting');
    wrapper.style.cursor = 'grab';

    if (plate) plate.style.transition = '';

    if (state.hasMoved) {
      // 実際に位置変更があった時だけ永続化して、クリックだけのケースでは保存しない。
      void import('./lyrics').then(({ saveSettings }) => saveSettings());
      showToast('Position Saved');
    }
  };

  wrapper.addEventListener('wheel', onWheel, { passive: false });
  wrapper.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  return () => {
    wrapper.removeEventListener('wheel', onWheel);
    wrapper.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };
}

export function setupDragAndDrop(target: HTMLElement) {
  const dropZone = byId<HTMLDivElement>('yl-drop-zone');
  if (!dropZone) return () => {};

  // drag 系イベントはすべて止めて、YouTube 側の既定挙動より LRC 読み込みを優先する。
  const onDragOver = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dropZone.classList.add('active');
  };

  const onDragLeave = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dropZone.classList.remove('active');
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dropZone.classList.remove('active');

    // 最初の 1 ファイルだけを対象にし、複数ドロップ時の曖昧さを避ける。
    const files = event.dataTransfer?.files;
    if (!files?.length) return;

    const file = files[0];
    const reader = new FileReader();
    reader.onload = (loadEvent) => {
      const text = loadEvent.target?.result;
      if (typeof text !== 'string') return;

      // ドロップ読み込みも Apply と同じ流れで、保存と描画更新を同時に行う。
      void import('./lyrics').then(({ setLyricsToEditor, saveLyricsToStorage }) => {
        setLyricsToEditor(text);
        saveLyricsToStorage(text);
      });

      showToast(`Loaded: ${file.name}`);

      // 編集の導線を切らさないため、閉じていたエディタは自動で開く。
      void import('./ui').then(({ toggleEditor }) => {
        if (!state.isEditorOpen) toggleEditor();
      });
    };
    reader.readAsText(file);
  };

  target.addEventListener('dragover', onDragOver);
  target.addEventListener('dragleave', onDragLeave);
  target.addEventListener('drop', onDrop);

  return () => {
    target.removeEventListener('dragover', onDragOver);
    target.removeEventListener('dragleave', onDragLeave);
    target.removeEventListener('drop', onDrop);
  };
}

// エディタ内ショートカットとグローバルショートカットは、YouTube 本体へ伝播させない。
export function setupKeyboardEvents() {
  const textarea = byId<HTMLTextAreaElement>('yl-textarea');
  const editor = byId<HTMLDivElement>('yl-editor');
  const cleanupFns: Array<() => void> = [];

  if (editor) {
    const onEditorWheel = (event: WheelEvent) => {
      event.stopPropagation();
    };

    // エディタ上のホイールだけは動画プレイヤーへ伝播させず、モーダル内スクロールを守る。
    editor.addEventListener('wheel', onEditorWheel, { passive: false });
    cleanupFns.push(() => editor.removeEventListener('wheel', onEditorWheel));
  }

  if (textarea) {
    const onTextareaKeyDown = (event: KeyboardEvent) => {
      // ArrowDown は字幕合わせ用の打刻ショートカットとして予約する。
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        stampCurrentTime();
      }

      // Ctrl+Space は YouTube 標準の Space と競合しやすいため、明示的に Ctrl を要求する。
      if (event.key === ' ' && event.ctrlKey) {
        event.preventDefault();
        toggleVideoPlay();
      }

      event.stopPropagation();
    };

    textarea.addEventListener('keydown', onTextareaKeyDown);
    cleanupFns.push(() => textarea.removeEventListener('keydown', onTextareaKeyDown));
  }

  const onDocumentKeyDown = (event: KeyboardEvent) => {
    // グローバル側では、エディタが閉じている時だけ Alt+Arrow をオフセット微調整に使う。
    if (!state.isEditorOpen && state.lyricsData.length > 0 && (event.key === 'ArrowRight' || event.key === 'ArrowLeft') && event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      adjustOffset(event.key === 'ArrowRight' ? 0.1 : -0.1);
    }
  };

  document.addEventListener('keydown', onDocumentKeyDown);
  cleanupFns.push(() => document.removeEventListener('keydown', onDocumentKeyDown));

  return () => {
    cleanupFns.forEach((cleanup) => cleanup());
  };
}

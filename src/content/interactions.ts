import { byId, state } from './state';
import { formatTimeLRC } from './parsers';
import { applyVisualSettings, clearMaskLayer } from './visuals';

// 画面上の一時通知は 1 つだけ表示し、後続メッセージでタイマーを上書きする。
// 通知が連続でスタックして画面を見えなくしてしまうのを防ぎ、常に最新の状態だけを伝えるため。
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
// CSSのtransformで中央寄せされている要素をそのままドラッグすると、マウス位置と実体座標がズレて画面外へ吹き飛ぶ不具合を避けるため。
export function setupDraggable(targetEl: HTMLElement | null, handleEl: HTMLElement | null) {
  if (!targetEl || !handleEl) return;

  handleEl.onmousedown = (event) => {
    const target = event.target as HTMLElement;
    if (event.button !== 0) return;
    // SVG 要素の tagName は小文字で返る環境があるため、判定も基準版に合わせる。
    if (['BUTTON', 'INPUT', 'SELECT', 'A', 'svg', 'path'].includes(target.tagName)) return;

    // transform 中の要素をそのままドラッグすると飛ぶので、見た目位置を絶対座標へ固定する。
    event.preventDefault();

    const zoomStr = window.getComputedStyle(targetEl).zoom;
    const zoom = (zoomStr && zoomStr !== 'normal') ? parseFloat(zoomStr) : 1;

    const parent = (targetEl.offsetParent as HTMLElement | null) || document.body;
    const parentRect = parent.getBoundingClientRect();
    const rect = targetEl.getBoundingClientRect();
    // ズーム適用下では getBoundingClientRect() の結果をズーム倍率で割らないと CSS 上の絶対位置や移動量がズレる
    const relativeTop = (rect.top - parentRect.top) / zoom;
    const relativeLeft = (rect.left - parentRect.left) / zoom;

    // style.top/left 等を変更する前に .yl-dragging を付与し、transition による位置飛び（アニメーション誤爆）を防ぐ
    targetEl.classList.add('yl-dragging');

    targetEl.style.top = `${relativeTop}px`;
    targetEl.style.left = `${relativeLeft}px`;
    targetEl.style.right = 'auto';
    targetEl.style.bottom = 'auto';
    targetEl.style.transform = 'none';
    targetEl.style.margin = '0';

    document.body.style.userSelect = 'none';

    const startX = event.clientX;
    const startY = event.clientY;
    const initialLeft = relativeLeft;
    const initialTop = relativeTop;

    // 以後は relativeTop / relativeLeft を基準に、移動量だけを足していく。
    const onMove = (moveEvent: MouseEvent) => {
      const deltaX = (moveEvent.clientX - startX) / zoom;
      const deltaY = (moveEvent.clientY - startY) / zoom;
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
  // 画面固定の座標系で作ってしまうと、歌詞がスクロールした時にエフェクトだけが空中に置き去りにされて不自然に見えるため。
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

  //showToast(`Offset: ${state.globalOffset > 0 ? '+' : ''}${state.globalOffset.toFixed(1)}s`);
  const statusEl = document.getElementById('yl-island-text');
  if (statusEl) {
    statusEl.classList.remove('pop-anim');
    // リフローを強制してアニメーションを再トリガー
    void statusEl.offsetWidth; 
    statusEl.classList.add('pop-anim');
  }

  void import('./visuals').then(({ updateIslandStatus }) => updateIslandStatus());
}

// ArrowDown は「最初の未タイムスタンプ行に現在時刻を打つ」基準版の簡易同期フローを再現する。
// ユーザーがいちいち行頭へカーソルを合わせる手間を省き、動画を見ながら連続してキーを叩くだけでLRCが作れるようにするため。
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

// Alt+Up または i キーで、直前に打ったタイムスタンプを削除する。
// 打刻ミスをした際に、エディタを開かずにすぐ取り消せるようにするため。
export function removeLastTimestamp() {
  const textarea = byId<HTMLTextAreaElement>('yl-textarea');
  if (!textarea) return;

  const lines = textarea.value.split('\n');
  const firstUnstampedIndex = lines.findIndex((line) => !line.match(/\[\d{2}:\d{2}\.\d{2,3}\]/) && line.trim() !== '');

  let targetIndex = -1;
  if (firstUnstampedIndex === -1) {
    // 全ての行がスタンプ済みの場合は、一番最後のスタンプ行を対象にする
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].match(/\[\d{2}:\d{2}\.\d{2,3}\]/)) {
        targetIndex = i;
        break;
      }
    }
  } else {
    // 未スタンプ行がある場合は、その直前にあるスタンプ行を対象にする
    for (let i = firstUnstampedIndex - 1; i >= 0; i -= 1) {
      if (lines[i].match(/\[\d{2}:\d{2}\.\d{2,3}\]/)) {
        targetIndex = i;
        break;
      }
    }
  }

  if (targetIndex !== -1) {
    lines[targetIndex] = lines[targetIndex].replace(/\[\d{2}:\d{2}\.\d{2,3}\]\s*/, '');
    textarea.value = lines.join('\n');

    void import('./lyrics').then(({ saveLyricsToStorage, loadLyricsFromText }) => {
      saveLyricsToStorage(textarea.value);
      loadLyricsFromText(textarea.value);
    });
  }
}

// 手動スクロール中は自動吸着を止め、ホイール量をそのまま transform に反映する。
// ユーザーが意図して他の歌詞を読もうとしている時に、動画の現在位置へ強引にスクロールバックされるストレスをなくすため。
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
// 単純なスクロールと位置調整のドラッグが同じDOM上で競合し、意図せず画面が動いてしまう操作ミスを防ぐため。
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
    // ポインタ位置は「今この瞬間に再生バー付近へ居るか」の判定に使うため、ドラッグ中でなくても更新する。
    // 歌詞の移動操作と無関係な hover 中でも下側のヒット判定切り替えは必要なので、早期 return より前で記録する。
    state.lastPointerClientY = event.clientY;
    state.controlsSafeAreaDirty = true;

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
    // マウスを離した直後の位置も安全領域判定へ反映し、ドラッグ終了後ただちに YouTube 側操作へ戻せるようにする。
    state.lastPointerClientY = event.clientY;
    state.controlsSafeAreaDirty = true;

    if (!state.isDraggingPos) return;

    event.stopPropagation();

    state.isDraggingPos = false;
    wrapper.classList.remove('is-interacting');
    wrapper.style.cursor = 'grab';

    if (plate) plate.style.transition = '';

    if (state.hasMoved) {
      // 実際に位置変更があった時だけ永続化して、クリックだけのケースでは保存しない。
      void import('./lyrics').then(({ saveSettings }) => saveSettings());
      //showToast('Position Saved');
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
  // ブラウザ標準のファイルプレビュー遷移が発動してしまい、せっかく開いていた動画ページから離脱してしまう事故を防ぐため。
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
// エディタで文字入力やカーソル移動をしている最中に、意図せず動画がシークしたりミュートされたりする干渉を防ぐため。
export function setupKeyboardEvents() {
  const textarea = byId<HTMLTextAreaElement>('yl-textarea');
  const editor = byId<HTMLDivElement>('yl-editor');
  const cleanupFns: Array<() => void> = [];

  if (editor) {
    const onEditorWheel = (event: WheelEvent) => {
      event.stopPropagation();
    };

    editor.addEventListener('wheel', onEditorWheel, { passive: false });
    cleanupFns.push(() => editor.removeEventListener('wheel', onEditorWheel));

    const onEditorKeyDown = (event: KeyboardEvent) => {
      // エディタ本体やその中にある要素（ボタンやスライダー等）でのキー操作は、すべてここで伝播を止める。
      // これにより、YouTube のショートカット（fで全画面など）が誤爆するのを完全に遮断する。
      event.stopPropagation();

      const key = event.key.toLowerCase();
      const code = event.code;
      
      const isDownEvent = key === 'arrowdown' || (event.altKey && (code === 'KeyK' || key === 'k' || key === '˚')) || (state.isShortcutModeOn && (code === 'KeyK' || key === 'k'));
      const isUpEvent = (event.altKey && (key === 'arrowup' || code === 'KeyI' || key === 'i' || key === 'ˆ')) || (state.isShortcutModeOn && (code === 'KeyI' || key === 'i'));
      const isPlayPause = (key === ' ' && event.ctrlKey) || (state.isShortcutModeOn && key === ' ');

      if (isDownEvent) {
        event.preventDefault();
        stampCurrentTime();
      } else if (isUpEvent) {
        event.preventDefault();
        removeLastTimestamp();
      } else if (isPlayPause) {
        // Space が押されたとき、ボタンへのフォーカスだとクリック判定に化けるため、それも防ぐ
        event.preventDefault();
        toggleVideoPlay();
      }
    };

    // keyup / keypress についても全く同じ壁を設置して YouTube 側への漏れを完全に防ぐ
    const stopEvent = (event: Event) => event.stopPropagation();

    editor.addEventListener('keydown', onEditorKeyDown);
    editor.addEventListener('keyup', stopEvent);
    editor.addEventListener('keypress', stopEvent);
    cleanupFns.push(() => {
      editor.removeEventListener('keydown', onEditorKeyDown);
      editor.removeEventListener('keyup', stopEvent);
      editor.removeEventListener('keypress', stopEvent);
    });
  }

  const onDocumentKeyDown = (event: KeyboardEvent) => {
    // グローバル側では、エディタが閉じている時でも各種 Alt ショートカットを使えるようにする。
    // Mac の Option + 文字キーは特殊記号が入力されて event.key が判定しづらいため event.code など多重に判定する。
    if (!state.isEditorOpen && event.altKey) {
      const key = event.key.toLowerCase();
      const code = event.code;

      const isRight = key === 'arrowright' || code === 'KeyL' || key === 'l' || key === '¬';
      const isLeft = key === 'arrowleft' || code === 'KeyJ' || key === 'j' || key === '∆';
      const isDown = key === 'arrowdown' || code === 'KeyK' || key === 'k' || key === '˚';
      const isUp = key === 'arrowup' || code === 'KeyI' || key === 'i' || key === 'ˆ';

      // 歌詞がなくても操作感（トースト等）をテストできるように、長さチェック(lyricsData.length > 0)はいったん外す
      if (isRight) {
        event.preventDefault();
        event.stopPropagation();
        adjustOffset(0.1);
      } else if (isLeft) {
        event.preventDefault();
        event.stopPropagation();
        adjustOffset(-0.1);
      } else if (isDown) {
        event.preventDefault();
        event.stopPropagation();
        stampCurrentTime();
      } else if (isUp) {
        event.preventDefault();
        event.stopPropagation();
        removeLastTimestamp();
      }
    }
  };

  document.addEventListener('keydown', onDocumentKeyDown);
  cleanupFns.push(() => document.removeEventListener('keydown', onDocumentKeyDown));

  return () => {
    cleanupFns.forEach((cleanup) => cleanup());
  };
}

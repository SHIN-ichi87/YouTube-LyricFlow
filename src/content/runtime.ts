import { byId, state } from './state';
import { bootNavigation } from './ui';
import { spawnParticlesFromElement } from './interactions';
import { applyMaskLayer, applyVisualSettings, clearMaskLayer, updateIslandStatus } from './visuals';

const CONTROLS_SAFE_MARGIN_PX = 8;
let trackedPlayer: HTMLDivElement | null = null;
let trackedControls: HTMLElement | null = null;
let controlsObserver: MutationObserver | null = null;
let controlsListenersBound = false;

// 再生バー付近の安全領域は、毎フレーム計測せず「変化が起きた時だけ」再計算する。
// rAF ループ内で getBoundingClientRect を常時呼び続けると、歌詞同期そのものよりヒット判定補助の方が重くなり本末転倒なため。
function markControlsSafeAreaDirty() {
  state.controlsSafeAreaDirty = true;
}

function refreshViewportSensitiveLayout() {
  markControlsSafeAreaDirty();
  requestAnimationFrame(() => {
    applyVisualSettings();
  });
}

// グローバルな viewport 変化だけを一度だけ購読し、プレイヤー安全領域の再計算タイミングを絞る。
// resize / fullscreenchange はコントロール帯の Y 座標を大きく変える代表例なので、ここだけ拾えば常時監視を避けられる。
function bindControlsSafeAreaListeners() {
  if (controlsListenersBound) return;
  controlsListenersBound = true;

  window.addEventListener('resize', refreshViewportSensitiveLayout);
  document.addEventListener('fullscreenchange', refreshViewportSensitiveLayout);
}

// YouTube 側の class/style 変更を監視し、コントロールの自動表示・自動非表示に追従する。
// マウスホバーで .ytp-chrome-bottom の位置や表示状態が変わるため、プレイヤー DOM の変化点だけを拾って dirty 化する。
function attachControlsObserver(player: HTMLDivElement, controls: HTMLElement | null) {
  controlsObserver?.disconnect();
  controlsObserver = new MutationObserver(() => {
    markControlsSafeAreaDirty();
  });

  controlsObserver.observe(player, {
    attributes: true,
    attributeFilter: ['class', 'style']
  });

  if (controls) {
    controlsObserver.observe(controls, {
      attributes: true,
      attributeFilter: ['class', 'style']
    });
  }
}

// 監視対象の player / controls は SPA 遷移や DOM 再生成で差し替わるため、参照の張り替えをここに閉じ込める。
// 毎フレーム querySelector し直す代わりに、参照が変わった時だけ observer を付け替えることで余計な DOM 探索を減らす。
function ensureControlsTracking(container: HTMLDivElement) {
  const player = container.parentElement instanceof HTMLDivElement ? container.parentElement : document.querySelector<HTMLDivElement>('.html5-video-player');
  if (!player) return null;

  const controls = player.querySelector<HTMLElement>('.ytp-chrome-bottom') || player.querySelector<HTMLElement>('.ytp-progress-bar-container');

  if (player !== trackedPlayer || controls !== trackedControls) {
    trackedPlayer = player;
    trackedControls = controls;
    attachControlsObserver(player, controls);
    markControlsSafeAreaDirty();
  }

  bindControlsSafeAreaListeners();
  return { player, controls };
}

// 再生バー付近の安全領域は dirty の時だけ再計算し、それ以外のフレームでは前回値を使い回す。
// 安全領域の見た目はフレーム単位で変化しないため、必要時だけの再計測で十分に追従できる。
function syncControlsSafeArea(container: HTMLDivElement) {
  const tracked = ensureControlsTracking(container);
  if (!tracked || !state.controlsSafeAreaDirty) return;
  state.controlsSafeAreaDirty = false;

  const { player, controls } = tracked;

  if (!controls) {
    state.controlsSafeTop = null;
    return;
  }

  const playerRect = player.getBoundingClientRect();
  const controlsRect = controls.getBoundingClientRect();

  if (playerRect.height <= 0 || controlsRect.height <= 0) {
    state.controlsSafeTop = null;
    return;
  }

  // 再生バーを含む下側帯に少し上方向の余裕を足し、YouTube 側の操作を取りやすくする。
  state.controlsSafeTop = Math.max(playerRect.top, Math.floor(controlsRect.top - CONTROLS_SAFE_MARGIN_PX));
}

// ポインタが安全領域に入っている間だけ、歌詞レイヤーのヒット判定を YouTube 本体へ譲る。
// 見た目はそのまま残しつつ操作だけを下へ通したいため、表示制御とは分離して判定する。
function shouldDisableLyricHitTesting() {
  if (state.isDraggingPos) return false;
  if (state.controlsSafeTop === null || state.lastPointerClientY === null) return false;
  return state.lastPointerClientY >= state.controlsSafeTop;
}

// pointer-events の style 書き込みは、値が変わる瞬間だけに絞って無駄な再計算を減らす。
// 毎フレーム同じ 'auto' / 'none' を流し込み続けても見た目は変わらず、スタイル更新コストだけが積み上がるため。
function applyWrapperHitTesting(wrapper: HTMLDivElement, isInteractive: boolean) {
  const nextValue: 'auto' | 'none' = isInteractive && !shouldDisableLyricHitTesting() ? 'auto' : 'none';
  if (state.lastWrapperPointerEvents === nextValue) return;
  wrapper.style.pointerEvents = nextValue;
  state.lastWrapperPointerEvents = nextValue;
}

// 間奏やアウトロへ入った瞬間は、手動操作由来のフラグをまとめて掃除する。
// ドラッグ中の cursor や interactionTimer が残ったまま退場演出へ切り替わると、見た目とヒット判定が食い違うため。
function cancelLyricInteraction(wrapper: HTMLDivElement, plate: HTMLDivElement | null) {
  if (state.interactionTimer) {
    window.clearTimeout(state.interactionTimer);
    state.interactionTimer = null;
  }

  state.isUserInteracting = false;
  state.isDraggingPos = false;
  state.hasMoved = false;
  state.manualScrollOffset = 0;
  wrapper.classList.remove('is-interacting');
  wrapper.style.cursor = 'grab';
  if (plate) plate.style.transition = '';
}

// 再生位置と描画状態を毎フレーム突き合わせ、基準版のスクロール挙動を維持する。
// setInterval等のタイマー駆動ではなくrequestAnimationFrameにすることで、画面のリフレッシュレートに同調した最も滑らかなアニメーションを実現するため。
function tickLyricsSync() {
  // OFF 中でも次フレームの監視だけは続け、再有効化に即応する。
  if (!state.userSettings.isEnabled) {
    requestAnimationFrame(tickLyricsSync);
    return;
  }

  const container = byId<HTMLDivElement>('yl-container');
  const video = document.querySelector<HTMLVideoElement>('video');
  const wrapper = byId<HTMLDivElement>('yl-scroll-wrapper');
  const plate = byId<HTMLDivElement>('yl-bg-plate');
  const mask = byId<HTMLDivElement>('yl-mask-layer');

  // YouTube 側がプレイヤー DOM を差し替えることがあるため、参照不能時は安全に抜ける。
  if (!video || !container || !wrapper) {
    requestAnimationFrame(tickLyricsSync);
    return;
  }

  syncControlsSafeArea(container);

  // setAppPower(false) で消した display は、再開時に同期ループ側でも確実に戻す。
  if (container.style.display === 'none') {
    container.style.display = '';
  }

  // 歌詞未ロード時は DOM を残したまま active だけ外し、次のロードに備える。
  if (state.lyricsData.length === 0) {
    container.classList.remove('active');
    requestAnimationFrame(tickLyricsSync);
    return;
  }

  container.classList.add('active');
  const adjustedTime = video.currentTime - state.globalOffset;
  let currentIndex = -1;

  // 0.1 秒だけ早めに次行へ切り替え、CSS transition の見た目遅延を吸収する。
  for (let i = 0; i < state.lyricsData.length; i += 1) {
    if (adjustedTime >= state.lyricsData[i].time - 0.1) {
      currentIndex = i;
    } else {
      break;
    }
  }

  if (container.dataset.lastIndex !== String(currentIndex)) {
    // 「通常歌詞 -> 間奏スペーサー」へ入る瞬間だけ、直前行を dissolve させる。
    // 間奏中も前の歌詞が画面に居座り続けると、動画のテンポ感と視覚が合わなくなるため、パーティクルで明示的に退場感を出す演出。
    if (currentIndex !== -1 && state.lyricsData[currentIndex]?.isInstrumental) {
      const previousLineEl = byId<HTMLDivElement>(`yl-line-${currentIndex - 1}`);
      if (previousLineEl) {
        spawnParticlesFromElement(previousLineEl);
        previousLineEl.classList.add('yl-dissolved');
      }
    }

    container.dataset.lastIndex = String(currentIndex);
    // current クラスの付け替えは lastIndex 変化時だけに絞り、毎フレームの無駄を避ける。
    state.lyricsData.forEach((_, index) => {
      const el = byId<HTMLDivElement>(`yl-line-${index}`);
      if (!el) return;
      el.classList.toggle('current', index === currentIndex);
      if (index !== currentIndex) {
        el.classList.remove('yl-dissolved');
      }
    });
  }

  const currentLineData = currentIndex !== -1 ? state.lyricsData[currentIndex] : null;
  const isInstrumentalSection = Boolean(currentLineData?.isInstrumental);

  // 間奏やイントロ/アウトロでは通常のドラッグ操作より退場演出を優先し、見た目とヒット判定のズレをなくす。
  if ((isInstrumentalSection || currentIndex === -1) && state.isUserInteracting) {
    cancelLyricInteraction(wrapper, plate);
  }

  // ユーザー操作中は、現在位置の追従だけ止めてハイライト更新は継続する。
  if (state.isUserInteracting) {
    requestAnimationFrame(tickLyricsSync);
    return;
  }

  if (currentIndex !== -1) {
    const activeEl = byId<HTMLDivElement>(`yl-line-${currentIndex}`);

    // 間奏/アウトロのスペーサーに入ったら、歌詞本体は退場させて映像を優先する。
    // 中盤の間奏でも歌詞が居残ると視界を塞いでしまうため、終了演出と同じく非表示状態に寄せる。
    if (currentLineData?.isInstrumental) {
      wrapper.style.opacity = '1';
      wrapper.classList.add('finished');
      applyWrapperHitTesting(wrapper, false);

      // 終了演出に入ったら、背景プレートは先に消して余韻だけを残す。
      if (plate) plate.style.opacity = '0';

      // マスク解除を 100ms 遅らせ、過去行が一瞬だけ見える事故を防ぐ。
      if (mask && mask.style.maskImage !== 'none') {
        window.setTimeout(() => {
          if (wrapper.classList.contains('finished')) {
            mask.style.opacity = '1';
            clearMaskLayer(mask);
          }
        }, 100);
      }

      // finished 中も current 行の位置まではきっちり中央へ合わせておく。
      if (activeEl) {
        wrapper.style.transform = `translate(-50%, ${-(activeEl.offsetTop + activeEl.offsetHeight / 2)}px)`;
      }
    } else {
      wrapper.style.opacity = '1';
      wrapper.classList.remove('finished');
      applyWrapperHitTesting(wrapper, true);

      if (plate) {
        if (state.userSettings.bgMode !== 'plate') {
          plate.style.opacity = '0';
        } else {
          // 次の行が間奏（またはアウトロ）かどうかを判定
          const nextIsInst = currentIndex < state.lyricsData.length - 1 && state.lyricsData[currentIndex + 1].isInstrumental;
          
          // プレートだけを何秒早く消し始めるか
          const earlyFadeSec = 0.5;
          const isApproachingEnd = currentLineData?.endTime && (adjustedTime >= currentLineData.endTime - earlyFadeSec);

          // 次が間奏で、かつフライング時刻を過ぎていたらプレートだけ先に消す
          plate.style.opacity = (nextIsInst && isApproachingEnd) ? '0' : '1';
        }
      }

      if (mask) mask.style.opacity = '1';
      // 終端演出で外したマスクは、通常表示に戻る瞬間にだけ復元する。
      if (mask && mask.style.maskImage === 'none') {
        applyMaskLayer(mask);
      }

      if (activeEl) {
        wrapper.style.transform = `translate(-50%, ${-(activeEl.offsetTop + activeEl.offsetHeight / 2)}px)`;

        // プレートは現在行の実寸に追従させ、二言語行でも包み込む大きさを保つ。
        if (plate && state.userSettings.bgMode === 'plate') {
          plate.style.width = `${activeEl.offsetWidth * 1.9 + 100}px`;
          plate.style.height = `${activeEl.offsetHeight * 2.5}px`;
        }
      }
    }
  } else {
    // イントロなど current 行がない区間では、歌詞本体だけを消して待機状態に戻す。
    wrapper.classList.remove('finished');
    wrapper.style.opacity = '0';
    wrapper.style.transform = 'translate(-50%, 0px)';
    applyWrapperHitTesting(wrapper, false);
    if (plate) plate.style.opacity = '0';
  }

  requestAnimationFrame(tickLyricsSync);
}

export function startSyncLyricsLoop() {
  // requestAnimationFrame ループは 1 本だけに固定し、多重起動を防ぐ。
  // 動画遷移やオンオフのたびに新しいループが走ると、裏で何重にも処理が重複してPCのCPU使用率が跳ね上がるのを防ぐため。
  if (state.syncLoopStarted) return;
  state.syncLoopStarted = true;
  requestAnimationFrame(tickLyricsSync);
}

// YouTube の SPA 遷移では UI を残したまま、基準版と同じ粒度で状態を掃除する。
// ページ全体のリロードが走らないYouTube特有の挙動に対し、別動画の歌詞が混ざったりUIが重複生成されたりするSPA由来のバグを回避するため。
export function bootstrapContentScript() {
  document.addEventListener('yt-navigate-finish', () => {
    // 動画切り替え時は「動画依存の状態」だけを落とし、UI インスタンス自体は使い回す。
    state.globalOffset = 0;
    updateIslandStatus();
    state.latestTimedTextUrl = null;
    state.availableTracks = [];
    state.lyricsData = [];
    state.controlsSafeTop = null;
    state.controlsSafeAreaDirty = true;
    state.lastWrapperPointerEvents = null;

    const wrapper = byId<HTMLDivElement>('yl-scroll-wrapper');
    if (wrapper) wrapper.replaceChildren();

    const textarea = byId<HTMLTextAreaElement>('yl-textarea');
    if (textarea) textarea.value = '';

    const container = byId<HTMLDivElement>('yl-container');
    if (container) container.classList.remove('active');

    // リセット後の復帰順は常に bootNavigation に集約する。
    void bootNavigation();
  });

  void bootNavigation();
  startSyncLyricsLoop();

  window.setInterval(() => {
    // YouTube が DOM を差し替えて UI が外れた場合の軽量な自己修復ループ。
    // テーマ変更やシアターモード切り替え時など、YouTube側がプレイヤー領域全体を破壊して再生成した際にも、自動で拡張機能のUIを復元するため。
    if (window.location.pathname === '/watch') {
      const player = document.querySelector('.html5-video-player');
      const container = byId<HTMLDivElement>('yl-container');

      if (player && !container) {
        void bootNavigation();
      } else if (player && container && container.parentElement !== player) {
        player.appendChild(container);
        const uiRoot = byId<HTMLDivElement>('yl-ui');
        if (uiRoot) player.appendChild(uiRoot);
      }
    }
  }, 1000);
}

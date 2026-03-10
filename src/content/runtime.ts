import { byId, state } from './state';
import { bootNavigation } from './ui';
import { spawnParticlesFromElement } from './interactions';
import { applyMaskLayer, clearMaskLayer, updateIslandStatus } from './visuals';

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

  // ユーザー操作中は、現在位置の追従だけ止めてハイライト更新は継続する。
  if (state.isUserInteracting) {
    requestAnimationFrame(tickLyricsSync);
    return;
  }

  if (currentIndex !== -1) {
    const currentLineData = state.lyricsData[currentIndex];
    const isLastLine = currentIndex === state.lyricsData.length - 1;
    const activeEl = byId<HTMLDivElement>(`yl-line-${currentIndex}`);

    // 最後の間奏マーカーに入ったら、基準版と同じ順序で歌詞をフェードアウトさせる。
    // 歌が終わった後も文字の残骸や黒い背景板が画面のど真ん中に残ると、アウトロの映像視聴の邪魔になってしまうため。
    if (isLastLine && currentLineData.isInstrumental) {
      wrapper.style.opacity = '1';
      wrapper.style.pointerEvents = 'none';
      wrapper.classList.add('finished');

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
      wrapper.style.pointerEvents = 'auto';
      wrapper.classList.remove('finished');

      if (plate) plate.style.opacity = '1';
      if (mask) mask.style.opacity = '1';
      // 終端演出で外したマスクは、通常表示に戻る瞬間にだけ復元する。
      if (mask && mask.style.maskImage === 'none') {
        applyMaskLayer(mask);
      }

      if (activeEl) {
        wrapper.style.transform = `translate(-50%, ${-(activeEl.offsetTop + activeEl.offsetHeight / 2)}px)`;

        // プレートは現在行の実寸に追従させ、二言語行でも包み込む大きさを保つ。
        if (plate && state.userSettings.showPlate) {
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
    wrapper.style.pointerEvents = 'none';
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

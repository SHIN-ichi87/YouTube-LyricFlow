import { byId, state, type RawSubtitleLine, type UserSettings } from './state';
import { insertInstrumentalBreaks, parseLRC } from './parsers';
import { applyVisualSettings } from './visuals';

const RUBY_PATTERN = /([一-龠々〆ヵヶ]+)\(([ぁ-んァ-ン]+)\)/g;

function appendFormattedMainText(container: HTMLElement, text: string) {
  let lastIndex = 0;

  for (const match of text.matchAll(RUBY_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      container.append(document.createTextNode(text.slice(lastIndex, index)));
    }

    const ruby = document.createElement('ruby');
    ruby.append(document.createTextNode(match[1]));

    const rt = document.createElement('rt');
    rt.textContent = match[2];
    ruby.append(rt);
    container.append(ruby);

    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    container.append(document.createTextNode(text.slice(lastIndex)));
  }
}

function createLyricLineElement(index: number) {
  const line = state.lyricsData[index];
  const div = document.createElement('div');
  div.className = 'yl-line';
  div.id = `yl-line-${index}`;

  if (line.isInstrumental) {
    const spacer = document.createElement('div');
    spacer.className = 'yl-instrumental-spacer';
    div.append(spacer);
    return div;
  }

  const mainSpan = document.createElement('span');
  mainSpan.className = 'yl-main-text';
  appendFormattedMainText(mainSpan, line.mainText);
  div.append(mainSpan);

  if (line.subText) {
    const subSpan = document.createElement('span');
    subSpan.className = 'yl-sub-text';
    subSpan.textContent = line.subText;
    div.append(subSpan);
  }

  return div;
}

// state.lyricsData を現在の DOM にそのまま描き直し、クリックシークも基準版どおり維持する。
// 差分更新ではなく全再構築にすることで、部分的なDOMの不整合やイベントリスナの重複登録といったバグ原因を根絶するため。
export function renderLyricsToDom() {
  const wrapper = byId<HTMLDivElement>('yl-scroll-wrapper');
  if (!wrapper) return;

  // 再描画時は毎回まっさらにして、古い current / dissolved 状態を持ち越さない。
  wrapper.replaceChildren();
  state.lyricsData.forEach((line, index) => {
    const div = createLyricLineElement(index);
    div.onclick = () => {
      // ドラッグ後の click 誤発火だけを抑え、通常クリックのシークは残す。
      if (state.hasMoved) return;
      const video = document.querySelector<HTMLVideoElement>('video');
      if (video) {
        video.currentTime = line.time;
      }
    };

    wrapper.appendChild(div);
  });

  applyVisualSettings();
}

// エディタ保存後の再描画は、LRC 解析 -> 間奏挿入 -> DOM 反映の 3 段階で揃える。
// プレビューと本番表示で処理経路を分けると動作に差分が出るため、常に同じパイプラインを通すことで確実な同期を担保する。
export function loadLyricsFromText(text: string) {
  const data = parseLRC(text);
  state.lyricsData = insertInstrumentalBreaks(data);
  renderLyricsToDom();
}

export function setLyricsToEditor(text: string) {
  const textarea = byId<HTMLTextAreaElement>('yl-textarea');
  if (!textarea) return;

  // エディタ表示と描画データは常に同じ文字列を参照させる。
  textarea.value = text;
  loadLyricsFromText(text);
}

export function saveLyricsToStorage(rawText: string) {
  const videoId = new URLSearchParams(window.location.search).get('v');
  if (!videoId) return;

  // 復元時の endTime 補完に使うため、歌詞本文だけでなく rawSubtitleData も一緒に保存する。
  chrome.storage.local.set({
    [`yl_lyrics_${videoId}`]: {
      lyrics: rawText,
      rawSubtitleData: state.rawSubtitleData,
      savedAt: Date.now()
    }
  });
}

// 保存済みデータがあれば rawSubtitleData も復元し、なければ自動字幕取り込みへフォールバックする。
// ユーザーが一生懸命に手動補正した歌詞を再訪問時に自動字幕で上書きして消してしまう、致命的なデータロストを防ぐため。
export function loadLyricsFromStorage() {
  const videoId = new URLSearchParams(window.location.search).get('v');
  if (!videoId) return;

  chrome.storage.local.get([`yl_lyrics_${videoId}`], (result) => {
    const savedData = result[`yl_lyrics_${videoId}`];
    if (savedData) {
      // 新形式は { lyrics, rawSubtitleData, savedAt }、旧形式は文字列そのものなので両対応する。
      if (typeof savedData === 'object' && savedData !== null && 'rawSubtitleData' in savedData) {
        state.rawSubtitleData = Array.isArray((savedData as { rawSubtitleData?: RawSubtitleLine[] }).rawSubtitleData)
          ? ((savedData as { rawSubtitleData?: RawSubtitleLine[] }).rawSubtitleData as RawSubtitleLine[])
          : [];
      } else {
        state.rawSubtitleData = [];
      }

      const text =
        typeof savedData === 'object' && savedData !== null && 'lyrics' in savedData ? (savedData as { lyrics?: unknown }).lyrics : savedData;

      if (typeof text === 'string') {
        // 保存データがあれば自動字幕取り込みより優先し、ユーザー編集内容を守る。
        setLyricsToEditor(text);
        return;
      }
    }

    // 保存がない動画だけ、自動字幕取り込みにフォールバックする。
    void import('./captions').then(({ tryAutoImportCaptions }) => tryAutoImportCaptions());
  });
}

// 保存期限と容量上限をまとめて面倒見ることで、動画ごとのキャッシュを放置しない。
// 何百曲も動画を見たユーザーのブラウザ拡張機能ストレージが溢れ、ある日突然何も保存できなくなる無言の障害を防ぐため。
export function cleanUpStorage() {
  chrome.storage.local.get(null, (items) => {
    const now = Date.now();
    const expireTime = 30 * 24 * 60 * 60 * 1000;
    const keysToDelete: string[] = [];
    const lyricItems: Array<{ key: string; time: number }> = [];

    for (const [key, value] of Object.entries(items)) {
      // 歌詞キャッシュ以外の設定キーはこの掃除処理の対象外にする。
      if (!key.startsWith('yl_lyrics_')) continue;
      if (typeof value !== 'object' || !value || !('savedAt' in value)) continue;

      const savedAt = (value as { savedAt?: number }).savedAt;
      if (!savedAt) continue;

      if (now - savedAt > expireTime) {
        keysToDelete.push(key);
      } else {
        lyricItems.push({ key, time: savedAt });
      }
    }

    chrome.storage.local.getBytesInUse(null, (bytesInUse) => {
      const quota = chrome.storage.local.QUOTA_BYTES || 5242880;

      // 容量逼迫時は古い動画から半分落とし、書き込み不能になる前に余白を作る。
      if (bytesInUse / quota > 0.8) {
        lyricItems.sort((a, b) => a.time - b.time);
        const deleteCount = Math.ceil(lyricItems.length / 2);
        for (let i = 0; i < deleteCount; i += 1) {
          keysToDelete.push(lyricItems[i].key);
        }
      }

      if (keysToDelete.length > 0) {
        chrome.storage.local.remove([...new Set(keysToDelete)]);
      }
    });
  });
}

export function saveSettings() {
  // 設定は state.userSettings 全体をそのまま保存し、個別キーのズレを作らない。
  chrome.storage.local.set({ yl_user_settings: state.userSettings });
}

// 既存設定は部分的に上書きし、欠けた項目は基準版デフォルトを残す。
// バージョンアップで新しい設定キーが増えた際、ユーザーの保存データにそのキーが存在しなくてもエラーで落ちないようにするため。
export function loadSettings() {
  return new Promise<void>((resolve) => {
    chrome.storage.local.get(['yl_user_settings'], (result) => {
      const stored = result.yl_user_settings;
      if (stored && typeof stored === 'object') {
        const { showPlate, ...storedSettings } = stored as Partial<UserSettings> & { showPlate?: boolean };
        state.userSettings = {
          ...state.userSettings,
          ...storedSettings,
          bgMode: storedSettings.bgMode ?? (showPlate ? 'plate' : state.userSettings.bgMode)
        };
      }
      resolve();
    });
  });
}

// タイトルをそのままファイル名にしつつ、OS 依存の禁止文字だけ除去する。
// ユーザー環境（特にWindows）において、無効な文字が含まれるファイル名でダウンロードが失敗して機能不全に陥るのを防ぐため。
export function downloadLRC() {
  const text = byId<HTMLTextAreaElement>('yl-textarea')?.value;
  if (!text) return;

  let title = 'lyrics';
  const titleEl =
    document.querySelector<HTMLElement>('h1.ytd-video-primary-info-renderer') ||
    document.querySelector<HTMLElement>('#title h1 yt-formatted-string');

  if (titleEl) {
    title = titleEl.innerText.trim().replace(/[\/\?<>\\:\*\|":]/g, '_');
  }

  // Blob URL を一時生成し、実ファイル保存はブラウザ標準の download 挙動へ委ねる。
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${title}.lrc`;
  anchor.click();
  URL.revokeObjectURL(url);
}

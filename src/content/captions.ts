import { byId, state, type CaptionTrack } from './state';
import { mergeLrc, parseTimedTextJsonToLrc, parseTimedTextXmlToLrc } from './parsers';
import { showToast } from './interactions';

function warnCaption(message: string, error: unknown) {
  console.warn(`[YouTube LyricFlow] ${message}`, error);
}

async function fetchWatchPageHtml() {
  const response = await fetch(window.location.href);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.text();
}

// YouTube の字幕トラック名は simpleText / runs の両系統があるため、ここで吸収する。
function getTrackLabel(track: CaptionTrack): string {
  if (track.name.simpleText) return track.name.simpleText;
  if (track.name.runs?.length) return track.name.runs.map((run) => run.text).join('');
  return track.languageCode;
}

// カスタムドロップダウンは DOM の selected 状態も手動で同期する必要がある。
function updateDropdownUI() {
  const primaryValue = state.userSettings.primaryLang || 'auto';
  const primaryContainer = byId<HTMLDivElement>('yl-primary-select')?.parentElement as HTMLDivElement | null;
  if (primaryContainer) {
    // 再描画後も selected と表示テキストが食い違わないよう、DOM を手動で同期する。
    const options = primaryContainer.querySelectorAll<HTMLDivElement>('.yl-option');
    let label = 'Auto (Follow Video)';
    options.forEach((option) => {
      if (option.dataset.value === primaryValue) {
        option.classList.add('selected');
        label = option.querySelector('span')?.innerText || label;
      } else {
        option.classList.remove('selected');
      }
    });
    const currentDisplay = primaryContainer.querySelector<HTMLSpanElement>('.current-val');
    if (currentDisplay) currentDisplay.innerText = label;
  }

  const secondaryValue = state.userSettings.secondaryLang || 'none';
  const secondaryContainer = byId<HTMLDivElement>('yl-secondary-select')?.parentElement as HTMLDivElement | null;
  if (secondaryContainer) {
    const options = secondaryContainer.querySelectorAll<HTMLDivElement>('.yl-option');
    let label = 'None';
    options.forEach((option) => {
      if (option.dataset.value === secondaryValue) {
        option.classList.add('selected');
        label = option.querySelector('span')?.innerText || label;
      } else {
        option.classList.remove('selected');
      }
    });
    const currentDisplay = secondaryContainer.querySelector<HTMLSpanElement>('.current-val');
    if (currentDisplay) currentDisplay.innerText = label;
  }
}

// Primary 言語の選択肢は、現在見えているトラックだけを重複排除して並べる。
export function refreshPrimaryDropdown() {
  const container = byId<HTMLDivElement>('yl-primary-select')?.parentElement as HTMLDivElement | null;
  const updateOptions = (container as { updateOptions?: (options: Array<{ label: string; value: string }>) => void } | null)?.updateOptions;
  if (!updateOptions) return;

  const options = [{ label: 'Auto (Follow Video)', value: 'auto' }];
  const seen = new Set<string>();

  state.availableTracks.forEach((track) => {
    if (seen.has(track.languageCode)) return;
    let label = getTrackLabel(track);
    if (track.kind === 'asr') label += ' (Auto-gen)';
    options.push({ label, value: track.languageCode });
    seen.add(track.languageCode);
  });

  updateOptions(options);
  updateDropdownUI();
}

// watch ページの HTML から captionTracks を拾い、UI に出せる選択肢を再構築する。
export async function updateTrackListUI() {
  if (state.availableTracks.length > 0) {
    // 既に検出済みなら fetch を増やさず、UI 同期だけで済ませる。
    refreshPrimaryDropdown();
    return;
  }

  try {
    // watch HTML 内の captionTracks を読むのが、追加 API を叩かずに済む最小コストの取得方法。
    const html = await fetchWatchPageHtml();
    const match = html.match(/"captionTracks":\s*(\[.*?\])/);
    const tracks = match ? (JSON.parse(match[1]) as CaptionTrack[]) : [];

    if (tracks.length > 0) {
      state.availableTracks = tracks;
      refreshPrimaryDropdown();
    }
  } catch (error) {
    warnCaption('Failed to refresh caption track list.', error);
  }
}

export async function checkIsMusicVideo(videoId: string) {
  if (!videoId) return false;
  // 同じ動画 ID への再訪時は fetch を省くため、カテゴリ判定をキャッシュする。
  if (state.categoryCache[videoId] !== undefined) return state.categoryCache[videoId];

  try {
    const html = await fetchWatchPageHtml();
    const categoryMatch = html.match(/"category":"([^"]+)"/);

    if (categoryMatch && categoryMatch[1]) {
      const isMusic = categoryMatch[1] === 'Music' || categoryMatch[1] === '音楽';
      state.categoryCache[videoId] = isMusic;
      return isMusic;
    }
  } catch (error) {
    warnCaption('Failed to detect the current video category.', error);
  }

  state.categoryCache[videoId] = false;
  return false;
}

// 実際に再生で使われた timedtext URL を監視して、署名付き URL を再利用できるようにする。
export function startTimedTextObserver() {
  // PerformanceObserver は 1 回だけ起動し、以後は最新の字幕 URL 観測に使い回す。
  if (state.timedTextObserver) return;

  try {
    state.timedTextObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (typeof entry.name === 'string' && entry.name.includes('/api/timedtext')) {
          state.latestTimedTextUrl = entry.name;
        }
      }
    });

    state.timedTextObserver.observe({ entryTypes: ['resource'] });
  } catch (error) {
    warnCaption('PerformanceObserver for timedtext could not be started.', error);
    state.timedTextObserver = null;
  }
}

export function findTimedTextUrl() {
  const currentVideoId = new URLSearchParams(window.location.search).get('v');

  // 直近観測の URL が現在動画に紐づくなら、それを最優先で再利用する。
  if (state.latestTimedTextUrl && (!currentVideoId || state.latestTimedTextUrl.includes(currentVideoId))) {
    return state.latestTimedTextUrl;
  }

  const entries = performance.getEntriesByType('resource');
  const timedTextEntries = entries
    .filter((entry) => typeof entry.name === 'string' && entry.name.includes('/api/timedtext'))
    .sort((a, b) => b.startTime - a.startTime);

  // ResourceTiming からは最新順に見て、現動画 ID を含む URL だけを採用する。
  for (const entry of timedTextEntries) {
    if (currentVideoId && entry.name.includes(`v=${currentVideoId}`)) {
      return entry.name;
    }
  }

  return null;
}

// URL がまだ観測できていない動画では、一度字幕ボタンを押してリクエストを発生させる。
export function triggerCaptionFetch() {
  return new Promise<string | null>((resolve) => {
    const button = document.querySelector<HTMLElement>('.ytp-subtitles-button');
    if (!button) {
      resolve(null);
      return;
    }

    const wasPressed = button.getAttribute('aria-pressed') === 'true';
    if (!wasPressed) {
      // 一時的に字幕を ON にして timedtext リクエストを発生させ、URL を拾ったら元へ戻す。
      button.click();
      window.setTimeout(() => {
        const url = findTimedTextUrl();
        button.click();
        resolve(url);
      }, 700);
    } else {
      resolve(findTimedTextUrl());
    }
  });
}

// YouTube の timedtext は JSON / XML の両方が来るため、Content-Type と内容の両方で判定する。
export async function fetchAndParseTimedText(url: string) {
  if (!url) return '';

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const contentType = (response.headers.get('content-type') || '').toLowerCase();

  // JSON を期待していても text/plain で返ることがあるため、実データでも再判定する。
  if (contentType.includes('application/json')) {
    return parseTimedTextJsonToLrc(await response.json());
  }

  const raw = await response.text();
  if (raw.trim().startsWith('{')) {
    return parseTimedTextJsonToLrc(JSON.parse(raw));
  }

  return parseTimedTextXmlToLrc(raw);
}

// 自動取り込みは「現在有効な字幕 URL を土台に lang / tlang を差し替える」基準版戦略を守る。
export async function tryAutoImportCaptions(force = false) {
  const videoId = new URLSearchParams(window.location.search).get('v');
  if (!videoId) return;

  // force なしでは、手動保存済みの歌詞を自動字幕で上書きしない。
  if (!force) {
    const hasSaved = await new Promise<boolean>((resolve) => {
      chrome.storage.local.get([`yl_lyrics_${videoId}`], (result) => {
        resolve(Boolean(result[`yl_lyrics_${videoId}`]));
      });
    });

    if (hasSaved) return;
  }

  await updateTrackListUI();

  try {
    let captionUrl = findTimedTextUrl();

    // 再生直後は ResourceTiming へ載るまで遅れることがあるので、少し待ちながら再試行する。
    for (let i = 0; i < 5; i += 1) {
      captionUrl = findTimedTextUrl();
      if (captionUrl) break;
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }

    if (!captionUrl) {
      captionUrl = await triggerCaptionFetch();
    }

    if (!captionUrl) return;

    const urlObject = new URL(captionUrl);
    // LRC 化の都合で json3 を固定し、元 URL の字幕署名や動画 ID はそのまま使う。
    urlObject.searchParams.set('fmt', 'json3');

    const targetLang = state.userSettings.primaryLang;
    if (targetLang && targetLang !== 'auto') {
      // Primary を明示指定した場合は翻訳指定を消し、原文ソースだけを差し替える。
      urlObject.searchParams.set('lang', targetLang);
      urlObject.searchParams.delete('tlang');
    }

    const primaryLrc = await fetchAndParseTimedText(urlObject.toString());
    const primaryLangCode = urlObject.searchParams.get('lang') || 'auto';
    let finalLrc = primaryLrc;
    const secondaryLang = state.userSettings.secondaryLang || 'none';

    if (secondaryLang !== 'none' && secondaryLang !== primaryLangCode) {
      try {
        // 翻訳は Primary の成功 URL を土台に tlang だけ足して取得する。
        const translatedUrl = new URL(urlObject.toString());
        translatedUrl.searchParams.set('tlang', secondaryLang);
        const translatedLrc = await fetchAndParseTimedText(translatedUrl.toString());
        if (translatedLrc) {
          finalLrc = mergeLrc(primaryLrc, translatedLrc);
        }
      } catch (error) {
        warnCaption('Failed to fetch translated captions.', error);
      }
    }

    if (finalLrc) {
      const { setLyricsToEditor, saveLyricsToStorage } = await import('./lyrics');
      // 自動取り込みでも手動 Apply と同じく、エディタ表示・描画・保存を一度に揃える。
      setLyricsToEditor(finalLrc);
      saveLyricsToStorage(finalLrc);

      const primaryLabel = primaryLangCode.toUpperCase();
      const secondaryLabel = secondaryLang !== 'none' ? ` + ${secondaryLang.toUpperCase()}` : '';
      showToast(`Synced: ${primaryLabel}${secondaryLabel}`);
    }
  } catch (error) {
    warnCaption('Automatic caption import failed.', error);
  }
}

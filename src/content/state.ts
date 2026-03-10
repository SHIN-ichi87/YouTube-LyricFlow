export interface LyricsLine {
  time: number;
  endTime?: number | null;
  mainText: string;
  subText?: string;
  isInstrumental?: boolean;
}

export interface RawSubtitleLine {
  start: number;
  end: number;
  text: string;
}

export interface UserSettings {
  isEnabled: boolean;
  fontSize: number | string;
  verticalPos: number;
  horizontalPos: number;
  visibleLines: number;
  lineHeight: number | string;
  primaryLang: string;
  secondaryLang: string;
  fontFamily: 'rounded' | 'standard' | 'serif' | 'mono';
  showPlate: boolean;
}

export interface CaptionTrack {
  languageCode: string;
  kind?: string;
  name: {
    simpleText?: string;
    runs?: Array<{ text: string }>;
  };
}

export interface TimedTextJson {
  events?: Array<{
    tStartMs?: string | number;
    dDurationMs?: string | number;
    segs?: Array<{ utf8?: string }>;
  }>;
}

export interface DropdownOption {
  label: string;
  value: string;
}

export interface DropdownContainerElement extends HTMLDivElement {
  updateOptions?: (options: DropdownOption[]) => void;
}

export interface OutsideClickBinding {
  root: HTMLElement;
  onOutsideClick: () => void;
}

// 基準版のグローバル変数をそのまま集約した共有状態。
// DOM id、ストレージキー、デフォルト値の互換性はここを起点に守る。旧バージョンからのデータ引き継ぎで不整合を起こさないための措置。
export const state = {
  // 現在の歌詞データと、ユーザーが与えた全体オフセット。
  // リフレッシュレートの違いなどで動画時間と歌詞が微妙にずれる環境でも、ユーザー自身で手軽に微調整できるようにするため。
  lyricsData: [] as LyricsLine[],
  globalOffset: 0,
  // エディタ / 設定モーダルの開閉状態。
  isEditorOpen: false,
  isSettingsOpen: false,
  offsetToastTimer: null as number | null,
  // 手動スクロールやドラッグ中は自動追従を止めるための操作状態。
  // ユーザーが歌詞を遡って読んでいる最中に、再生中の現在位置へ強制的にスクロールされてしまうストレスを防ぐため。
  isUserInteracting: false,
  interactionTimer: null as number | null,
  manualScrollOffset: 0,
  isDraggingPos: false,
  dragStartY: 0,
  dragStartPos: 0,
  hasMoved: false,
  // エディタ内でキーボードショートカットを有効にするモード
  isShortcutModeOn: false,
  // YouTube 字幕 URL の観測結果と、そこから復元するトラック情報。
  latestTimedTextUrl: null as string | null,
  timedTextObserver: null as PerformanceObserver | null,
  availableTracks: [] as CaptionTrack[],
  rawSubtitleData: [] as RawSubtitleLine[],
  // 表示設定はストレージ永続化の対象で、未保存項目はこのデフォルト値が基準になる。
  // 初回起動時や新規設定項目が追加されたアップデート直後でも、表示が壊れないよう安全なフォールバックを確保する意図。
  userSettings: {
    isEnabled: false,
    fontSize: 28,
    verticalPos: 50,
    horizontalPos: 50,
    visibleLines: 3,
    lineHeight: 140,
    primaryLang: 'auto',
    secondaryLang: 'ja',
    fontFamily: 'standard',
    showPlate: false
  } as UserSettings,
  // 補助 UI の遅延処理や、動画ごとのカテゴリ判定キャッシュ。
  settingsOverflowTimer: null as number | null,
  syncLoopStarted: false,
  categoryCache: {} as Record<string, boolean>,
  currentVIdForCategory: null as string | null,
  uiCleanupFns: [] as Array<() => void>,
  outsideClickBindings: [] as OutsideClickBinding[]
};

// DOM 参照の型付けを簡潔に保つための小さなヘルパー。
export function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

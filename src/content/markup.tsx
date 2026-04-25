// マークアップは基準版の id / class をそのまま保ち、イベントは ui.tsx 側で束ねる。
// JSX内で直接onclick事を書くと状態管理や再レンダリング時のイベント破棄が煩雑になり、純粋なビューとしての保守性が下がるため。
export function DynamicIslandMarkup() {
  return (
    <div id="yl-island">
      {/* 展開時にだけ見える補助操作群。通常時は main セクションだけを見せる。
          画面の限られた領域を占有しすぎないよう、必要な機能だけをホバーで引き出せる設計にするため。 */}
      <div class="yl-island-section yl-island-controls">
        <div class="yl-island-controls-inner">
          <button class="yl-island-btn" id="yl-power-off-btn" title="Turn Off">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path>
              <line x1="12" y1="2" x2="12" y2="12"></line>
            </svg>
          </button>

          <div class="yl-island-separator"></div>

          <button class="yl-island-btn" id="yl-island-minus" title="Offset -0.1s">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path d="M5 12h14"></path>
            </svg>
          </button>

          <span class="yl-island-status" id="yl-island-text">
            0.0s
          </span>

          <button class="yl-island-btn" id="yl-island-plus" title="Offset +0.1s">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path d="M12 5v14M5 12h14"></path>
            </svg>
          </button>

          <div class="yl-island-separator"></div>

          <button class="yl-island-btn" id="yl-island-sync" title="Sync Line (↓)" style={{ marginLeft: '4px' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path d="M7 13l5 5 5-5M12 15V3"></path>
            </svg>
          </button>
        </div>
      </div>

      {/* 常時見えているメイン入口。クリック先の責務は ui.tsx 側で配線する。
          ここでは純粋なUI部品としての構造定義に専念し、ビジネスロジックの混入を防ぐため。 */}
      <div class="yl-island-section yl-island-main" id="yl-island-toggle" title="Menu">
        <div class="yl-bars-icon">
          <div class="yl-bar yl-bar-1"></div>
          <div class="yl-bar yl-bar-2"></div>
          <div class="yl-bar yl-bar-3"></div>
        </div>
      </div>
    </div>
  );
}

// モード選択肢はまだダミー表示だが、DOM 構造は基準版と一致させておく。
// 後日「カラオケモード」などの新機能を単体追加する際、CSSやアニメーションのレイアウト調整を最小限で済ませるための足場。
export function ModeSelectorMarkup() {
  return (
    <>
      {/* ヘッダー部分はラベル表示と音符ボタンを兼ねる。 */}
      <div class="yl-mode-header" id="yl-mode-toggle">
        <div class="yl-mode-header-left">
          <svg class="custom-icon icon-eclipse" viewBox="0 0 24 24">
            <circle class="circle-1" cx="12" cy="12" r="6" />
            <circle class="circle-2" cx="12" cy="12" r="6" />
          </svg>
          <span id="yl-mode-label">Normal Mode</span>
        </div>

        <div id="yl-music-note-btn">
          <svg class="yl-mode-chevron yl-music-note-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 18V5V3a2 2 0 012-2h4a2 2 0 012 2v3a2 2 0 01-1.18 1.82L11 10.3"></path><circle cx="6" cy="18" r="3"></circle>
          </svg>
        </div>
      </div>
      {/* 実機能は未接続だが、展開レイアウトと選択状態の DOM は先に揃えておく。 */}
      <div class="yl-mode-dropdown">
        <div class="yl-mode-dropdown-inner">
          <div class="yl-mode-option selected" data-mode="normal">
            Normal Mode
          </div>
          <div class="yl-mode-option" data-mode="karaoke">
            under development
          </div>
          <div class="yl-mode-option" data-mode="focus">
            under development
          </div>
        </div>
      </div>
    </>
  );
}

// エディタ本体は「保存・書き出し・字幕言語・文字調整」を一画面に集約する。
// オフセットなど見た目の微調整（結果）と、LRC自体のデータ編集（原因）を同じ視界内でシームレスに行き来できるようにするため。
export function EditorMarkup({ fontSize, lineHeight }: { fontSize: number | string; lineHeight: number | string }) {
  return (
    <>
      {/* ヘッダー行はタイトルと Customize 入口を兼ね、ドラッグハンドルとしても使う。 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
        <h3>Lyrics Studio</h3>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button id="yl-open-settings-btn" class="yl-customize-btn">
            Customize
          </button>
        </div>
      </div>

      <div class="yl-textarea-wrap" style={{ position: 'relative' }}>
        <button id="yl-shortcut-toggle-btn" class="yl-shortcut-toggle" title="Enable Keyboard Shortcuts (k: stamp, i: remove, space: play/pause)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" ry="2"></rect>
            <line x1="7" y1="8" x2="7" y2="8"></line>
            <line x1="11" y1="8" x2="11" y2="8"></line>
            <line x1="15" y1="8" x2="15" y2="8"></line>
            <line x1="7" y1="12" x2="7" y2="12"></line>
            <line x1="11" y1="12" x2="11" y2="12"></line>
            <line x1="15" y1="12" x2="15" y2="12"></line>
            <line x1="7" y1="16" x2="17" y2="16"></line>
          </svg>
        </button>
        <textarea id="yl-textarea" placeholder="[00:00.00] Lyrics will appear here..."></textarea>
      </div>
      <div id="yl-shortcut-guide" class="yl-shortcut-guide" aria-hidden="true">
        <div class="yl-shortcut-guide-title">Shortcut Mode</div>
        <div class="yl-shortcut-guide-row">
          <kbd>K</kbd>
          <span>現在時刻を打刻</span>
        </div>
        <div class="yl-shortcut-guide-row">
          <kbd>I</kbd>
          <span>直前の打刻を削除</span>
        </div>
        <div class="yl-shortcut-guide-row">
          <kbd>Space</kbd>
          <span>再生 / 一時停止</span>
        </div>
        <div class="yl-shortcut-guide-title yl-shortcut-guide-subtitle">Always Available</div>
        <div class="yl-shortcut-guide-row">
          <kbd>Alt K</kbd>
          <span>現在時刻を打刻</span>
        </div>
        <div class="yl-shortcut-guide-row">
          <kbd>Alt I</kbd>
          <span>直前の打刻を削除</span>
        </div>
        <div class="yl-shortcut-guide-row">
          <kbd>Alt J/L</kbd>
          <span>オフセット -/+ 0.1s</span>
        </div>
        <div class="yl-shortcut-guide-row">
          <kbd>Ctrl Space</kbd>
          <span>再生 / 一時停止</span>
        </div>
        <div class="yl-shortcut-guide-note">入力欄から離れると自動OFF</div>
      </div>

      {/* Apply / Export は本文編集の直後に触る主操作として独立させる。 */}
      <div id="yl-toolbar">
        <button id="yl-save-btn" class="yl-btn btn-primary">
          <div class="yl-btn-outline"></div>
          <span>Apply</span>
        </button>
        <button id="yl-download-btn" class="yl-btn btn-success">
          Export .lrc
        </button>
      </div>

      {/* エディタ直下には、編集中に触る頻度が高い設定だけを残す。 */}
      <div class="yl-settings-group">
        <div id="yl-lang-controls"></div>

        <div class="yl-setting-item" style={{ marginTop: '15px' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <span>Typography Size</span>
            <button id="yl-reset-font-btn" class="yl-reset-mini" title="Reset (28px)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                <path d="M3 3v5h5"></path>
              </svg>
            </button>
          </div>
          <input type="range" min="18" max="64" value={String(fontSize)} class="yl-slider" id="yl-font-slider" />
        </div>

        <div class="yl-setting-item">
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <span>Line Spacing</span>
            <button id="yl-reset-lh-btn" class="yl-reset-mini" title="Reset (140%)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                <path d="M3 3v5h5"></path>
              </svg>
            </button>
          </div>
          <input type="range" min="100" max="250" value={String(lineHeight || 140)} class="yl-slider" id="yl-lh-slider" />
        </div>
      </div>
    </>
  );
}

// 設定モーダルは見た目専用の追加設定だけを持ち、歌詞本文編集とは分離する。
// すべての設定をエディタパネルに詰め込むと画面が圧迫され、肝心のテキスト編集用エリアが狭くなってしまう使いづらさを防ぐため。
export function SettingsModalMarkup() {
  return (
    <>
      {/* 詳細設定モーダルは見出しと閉じるボタンを明確に分ける。 */}
      <div class="yl-modal-header">
        <h3>Customize View</h3>
        <button id="yl-close-settings-btn" class="yl-icon-btn">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

      {/* 各 control-group は役割単位でまとまっており、配線は ui.tsx が持つ。 */}
      <div class="yl-modal-content">
        <div class="yl-control-group">
          <div class="yl-control-label">
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <span>Visible Lines</span>
              <button id="yl-reset-lines-btn" class="yl-reset-mini" title="Reset to Default">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                  <path d="M3 3v5h5"></path>
                </svg>
              </button>
            </div>
            <span id="yl-lines-val" class="yl-val-badge">
              Max
            </span>
          </div>
          <div class="yl-control-row">
            <span class="yl-sub-label">Focus</span>
            <input type="range" min="1" max="10" value="3" class="yl-slider" id="yl-lines-slider" style={{ flex: 1, margin: '0 10px' }} />
            <span class="yl-sub-label">Wide</span>
          </div>
          <p class="yl-desc">Limits the visual field to focus on current lyrics.</p>
        </div>

        <div class="yl-control-group">
          <div class="yl-control-label">
            <span>Appearance</span>
          </div>
          <div class="yl-control-row" style={{ justifyContent: 'space-between' }}>
            <div id="yl-font-custom-wrapper" style={{ width: '48%' }}></div>
            <button id="yl-plate-toggle" class="yl-btn btn-secondary" style={{ width: '48%', padding: '6px' }}>
              <span id="yl-plate-status">Plate: Off</span>
            </button>
          </div>
        </div>

        <div class="yl-control-group">
          <div class="yl-control-label">
            <span>Position Reset</span>
          </div>
          <div class="yl-btn-row">
            <button id="yl-reset-v-btn" class="yl-btn btn-secondary">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14M5 12h14"></path>
              </svg>
              Center Vertical
            </button>
            <button id="yl-reset-h-btn" class="yl-btn btn-secondary">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14M5 12h14"></path>
              </svg>
              Center Horizontal
            </button>
          </div>
        </div>

        <div class="yl-control-group">
          <button id="yl-close-all-btn" class="yl-btn btn-secondary">
            Close All
          </button>
        </div>
      </div>
    </>
  );
}

import { state, type LyricsLine, type TimedTextJson } from './state';

// 1 行の歌詞から「主歌詞 / 翻訳」を分離し、安全な文字列データへ正規化する。
export function parseLineText(text: string) {
  let mainText = text;
  let subText = '';

  // 「末尾の括弧だけ」を翻訳扱いにし、歌詞本体中の括弧はできるだけ壊さない。
  const translationMatch = text.match(/[\(（](.+?)[\)）]$/);
  if (translationMatch) {
    subText = translationMatch[1];
    mainText = text.replace(translationMatch[0], '').trim();
  }

  return { mainText, subText };
}

// LRC 本文を基準版と同じルールで走査し、rawSubtitleData から終端時刻を補完する。
export function parseLRC(lrcText: string) {
  const lines = lrcText.split('\n');
  const result: LyricsLine[] = [];
  const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;

  lines.forEach((line) => {
    const match = line.match(timeRegex);
    const rawContent = line.replace(timeRegex, '').trim();
    if (!match || !rawContent) return;

    const min = parseInt(match[1], 10);
    const sec = parseInt(match[2], 10);
    const ms = parseInt(match[3], 10);
    const time = min * 60 + sec + ms / (match[3].length === 3 ? 1000 : 100);
    const parsed = parseLineText(rawContent);
    const matchText = parsed.mainText || rawContent;

    let endTime: number | null = null;
    const matchedRaw = state.rawSubtitleData.find(
      (raw) => Math.abs(raw.start - time) < 0.5 && (raw.text.includes(matchText) || matchText.includes(raw.text))
    );

    if (matchedRaw && matchedRaw.end > time) {
      endTime = matchedRaw.end;
    }

    result.push({ time, endTime, mainText: parsed.mainText, subText: parsed.subText || undefined });
  });

  return result.sort((a, b) => a.time - b.time);
}

// 主字幕を基準に 2 本の LRC を 1 行ずつ結合し、翻訳は末尾の括弧へ寄せる。
export function mergeLrc(primaryLrc: string, secondaryLrc: string) {
  if (!secondaryLrc) return primaryLrc;

  // タイムスタンプ単位の Map に落とし、Primary に存在する行だけを最終結果へ残す。
  const parseSimple = (text: string) => {
    const map = new Map<string, string>();
    text.split('\n').forEach((line) => {
      const match = line.match(/\[\d{2}:\d{2}\.\d{2,3}\]/);
      if (match) {
        map.set(match[0], line.replace(match[0], '').trim());
      }
    });
    return map;
  };

  const primaryMap = parseSimple(primaryLrc);
  const secondaryMap = parseSimple(secondaryLrc);
  let merged = '';

  for (const [time, text] of primaryMap) {
    // 同文のときは括弧付き翻訳を作らず、原文だけを残して重複感を防ぐ。
    const secondaryText = secondaryMap.get(time);
    merged += secondaryText && secondaryText !== text ? `${time} ${text} (${secondaryText})\n` : `${time} ${text}\n`;
  }

  return merged;
}

export function formatTimeLRC(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  const ms = Math.floor((seconds % 1) * 100).toString().padStart(2, '0');
  return `[${minutes}:${secs}.${ms}]`;
}

// 無音区間を間奏スペーサーに変換し、終端演出用のダミー行も最後に追加する。
export function insertInstrumentalBreaks(data: LyricsLine[]) {
  if (!data || data.length < 2) return data;

  const nextData: LyricsLine[] = [];

  for (let i = 0; i < data.length; i += 1) {
    // 元の歌詞行は必ず先に積み、その後ろへ必要な間奏スペーサーだけを挿入する。
    nextData.push(data[i]);

    if (i >= data.length - 1 || !data[i].endTime) continue;

    const gap = data[i + 1].time - (data[i].endTime || 0);
    // 3 秒以上空いた区間だけを「見せるべき間奏」とみなす。
    if (gap >= 3.0) {
      const instrumentalTime = data[i].endTime as number;
      if (instrumentalTime < data[i + 1].time) {
        nextData.push({
          time: instrumentalTime,
          mainText: '',
          isInstrumental: true
        });
      }
    }
  }

  if (data.length > 0) {
    const lastLine = data[data.length - 1];
    // 最終行の後ろにも終端演出用のダミー間奏を 1 つ置いて finished 判定に使う。
    const baseEndTime = lastLine.endTime ? lastLine.endTime : lastLine.time + 10.0;
    nextData.push({
      time: baseEndTime,
      mainText: '',
      isInstrumental: true
    });
  }

  return nextData.sort((a, b) => a.time - b.time);
}

// json3 字幕はここで LRC 化しつつ、元の start/end を rawSubtitleData に保存する。
export function parseTimedTextJsonToLrc(json: TimedTextJson) {
  if (!json?.events) return '';

  let lrcOutput = '';
  // 新しい字幕を読むたびに rawSubtitleData を更新し、古い動画の時刻情報を混ぜない。
  state.rawSubtitleData = [];

  json.events.forEach((event) => {
    if (!event.segs || event.tStartMs === undefined) return;

    // YouTube の segs は改行や分割片を含むので、表示前に 1 行へ畳み込む。
    const text = event.segs
      .map((segment) => segment.utf8 || '')
      .join('')
      .replace(/[\r\n]+/g, ' ')
      .trim();

    if (text && text !== '\n' && !/^\[.+\]$/.test(text)) {
      const timeSec = parseInt(String(event.tStartMs), 10) / 1000;
      // dDurationMs は存在しないこともあるため、欠損時は 0 秒として扱う。
      const durationSec = event.dDurationMs ? parseInt(String(event.dDurationMs), 10) / 1000 : 0;

      state.rawSubtitleData.push({
        start: timeSec,
        end: timeSec + durationSec,
        text
      });

      lrcOutput += `${formatTimeLRC(timeSec)} ${text}\n`;
    }
  });

  return lrcOutput;
}

// XML 字幕も同じデータ構造へ正規化して、以後の処理を共通化する。
export function parseTimedTextXmlToLrc(xmlText: string) {
  if (!xmlText) return '';

  state.rawSubtitleData = [];

  try {
    // 古い timedtext 形式は text ノード単位で走査し、JSON 版と同じ構造へ正規化する。
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const nodes = Array.from(doc.getElementsByTagName('text'));
    let output = '';

    for (const node of nodes) {
      const startSec = parseFloat(node.getAttribute('start') || '');
      const durationSec = parseFloat(node.getAttribute('dur') || '0');
      const text = (node.textContent || '').replace(/[\r\n]+/g, ' ').trim();

      if (Number.isFinite(startSec) && text && !/^\[.+\]$/.test(text)) {
        state.rawSubtitleData.push({
          start: startSec,
          end: startSec + durationSec,
          text
        });

        output += `${formatTimeLRC(startSec)} ${text}\n`;
      }
    }

    return output;
  } catch (error) {
    console.warn('[YouTube LyricFlow] Failed to parse timedtext XML.', error);
    return '';
  }
}

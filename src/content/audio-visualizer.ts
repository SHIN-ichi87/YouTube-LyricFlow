import { byId, state } from './state';
import { showToast } from './interactions';

interface CapturableVideoElement extends HTMLVideoElement {
  captureStream?: () => MediaStream;
}

// 低〜中域の音程差を拾いやすくするため、約2倍の周波数分解能を確保する。
const FFT_SIZE = 4096;
const TRANSIENT_FFT_SIZE = 1024;
const BAR_COUNT_PER_SIDE = 24;
const SOURCE_RETRY_INTERVAL_MS = 1000;
const NO_SIGNAL_NOTICE_MS = 4000;
const MAX_DEVICE_PIXEL_RATIO = 2;
const ORBIT_SPECTRUM_POINT_COUNT = 92;
const ORBIT_MESH_LAYER_COUNT = 16;
const ORBIT_TARGET_FRAME_INTERVAL_MS = 1000 / 30;
const ORBIT_MAX_DEVICE_PIXEL_RATIO = 1.25;

// Mirror Spectrum の位置とサイズはここだけを触れば調整できる。
// ratio はCanvas全体に対する割合。横幅はプレイヤー端まで使い、下端から上へ伸ばす。
const MIRROR_SPECTRUM_LAYOUT = {
  centerXRatio: 0.5,
  baselineYRatio: 1,
  bottomInsetPx: 2,
  halfWidthRatio: 0.5,
  horizontalInsetPx: 0,
  maxHeightRatio: 0.34,
  maxHeightPx: 280
} as const;

// Orbit Spectrum は映像の右側へ収め、歌詞の主表示領域をなるべく塞がない。
// 半径は縦横両方から制限し、通常表示・シアター・全画面のいずれでも欠けないようにする。
const ORBIT_SPECTRUM_LAYOUT = {
  centerXRatio: 0.75,
  centerYRatio: 0.47,
  maxRadiusHeightRatio: 0.38,
  maxRadiusWidthRatio: 0.225,
  maxRadiusPx: 280,
  edgePaddingRatio: 1.1
} as const;

const MIN_ANALYZED_FREQUENCY_HZ = 45;
const MAX_ANALYZED_FREQUENCY_HZ = 16000;
// 45Hz付近の超低域より、キックの芯が出やすい約70〜100Hzを最外周へ合わせる。
const EDGE_BASS_BAND_INDEX = 2;

type RgbColor = readonly [number, number, number];

function mixColor(from: RgbColor, to: RgbColor, amount: number): RgbColor {
  return [
    Math.round(from[0] + (to[0] - from[0]) * amount),
    Math.round(from[1] + (to[1] - from[1]) * amount),
    Math.round(from[2] + (to[2] - from[2]) * amount)
  ];
}

function rgba(color: RgbColor, alpha: number) {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
}

// 60Hz時の係数を、実際の経過時間でも同じ実時間応答になる係数へ変換する。
function getTimeAdjustedEasing(easingAt60Hz: number, frameScale: number) {
  return 1 - Math.pow(1 - easingAt60Hz, frameScale);
}

interface OnsetDetectorState {
  previousEnergy: number;
  averageFlux: number;
  pulse: number;
  decay: number;
  thresholdMultiplier: number;
  minimumFlux: number;
  sensitivity: number;
}

function createOnsetDetector(
  decay: number,
  thresholdMultiplier: number,
  minimumFlux: number,
  sensitivity: number
): OnsetDetectorState {
  return {
    previousEnergy: 0,
    averageFlux: minimumFlux,
    pulse: 0,
    decay,
    thresholdMultiplier,
    minimumFlux,
    sensitivity
  };
}

class AudioSpectrumVisualizer {
  // Canvasまわりの参照。
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private animationFrame: number | null = null;

  // YouTubeの音声を解析するためのノード。
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private transientAnalyser: AnalyserNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private capturedStream: MediaStream | null = null;
  private connectedVideo: CapturableVideoElement | null = null;
  private connectedSource = '';

  // 毎フレーム使い回す解析バッファ。
  private frequencyData = new Uint8Array(FFT_SIZE / 2);
  private transientFrequencyData = new Uint8Array(TRANSIENT_FFT_SIZE / 2);
  private timeDomainData = new Float32Array(FFT_SIZE);

  // 画面に出す棒と、短い残光の状態。
  private displayedBars = new Float32Array(BAR_COUNT_PER_SIDE);
  private trailBars = new Float32Array(BAR_COUNT_PER_SIDE);
  private trailOpacity = new Float32Array(BAR_COUNT_PER_SIDE);

  // Orbitは直近の輪郭を内側へ送ることで、少ないPathでも密度のある面を作る。
  private orbitProfile = new Float32Array(ORBIT_SPECTRUM_POINT_COUNT);
  private orbitTargetProfile = new Float32Array(ORBIT_SPECTRUM_POINT_COUNT);
  private orbitContourX = new Float32Array(ORBIT_SPECTRUM_POINT_COUNT);
  private orbitContourY = new Float32Array(ORBIT_SPECTRUM_POINT_COUNT);
  private orbitHistory = Array.from(
    { length: ORBIT_MESH_LAYER_COUNT },
    () => new Float32Array(ORBIT_SPECTRUM_POINT_COUNT)
  );
  private orbitHistoryCursor = 0;
  private orbitHistoryCount = 0;

  // 各周波数帯の現在値と、前フレームからの変化量。
  private bandEnergy = new Float32Array(BAR_COUNT_PER_SIDE);
  private bandFlux = new Float32Array(BAR_COUNT_PER_SIDE);
  private bandDrop = new Float32Array(BAR_COUNT_PER_SIDE);
  private melodyBars = new Float32Array(BAR_COUNT_PER_SIDE);
  private melodyTargets = new Float32Array(BAR_COUNT_PER_SIDE);
  private previousBandEnergy = new Float32Array(BAR_COUNT_PER_SIDE);

  // 楽器ごとに立ち上がりの癖が違うため、検出器を分けている。
  private kickDetector = createOnsetDetector(0.84, 1.65, 0.012, 9);
  private snareDetector = createOnsetDetector(0.88, 1.55, 0.01, 10);
  private hatDetector = createOnsetDetector(0.78, 1.5, 0.008, 12);

  // 曲全体の音量差と、音数の多さをゆっくり追う値。
  private shortTermLoudness = 0;
  private loudnessFloor = 1;
  private loudnessCeiling = 0;
  private macroEnergy = 0;
  private arrangementDensity = 0;
  private climaxEnergy = 0;

  // 一瞬だけ使う演出用のパルス。
  private kickVisualPulse = 0;
  private snareVisualPulse = 0;
  private hatVisualPulse = 0;
  private climaxBurst = 0;
  private climaxBurstExpansion = 0;
  private climaxThresholdLatched = false;

  // 接続状態と時刻を保持する。
  private hasLoudnessSample = false;
  private active = false;
  private lastSampleAt = 0;
  private lastOrbitFrameAt = 0;
  private lastSourceAttempt = 0;
  private lastSignalAt = 0;
  private audioStatus: 'connecting' | 'ready' | 'silent' | 'unsupported' = 'connecting';

  // モードを有効にして描画ループを始める。
  start() {
    if (this.active) {
      this.ensureLayer();
      // Mirror と Orbit では解像度上限が異なるため、モード切替時にも再計測する。
      this.resizeCanvas();
      return;
    }

    this.active = true;
    this.lastSignalAt = performance.now();
    this.ensureLayer();
    document.addEventListener('pointerdown', this.resumeAudioContext, true);
    void this.ensureAudioSource(true);
    this.animationFrame = window.requestAnimationFrame(this.render);
  }

  // Canvasと音声接続を片付けて初期状態へ戻す。
  stop() {
    this.active = false;
    if (this.animationFrame !== null) {
      window.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.canvas?.parentElement?.classList.remove('visual-active');
    this.canvas?.remove();
    this.canvas = null;
    this.context = null;
    document.removeEventListener('pointerdown', this.resumeAudioContext, true);
    this.disconnectAudioSource();

    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }

    this.displayedBars.fill(0);
    this.trailBars.fill(0);
    this.trailOpacity.fill(0);
    this.orbitProfile.fill(0);
    this.orbitTargetProfile.fill(0);
    this.orbitHistory.forEach((profile) => profile.fill(0));
    this.orbitHistoryCursor = 0;
    this.orbitHistoryCount = 0;
    this.bandEnergy.fill(0);
    this.bandFlux.fill(0);
    this.bandDrop.fill(0);
    this.melodyBars.fill(0);
    this.melodyTargets.fill(0);
    this.previousBandEnergy.fill(0);
    this.kickDetector = createOnsetDetector(0.84, 1.65, 0.012, 9);
    this.snareDetector = createOnsetDetector(0.88, 1.55, 0.01, 10);
    this.hatDetector = createOnsetDetector(0.78, 1.5, 0.008, 12);
    this.shortTermLoudness = 0;
    this.loudnessFloor = 1;
    this.loudnessCeiling = 0;
    this.macroEnergy = 0;
    this.arrangementDensity = 0;
    this.climaxEnergy = 0;
    this.kickVisualPulse = 0;
    this.snareVisualPulse = 0;
    this.hatVisualPulse = 0;
    this.climaxBurst = 0;
    this.climaxBurstExpansion = 0;
    this.climaxThresholdLatched = false;
    this.lastSampleAt = 0;
    this.lastOrbitFrameAt = 0;
    this.hasLoudnessSample = false;
  }

  // YouTubeの動画が切り替わった時に音声をつなぎ直す。
  refreshSource() {
    this.connectedSource = '';
    this.disconnectAudioSource();
    if (this.active) void this.ensureAudioSource(true);
  }

  // 歌詞コンテナの一番下へVisualizer用Canvasを置く。
  private ensureLayer() {
    const container = byId<HTMLDivElement>('yl-container');
    if (!container) return;

    if (this.canvas?.isConnected && this.canvas.parentElement === container) return;

    this.resizeObserver?.disconnect();
    this.canvas?.parentElement?.classList.remove('visual-active');
    this.canvas?.remove();

    const canvas = document.createElement('canvas');
    canvas.id = 'yl-visual-layer';
    canvas.classList.add('active');
    canvas.setAttribute('aria-hidden', 'true');
    container.prepend(canvas);
    container.classList.add('visual-active');

    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.resizeCanvas();

    this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
    this.resizeObserver.observe(container);
  }

  // Retinaでもぼやけないよう、表示サイズに合わせてCanvasを作り直す。
  private resizeCanvas() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const pixelRatio = this.getRenderPixelRatio();
    const width = Math.max(1, Math.round(rect.width * pixelRatio));
    const height = Math.max(1, Math.round(rect.height * pixelRatio));

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  private getRenderPixelRatio() {
    const maximum = state.userSettings.visualMode === 'orbit-spectrum'
      ? ORBIT_MAX_DEVICE_PIXEL_RATIO
      : MAX_DEVICE_PIXEL_RATIO;
    return Math.min(window.devicePixelRatio || 1, maximum);
  }

  // 再接続前に古いStreamとNodeを閉じる。
  private disconnectAudioSource() {
    this.sourceNode?.disconnect();
    this.sourceNode = null;
    this.analyser = null;
    this.transientAnalyser = null;
    this.capturedStream?.getTracks().forEach((track) => track.stop());
    this.capturedStream = null;
    this.connectedVideo = null;
  }

  // ブラウザの自動再生制限で停止したAudioContextを操作時に再開する。
  private resumeAudioContext = () => {
    if (this.audioContext?.state === 'suspended') {
      void this.audioContext.resume();
    }
  };

  // 現在のvideo要素から音声Trackを取得する。
  private async ensureAudioSource(force = false) {
    const now = performance.now();
    if (!force && now - this.lastSourceAttempt < SOURCE_RETRY_INTERVAL_MS) return;
    this.lastSourceAttempt = now;

    const video = document.querySelector<CapturableVideoElement>('video');
    if (!video) {
      this.audioStatus = 'connecting';
      return;
    }

    const sourceIdentity = video.currentSrc || video.src;
    if (this.analyser && video === this.connectedVideo && sourceIdentity === this.connectedSource) {
      if (this.audioContext?.state === 'suspended') {
        await this.audioContext.resume().catch(() => undefined);
      }
      return;
    }

    this.disconnectAudioSource();
    this.connectedVideo = video;
    this.connectedSource = sourceIdentity;

    if (typeof video.captureStream !== 'function') {
      this.audioStatus = 'unsupported';
      return;
    }

    try {
      const capturedStream = video.captureStream();
      const audioTracks = capturedStream.getAudioTracks();
      if (audioTracks.length === 0) {
        capturedStream.getTracks().forEach((track) => track.stop());
        this.audioStatus = 'connecting';
        return;
      }

      const audioOnlyStream = new MediaStream(audioTracks);
      capturedStream.getVideoTracks().forEach((track) => track.stop());
      this.capturedStream = audioOnlyStream;

      const AudioContextConstructor = window.AudioContext;
      const audioContext = this.audioContext ?? new AudioContextConstructor();
      this.audioContext = audioContext;
      await audioContext.resume().catch(() => undefined);

      // モードOFFやSPA遷移が await 中に発生した場合、古い音声へ再接続しない。
      if (!this.active || this.capturedStream !== audioOnlyStream) return;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      // 打音の立ち上がりを潰さない程度にだけ平滑化する。
      analyser.smoothingTimeConstant = 0.32;
      analyser.minDecibels = -90;
      // 0dB側へ余白を広げ、マスタリング音量の大きい曲でもバーが上限へ張り付かないようにする。
      analyser.maxDecibels = -6;

      // 打音専用は短い解析窓と弱い平滑化で、Kick・Snare・Hatの遅延を抑える。
      const transientAnalyser = audioContext.createAnalyser();
      transientAnalyser.fftSize = TRANSIENT_FFT_SIZE;
      transientAnalyser.smoothingTimeConstant = 0.14;
      transientAnalyser.minDecibels = -90;
      transientAnalyser.maxDecibels = -6;

      const sourceNode = audioContext.createMediaStreamSource(audioOnlyStream);
      sourceNode.connect(analyser);
      sourceNode.connect(transientAnalyser);

      this.sourceNode = sourceNode;
      this.analyser = analyser;
      this.transientAnalyser = transientAnalyser;
      this.frequencyData = new Uint8Array(analyser.frequencyBinCount);
      this.transientFrequencyData = new Uint8Array(transientAnalyser.frequencyBinCount);
      this.timeDomainData = new Float32Array(analyser.fftSize);
      this.shortTermLoudness = 0;
      this.loudnessFloor = 1;
      this.loudnessCeiling = 0;
      this.macroEnergy = 0;
      this.arrangementDensity = 0;
      this.climaxEnergy = 0;
      this.kickVisualPulse = 0;
      this.snareVisualPulse = 0;
      this.hatVisualPulse = 0;
      this.climaxBurst = 0;
      this.climaxBurstExpansion = 0;
      this.climaxThresholdLatched = false;
      this.lastSampleAt = 0;
      this.hasLoudnessSample = false;
      this.lastSignalAt = performance.now();
      this.audioStatus = 'ready';
    } catch (error) {
      console.warn('[LyricFlow] Audio visualizer could not capture YouTube audio.', error);
      this.audioStatus = 'unsupported';
      this.disconnectAudioSource();
    }
  }

  // 指定した周波数範囲の平均的な強さを返す。
  private getRangeEnergy(
    minHz: number,
    maxHz: number,
    nyquist: number,
    frequencyData = this.frequencyData
  ) {
    const startBin = Math.max(1, Math.floor((minHz / nyquist) * frequencyData.length));
    const endBin = Math.min(
      frequencyData.length,
      Math.max(startBin + 1, Math.ceil((maxHz / nyquist) * frequencyData.length))
    );

    let sumSquares = 0;
    let maximum = 0;
    let sampleCount = 0;
    for (let bin = startBin; bin < endBin; bin += 1) {
      const sample = frequencyData[bin] / 255;
      sumSquares += sample * sample;
      maximum = Math.max(maximum, sample);
      sampleCount += 1;
    }

    const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
    return rms * 0.82 + maximum * 0.18;
  }

  // 急に音が立ち上がった瞬間だけ短いパルスを作る。
  private updateOnsetDetector(detector: OnsetDetectorState, energy: number, frameScale: number) {
    // フレーム間差分を60Hz相当に正規化し、高Hz環境でFluxが過小になることを防ぐ。
    const flux = Math.max(0, energy - detector.previousEnergy) / Math.max(0.25, frameScale);
    const threshold = Math.max(detector.minimumFlux, detector.averageFlux * detector.thresholdMultiplier);
    const hit = flux > threshold
      ? Math.min(1, (flux - threshold) * detector.sensitivity)
      : 0;

    detector.pulse = Math.max(detector.pulse * Math.pow(detector.decay, frameScale), hit);
    const fluxEasing = getTimeAdjustedEasing(0.06, frameScale);
    detector.averageFlux += (flux - detector.averageFlux) * fluxEasing;
    detector.previousEnergy = energy;
    return detector.pulse;
  }

  // 1本の反応を隣の棒へ自然に広げる。
  private getGaussianProfile(index: number, center: number, spread: number) {
    const distance = (index - center) / spread;
    return Math.exp(-0.5 * distance * distance);
  }

  // 曲全体の音量を追い、Aメロとサビの大きさの差を作る。
  private updateMacroDynamics(frameScale: number) {
    if (!this.analyser) return 0;

    this.analyser.getFloatTimeDomainData(this.timeDomainData);
    let sumSquares = 0;
    for (let i = 0; i < this.timeDomainData.length; i += 1) {
      const sample = this.timeDomainData[i];
      sumSquares += sample * sample;
    }

    const rms = Math.sqrt(sumSquares / Math.max(1, this.timeDomainData.length));
    const decibels = 20 * Math.log10(Math.max(rms, 0.000001));
    // おおよそ -52dBFS〜-8dBFS を、静寂〜大音量として0〜1へ写像する。
    const absoluteLoudness = Math.min(1, Math.max(0, (decibels + 52) / 44));

    // 冒頭の完全な無音を「曲内の静かな基準」として学習すると、その後のAメロまで最大扱いになるため除外する。
    if (!this.hasLoudnessSample && absoluteLoudness < 0.03) {
      return 0;
    }

    if (!this.hasLoudnessSample) {
      this.shortTermLoudness = absoluteLoudness;
      this.loudnessFloor = absoluteLoudness;
      this.loudnessCeiling = absoluteLoudness;
      this.macroEnergy = absoluteLoudness * 0.55;
      this.hasLoudnessSample = true;
      return this.macroEnergy;
    }

    // 短期音量は上昇を速く、下降を遅くして、フレーズ単位の勢いとして扱う。
    const loudnessEasing = getTimeAdjustedEasing(
      absoluteLoudness > this.shortTermLoudness ? 0.14 : 0.04,
      frameScale
    );
    this.shortTermLoudness += (absoluteLoudness - this.shortTermLoudness) * loudnessEasing;

    // 曲内の静かな基準と大きい基準は即座に外側へ広げ、内側へは非常にゆっくり戻す。
    // これによりAメロとサビの相対差を、曲ごとのマスタリング音量に依存せず保持する。
    if (this.shortTermLoudness > 0.06) {
      this.loudnessFloor = this.shortTermLoudness < this.loudnessFloor
        ? this.shortTermLoudness
        : this.loudnessFloor +
          (this.shortTermLoudness - this.loudnessFloor) * getTimeAdjustedEasing(0.0006, frameScale);
    }
    this.loudnessCeiling = this.shortTermLoudness > this.loudnessCeiling
      ? this.shortTermLoudness
      : this.loudnessCeiling +
        (this.shortTermLoudness - this.loudnessCeiling) * getTimeAdjustedEasing(0.00035, frameScale);

    const learnedRange = this.loudnessCeiling - this.loudnessFloor;
    // 約0.9dB相当から相対音量を使い始め、約2.6dBで完全に学習値へ移行する。
    const learnedRelativeLoudness = learnedRange > 0.02
      ? Math.min(1, Math.max(0, (this.shortTermLoudness - this.loudnessFloor) / learnedRange))
      : 0.35;
    const rangeConfidence = Math.min(1, Math.max(0, (learnedRange - 0.02) / 0.04));
    const relativeLoudness = 0.35 + (learnedRelativeLoudness - 0.35) * rangeConfidence;
    const silenceGate = Math.min(1, absoluteLoudness * 1.8);
    const macroTarget = (absoluteLoudness * 0.42 + relativeLoudness * 0.58) * silenceGate;
    const macroEasing = getTimeAdjustedEasing(
      macroTarget > this.macroEnergy ? 0.075 : 0.018,
      frameScale
    );
    this.macroEnergy += (macroTarget - this.macroEnergy) * macroEasing;
    return this.macroEnergy;
  }

  // 低・中・高域の鳴り方から、編成の厚さとサビらしさを求める。
  private updateArrangementDynamics(macroEnergy: number, frameScale: number) {
    let audibleBandTotal = 0;
    const groupTotals = [0, 0, 0];
    const groupCounts = [0, 0, 0];

    for (let i = 0; i < BAR_COUNT_PER_SIDE; i += 1) {
      const audibleEnergy = Math.min(1, Math.max(0, (this.bandEnergy[i] - 0.16) / 0.45));
      const weightedPresence = Math.pow(audibleEnergy, 1.3);
      audibleBandTotal += weightedPresence;

      const groupIndex = Math.min(2, Math.floor((i / BAR_COUNT_PER_SIDE) * 3));
      groupTotals[groupIndex] += weightedPresence;
      groupCounts[groupIndex] += 1;
    }

    const coverage = audibleBandTotal / BAR_COUNT_PER_SIDE;
    const groupPresence = groupTotals.map((total, index) => {
      return total / Math.max(1, groupCounts[index]);
    });
    // 低・中・高域のすべてが鳴っている時だけ広帯域として扱う。
    const broadBandPresence = Math.min(...groupPresence);
    const densityTarget = Math.min(1, coverage * 0.65 + broadBandPresence * 0.35);
    const densityEasing = getTimeAdjustedEasing(
      densityTarget > this.arrangementDensity ? 0.11 : 0.025,
      frameScale
    );
    this.arrangementDensity += (densityTarget - this.arrangementDensity) * densityEasing;

    // 大音量だけ、または音数が多いだけではクライマックスにしない。両方が揃った時だけU字を出す。
    const combinedEnergy = macroEnergy * this.arrangementDensity;
    const climaxProgress = Math.min(1, Math.max(0, (combinedEnergy - 0.16) / 0.46));
    const smoothClimax = climaxProgress * climaxProgress * (3 - 2 * climaxProgress);
    const climaxEasing = getTimeAdjustedEasing(
      smoothClimax > this.climaxEnergy ? 0.11 : 0.018,
      frameScale
    );
    this.climaxEnergy += (smoothClimax - this.climaxEnergy) * climaxEasing;

    // サビ域へ入った瞬間だけワンショットを発火し、下降後に再び発火可能にする。
    if (!this.climaxThresholdLatched && this.climaxEnergy >= 0.55) {
      this.climaxBurst = 1;
      this.climaxBurstExpansion = 0;
      this.climaxThresholdLatched = true;
      showToast('DEBUG: サビ突入・高さ +150%');
    } else {
      this.climaxBurst *= Math.pow(0.97, frameScale);
      this.climaxBurstExpansion +=
        (1 - this.climaxBurstExpansion) * getTimeAdjustedEasing(0.16, frameScale);
      if (this.climaxEnergy < 0.42) this.climaxThresholdLatched = false;
    }

    return this.climaxEnergy;
  }

  // 声や旋律楽器の目立つ音程を少数の棒へまとめる。
  private updateMelodyLayer(frequencyRangeRatio: number, frameScale: number) {
    this.melodyTargets.fill(0);
    const selectedPeakIndexes: number[] = [];

    // 主音と補助音だけを追い、単音の倍音だけで画面全域が動くことを避ける。
    for (let selection = 0; selection < 2; selection += 1) {
      let bestIndex = -1;
      let bestScore = 0;

      for (let i = 2; i < BAR_COUNT_PER_SIDE - 2; i += 1) {
        if (selectedPeakIndexes.some((index) => Math.abs(index - i) <= 2)) continue;

        const centerRatio = (i + 0.5) / BAR_COUNT_PER_SIDE;
        const centerFrequency = MIN_ANALYZED_FREQUENCY_HZ * Math.pow(frequencyRangeRatio, centerRatio);
        if (centerFrequency < 90 || centerFrequency > 6000) continue;

        const neighborEnergy =
          (this.bandEnergy[i - 2] + this.bandEnergy[i - 1] + this.bandEnergy[i + 1] + this.bandEnergy[i + 2]) / 4;
        const prominence = Math.max(0, this.bandEnergy[i] - neighborEnergy * 0.9);
        // 倍音より基音・主旋律を選びやすいよう、高域へ行くほどごく軽く重みを下げる。
        const pitchPriority = 1 - Math.min(0.28, Math.max(0, Math.log2(centerFrequency / 180)) * 0.055);
        const score = (
          prominence * 1.8 +
          this.bandFlux[i] * 0.22 +
          Math.max(0, this.bandEnergy[i] - 0.18) * 0.08
        ) * pitchPriority;

        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }

      if (bestIndex === -1 || bestScore < 0.018) break;
      selectedPeakIndexes.push(bestIndex);

      const peakHeight = Math.min(
        0.48,
        bestScore * 2.1 + this.bandEnergy[bestIndex] * 0.08 + this.bandFlux[bestIndex] * 0.35
      ) * (selection === 0 ? 1 : 0.56);
      // 隣接バーへ広げすぎず、同じ音の中でも各帯域が個別に動いて見える幅に留める。
      const spread = bestIndex < 12 ? 1.18 : 0.86;
      for (let i = 0; i < BAR_COUNT_PER_SIDE; i += 1) {
        this.melodyTargets[i] = Math.max(
          this.melodyTargets[i],
          peakHeight * this.getGaussianProfile(i, bestIndex, spread)
        );
      }
    }

    for (let i = 0; i < BAR_COUNT_PER_SIDE; i += 1) {
      // 持続音は局所的に目立つ帯域へ寄せ、単音時の全域的な底上げを防ぐ。
      const sustainedEnergy = Math.max(0, (this.bandEnergy[i] - 0.12) / 0.88);
      const neighborEnergy = (
        this.bandEnergy[Math.max(0, i - 1)] +
        this.bandEnergy[Math.min(BAR_COUNT_PER_SIDE - 1, i + 1)]
      ) / 2;
      const sustainedFocus = Math.min(
        1,
        Math.max(0, (this.bandEnergy[i] - neighborEnergy * 0.9) / 0.12)
      );
      const densitySupport = Math.min(1, Math.max(0, (this.arrangementDensity - 0.12) / 0.36));
      this.melodyTargets[i] = Math.max(
        this.melodyTargets[i],
        Math.pow(sustainedEnergy, 1.65) * 0.08 * (0.18 + Math.max(sustainedFocus, densitySupport) * 0.82)
      );

      const previous = this.melodyBars[i];
      // 音程が変わった時に古い位置を引きずらず、新しい位置へ明確に移動させる。
      const easing = getTimeAdjustedEasing(
        this.melodyTargets[i] > previous ? 0.62 : 0.3,
        frameScale
      );
      this.melodyBars[i] = previous + (this.melodyTargets[i] - previous) * easing;
    }
  }

  // 音声を1フレーム分解析して、次に表示する棒の高さを決める。
  private sampleBars(now: number) {
    const elapsedMs = this.lastSampleAt > 0 ? now - this.lastSampleAt : 1000 / 60;
    // 極端なタブ復帰値は抑えつつ、60Hzを1とする実時間倍率へ変換する。
    const frameScale = Math.min(4, Math.max(0.25, elapsedMs / (1000 / 60)));
    this.lastSampleAt = now;

    if (!this.analyser) {
      for (let i = 0; i < this.displayedBars.length; i += 1) {
        this.displayedBars[i] *= Math.pow(0.9, frameScale);
      }
      return;
    }

    this.analyser.getByteFrequencyData(this.frequencyData);
    this.transientAnalyser?.getByteFrequencyData(this.transientFrequencyData);
    const macroEnergy = this.updateMacroDynamics(frameScale);
    let peak = 0;

    for (let i = 0; i < this.frequencyData.length; i += 1) {
      peak = Math.max(peak, this.frequencyData[i]);
    }

    const sampleRate = this.audioContext?.sampleRate ?? 48000;
    const nyquist = sampleRate / 2;
    const maxFrequency = Math.min(MAX_ANALYZED_FREQUENCY_HZ, nyquist);
    const frequencyRangeRatio = maxFrequency / MIN_ANALYZED_FREQUENCY_HZ;

    for (let i = 0; i < BAR_COUNT_PER_SIDE; i += 1) {
      // 解析配列は低域→高域の固定順。描画時だけ反転し、音と位置の対応を崩さず谷型へする。
      const startRatio = i / BAR_COUNT_PER_SIDE;
      const endRatio = (i + 1) / BAR_COUNT_PER_SIDE;
      const startFrequency = MIN_ANALYZED_FREQUENCY_HZ * Math.pow(frequencyRangeRatio, startRatio);
      const endFrequency = MIN_ANALYZED_FREQUENCY_HZ * Math.pow(frequencyRangeRatio, endRatio);
      const rawEnergy = this.getRangeEnergy(startFrequency, endFrequency, nyquist);
      const highFrequencyLift = 0.9 + endRatio * 0.5;
      const weightedEnergy = Math.min(1, rawEnergy * highFrequencyLift);

      const previousEnergy = this.previousBandEnergy[i];
      this.bandEnergy[i] = weightedEnergy;
      this.bandFlux[i] = Math.max(0, weightedEnergy - previousEnergy) / frameScale;
      // その帯域が何割の速さで消えたかを保持し、棒の下降速度へ反映する。
      this.bandDrop[i] = Math.min(
        1,
        Math.max(0, (previousEnergy - weightedEnergy) / Math.max(0.08, previousEnergy)) / frameScale
      );
      this.previousBandEnergy[i] = weightedEnergy;
    }

    this.updateArrangementDynamics(macroEnergy, frameScale);
    this.updateMelodyLayer(frequencyRangeRatio, frameScale);

    // 打楽器は絶対音量ではなく、対応帯域が急に立ち上がった瞬間を検出する。
    const transientData = this.transientAnalyser ? this.transientFrequencyData : this.frequencyData;
    const kickEnergy = this.getRangeEnergy(45, 140, nyquist, transientData);
    const snareEnergy =
      this.getRangeEnergy(160, 320, nyquist, transientData) * 0.42 +
      this.getRangeEnergy(1800, 5200, nyquist, transientData) * 0.58;
    const hatEnergy = this.getRangeEnergy(6000, 14000, nyquist, transientData);
    const kickPulse = this.updateOnsetDetector(this.kickDetector, kickEnergy, frameScale);
    const snarePulse = this.updateOnsetDetector(this.snareDetector, snareEnergy, frameScale);
    const hatPulse = this.updateOnsetDetector(this.hatDetector, hatEnergy, frameScale);
    this.kickVisualPulse = kickPulse;
    this.snareVisualPulse = snarePulse;
    this.hatVisualPulse = hatPulse;

    for (let i = 0; i < BAR_COUNT_PER_SIDE; i += 1) {
      const noiseFloor = 0.16;
      const gatedEnergy = Math.max(0, (this.bandEnergy[i] - noiseFloor) / (1 - noiseFloor));
      const neighborEnergy = (
        this.bandEnergy[Math.max(0, i - 1)] +
        this.bandEnergy[Math.min(BAR_COUNT_PER_SIDE - 1, i + 1)]
      ) / 2;
      const localFocus = Math.min(
        1,
        Math.max(0, (this.bandEnergy[i] - neighborEnergy * 0.9) / 0.14)
      );
      const densitySpread = Math.min(1, Math.max(0, (this.arrangementDensity - 0.1) / 0.34));
      const spectralSeparation = 0.16 + Math.max(localFocus, densitySpread) * 0.84;
      // 通常スペクトラム、旋律の持続ピーク、打楽器オンセットを独立した層として合成する。
      const spectrumBase = Math.pow(gatedEnergy, 1.65) * 0.16 * spectralSeparation;
      const melodyLayer = this.melodyBars[i] * 0.78;
      const localTransient = Math.min(1, this.bandFlux[i] * 6) * 0.24 * (0.3 + localFocus * 0.7);

      // 配列上はキック低域、スネアの胴鳴り・スナッピー、ハイハット高域の固定位置で跳ねる。
      // 描画時に配列を反転するため、画面上ではキックが端、ハイハットが中央側になる。
      const lastBarIndex = BAR_COUNT_PER_SIDE - 1;
      const barCountScale = BAR_COUNT_PER_SIDE / 38;
      const kickProfile = this.getGaussianProfile(i, lastBarIndex * 0.08, 2.05 * barCountScale);
      const snareProfile =
        this.getGaussianProfile(i, lastBarIndex * 0.35, 2.65 * barCountScale) * 0.42 +
        this.getGaussianProfile(i, lastBarIndex * 0.73, 2.9 * barCountScale) * 0.58;
      // ハットは中央寄りのごく狭い範囲だけを鋭く跳ねさせる。
      const hatProfile = this.getGaussianProfile(i, lastBarIndex * 0.96, 1.25 * barCountScale);
      const instrumentPulse =
        kickPulse * kickProfile * 0.82 +
        snarePulse * snareProfile * 0.74 +
        hatPulse * hatProfile * 0.96;

      // 小音量時はさらに沈め、サビ付近で一気に開く非線形カーブにする。
      // 最大時の大きさは維持しつつ、小音量では発声や打音の瞬間成分もRMS音量に沿って沈める。
      const sceneScale = 0.045 + Math.pow(macroEnergy, 1.5) * 1.485;
      const transientScale = 0.2 + Math.pow(macroEnergy, 1.28) * 1.13;
      const targetValue = Math.min(
        1,
        (spectrumBase + melodyLayer) * sceneScale +
        (localTransient + instrumentPulse) * transientScale
      );

      const previous = this.displayedBars[i];
      const targetDrop = Math.min(
        1,
        Math.max(0, (previous - targetValue) / Math.max(0.06, previous))
      );
      const releaseSignal = Math.max(this.bandDrop[i], targetDrop);
      // 急に消える音はすぐ落とし、余韻やフェードはゆっくりした下降で追いかける。
      const releaseEasing = 0.075 + Math.pow(releaseSignal, 0.72) * 0.625;
      const easing = getTimeAdjustedEasing(
        targetValue > previous ? 0.74 : releaseEasing,
        frameScale
      );
      const nextValue = previous + (targetValue - previous) * easing;

      // 下降開始時の先端を短時間だけ保持し、Canvas全体を汚さず上品な残光にする。
      this.trailOpacity[i] *= Math.pow(0.48, frameScale);
      if (
        nextValue < previous - 0.004 &&
        (this.trailOpacity[i] < 0.018 || previous > this.trailBars[i])
      ) {
        this.trailBars[i] = previous;
        this.trailOpacity[i] = 0.14;
      }

      this.displayedBars[i] = nextValue;
    }

    if (peak > 2) {
      this.lastSignalAt = now;
      this.audioStatus = 'ready';
    } else if (!this.connectedVideo?.paused && now - this.lastSignalAt > NO_SIGNAL_NOTICE_MS) {
      this.audioStatus = 'silent';
    }
  }

  // 解析済みの値を左右対称のSpectrumとしてCanvasへ描く。
  private drawMirrorSpectrum(width: number, height: number, now: number) {
    const context = this.context;
    const canvas = this.canvas;
    if (!context || !canvas) return;

    const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);

    const centerX = width * MIRROR_SPECTRUM_LAYOUT.centerXRatio;
    const baselineY = Math.min(
      height - MIRROR_SPECTRUM_LAYOUT.bottomInsetPx,
      height * MIRROR_SPECTRUM_LAYOUT.baselineYRatio
    );
    const availableHalfWidth = Math.max(
      1,
      width * MIRROR_SPECTRUM_LAYOUT.halfWidthRatio - MIRROR_SPECTRUM_LAYOUT.horizontalInsetPx
    );
    const gap = Math.min(16, Math.max(6, width * 0.008));
    const barWidth = Math.max(
      1,
      (availableHalfWidth - gap * BAR_COUNT_PER_SIDE) / BAR_COUNT_PER_SIDE
    );
    const maxBarHeight = Math.min(
      height * MIRROR_SPECTRUM_LAYOUT.maxHeightRatio,
      MIRROR_SPECTRUM_LAYOUT.maxHeightPx
    );

    const energyPulse = (this.displayedBars[0] + this.displayedBars[1] + this.displayedBars[2]) / 3;
    const macroGlow = Math.pow(this.macroEnergy, 1.4);
    // 通常時は下端30%以内へ留め、映像の主要部分へGlowを被せない。
    const normalGlowRadius = Math.min(width * 0.34, height * 0.3);
    const normalGlow = context.createRadialGradient(centerX, baselineY, 0, centerX, baselineY, normalGlowRadius);
    normalGlow.addColorStop(
      0,
      `rgba(10, 132, 255, ${0.012 + macroGlow * 0.12 + energyPulse * 0.07 + this.snareVisualPulse * 0.25})`
    );
    normalGlow.addColorStop(
      0.5,
      `rgba(191, 90, 242, ${0.004 + macroGlow * 0.055 + energyPulse * 0.025 + this.snareVisualPulse * 0.11})`
    );
    normalGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    context.fillStyle = normalGlow;
    context.fillRect(0, 0, width, height);

    // サビGlowは通常Glowと分離し、外へ広がりながら透明度だけを滑らかに落とす。
    if (this.climaxBurst > 0.001) {
      const climaxGlowRadius = width * 0.52 * 1.16;
      const burstRadius = normalGlowRadius +
        (climaxGlowRadius - normalGlowRadius) * this.climaxBurstExpansion;
      const burstGlow = context.createRadialGradient(centerX, baselineY, 0, centerX, baselineY, burstRadius);
      burstGlow.addColorStop(0, `rgba(10, 132, 255, ${this.climaxBurst * 0.24})`);
      burstGlow.addColorStop(0.5, `rgba(191, 90, 242, ${this.climaxBurst * 0.12})`);
      burstGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      context.fillStyle = burstGlow;
      context.fillRect(0, 0, width, height);
    }

    context.shadowColor = 'rgba(10, 132, 255, 0.48)';
    context.shadowBlur = 10 + energyPulse * 14 + this.snareVisualPulse * 26 + this.climaxBurst * 18;

    // 最外周はキック・ベース帯域内の最大値を受け取り、端手前だけが突出するM型を防ぐ。
    let edgeBassPeak = 0;
    const edgeBassBandLimit = Math.ceil(BAR_COUNT_PER_SIDE * 0.28);
    for (let i = 0; i <= edgeBassBandLimit; i += 1) {
      edgeBassPeak = Math.max(edgeBassPeak, this.displayedBars[i]);
    }

    // 中央が最高域の1帯域だけに依存して沈まないよう、サビでは周辺の高域ピークも共有する。
    let centerHighPeak = 0;
    const centerHighBandStart = Math.floor(BAR_COUNT_PER_SIDE * 0.72);
    for (let i = centerHighBandStart; i < BAR_COUNT_PER_SIDE; i += 1) {
      centerHighPeak = Math.max(centerHighPeak, this.displayedBars[i]);
    }

    const cyan: RgbColor = [100, 210, 255];
    const blue: RgbColor = [10, 132, 255];
    const purple: RgbColor = [191, 90, 242];
    const horizontalExpansion = this.kickVisualPulse * 7 + this.climaxBurst * 26;
    const burstHeightScale = 1 + this.climaxBurst * 1.5;

    for (let i = 0; i < BAR_COUNT_PER_SIDE; i += 1) {
      // 周波数順を反転して、低域・キックを両端、高域を中央側へ配置する。
      // U字補正と低域の横展開は、音量と帯域密度が揃ったクライマックス時だけ混ぜる。
      const spatialRatio = i / Math.max(1, BAR_COUNT_PER_SIDE - 1);
      const sourceIndex = Math.round(
        (BAR_COUNT_PER_SIDE - 1) -
        spatialRatio * (BAR_COUNT_PER_SIDE - 1 - EDGE_BASS_BAND_INDEX)
      );
      const sourceValue = this.displayedBars[sourceIndex];
      const centerBlendProgress = 1 - Math.min(1, Math.max(0, spatialRatio / 0.24));
      const centerBlend =
        centerBlendProgress * centerBlendProgress * (3 - 2 * centerBlendProgress) * this.climaxEnergy * 0.72;
      const centerSupportedValue = sourceValue + (centerHighPeak - sourceValue) * centerBlend;
      const edgeBlendProgress = Math.min(1, Math.max(0, (spatialRatio - 0.78) / 0.22));
      const edgeBlend =
        edgeBlendProgress * edgeBlendProgress * (3 - 2 * edgeBlendProgress) * this.climaxEnergy;
      const value = centerSupportedValue + (edgeBassPeak - centerSupportedValue) * edgeBlend;
      const climaxUProfile = 0.7 + Math.pow(spatialRatio, 1.65) * 0.32;
      const dynamicShapeProfile = 1 + (climaxUProfile - 1) * this.climaxEnergy;
      // 高いピークは現状を維持し、低〜中域の反応だけを追加で持ち上げて平均高を確保する。
      const raisedValue = Math.min(1, value * 1.2);
      const averageLift = Math.max(0, 1 - raisedValue / 0.72);
      const renderValue = Math.min(1, raisedValue + value * averageLift * 0.44);
      const hatHeightScale = 1 + Math.pow(1 - spatialRatio, 7) * this.hatVisualPulse * 0.22;
      // 通常時は中央の数本を、計算された高さの一律80%で描く。
      const centerFadeProgress = Math.min(1, Math.max(0, (spatialRatio - 0.12) / 0.18));
      const centerFade = centerFadeProgress * centerFadeProgress * (3 - 2 * centerFadeProgress);
      const centerInfluence = 1 - centerFade;
      const climaxReleaseProgress = Math.min(1, Math.max(0, (this.climaxEnergy - 0.45) / 0.1));
      const climaxRelease =
        climaxReleaseProgress * climaxReleaseProgress * (3 - 2 * climaxReleaseProgress);
      const normalCenterProfile = 1 - centerInfluence * 0.2 * (1 - climaxRelease);
      const barHeight = Math.max(
        1,
        Math.pow(renderValue, 1.48) * maxBarHeight * dynamicShapeProfile * burstHeightScale *
          hatHeightScale * normalCenterProfile
      );
      const expansionRatio = (i + 1) / BAR_COUNT_PER_SIDE;
      const offset = gap + i * (barWidth + gap) + horizontalExpansion * expansionRatio;
      // 全バーを同じ太さにし、最外周だけが太く見える状態を防ぐ。
      const renderedBarWidth = barWidth;
      const radius = Math.min(renderedBarWidth / 2, 4);

      // 高域=Cyan、中域=Blue、低域=Purpleの色味を既存の縦Gradientへ薄く混ぜる。
      const frequencyTint = spatialRatio <= 0.5
        ? mixColor(cyan, blue, spatialRatio * 2)
        : mixColor(blue, purple, (spatialRatio - 0.5) * 2);
      const barGradient = context.createLinearGradient(0, baselineY - maxBarHeight, 0, baselineY);
      barGradient.addColorStop(0, rgba(mixColor(cyan, frequencyTint, 0.36), 0.92));
      barGradient.addColorStop(0.48, rgba(mixColor(blue, frequencyTint, 0.34), 0.78));
      barGradient.addColorStop(1, rgba(mixColor(purple, frequencyTint, 0.32), 0.32));

      // 下降前の先端だけを細く描き、1〜3フレーム程度の残光として見せる。
      const trailValue = this.trailBars[sourceIndex];
      const trailRaisedValue = Math.min(1, trailValue * 1.2);
      const trailAverageLift = Math.max(0, 1 - trailRaisedValue / 0.72);
      const trailRenderValue = Math.min(
        1,
        trailRaisedValue + trailValue * trailAverageLift * 0.44
      );
      const trailHeight =
        Math.pow(trailRenderValue, 1.48) * maxBarHeight * dynamicShapeProfile * normalCenterProfile;
      const trailAlpha = this.trailOpacity[sourceIndex];
      if (trailAlpha > 0.01 && trailHeight > barHeight + 1) {
        context.save();
        context.fillStyle = rgba(mixColor(cyan, frequencyTint, 0.36), trailAlpha);
        context.shadowColor = rgba(frequencyTint, Math.min(0.24, trailAlpha * 1.5));
        context.shadowBlur = 6;
        const trailThickness = Math.min(2, trailHeight - barHeight);
        context.fillRect(centerX + offset, baselineY - trailHeight, renderedBarWidth, trailThickness);
        context.fillRect(
          centerX - offset - renderedBarWidth,
          baselineY - trailHeight,
          renderedBarWidth,
          trailThickness
        );
        context.restore();
      }

      context.fillStyle = barGradient;
      const hatCenterAccent = Math.pow(1 - spatialRatio, 6) * this.hatVisualPulse;
      context.shadowColor = rgba(mixColor(blue, frequencyTint, 0.34), 0.48 + hatCenterAccent * 0.18);
      context.shadowBlur =
        10 + energyPulse * 14 + this.snareVisualPulse * 26 + this.climaxBurst * 18 + hatCenterAccent * 8;
      context.beginPath();
      context.roundRect(centerX + offset, baselineY - barHeight, renderedBarWidth, barHeight, radius);
      context.roundRect(centerX - offset - renderedBarWidth, baselineY - barHeight, renderedBarWidth, barHeight, radius);
      context.fill();
    }

    context.shadowBlur = 0;
    if (this.audioStatus !== 'ready') {
      const message = this.audioStatus === 'unsupported'
        ? 'Audio capture is unavailable'
        : this.audioStatus === 'silent'
          ? 'No analyzable audio signal'
          : 'Waiting for YouTube audio…';
      context.font = '500 12px system-ui, sans-serif';
      context.textAlign = 'center';
      context.fillStyle = 'rgba(255, 255, 255, 0.66)';
      context.fillText(message, centerX, Math.min(height - 24, baselineY + 28));
    }

    // 微小な時刻依存値を使い、完全無音時にもCanvas更新が止まっていないことを視認できる。
    if (this.audioStatus === 'connecting') {
      const waitingWidth = 26 + Math.sin(now / 350) * 8;
      context.fillStyle = 'rgba(10, 132, 255, 0.42)';
      context.fillRect(centerX - waitingWidth / 2, baselineY + 36, waitingWidth, 1);
    }
  }

  // 音の輪郭履歴を内側へ流し、円のままでも奥行きのあるNCS風メッシュを描く。
  private drawOrbitSpectrum(width: number, height: number, now: number) {
    const context = this.context;
    const canvas = this.canvas;
    if (!context || !canvas) return;

    const pixelRatio = this.getRenderPixelRatio();
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);

    const radius = Math.max(
      54,
      Math.min(
        height * ORBIT_SPECTRUM_LAYOUT.maxRadiusHeightRatio,
        width * ORBIT_SPECTRUM_LAYOUT.maxRadiusWidthRatio,
        ORBIT_SPECTRUM_LAYOUT.maxRadiusPx
      )
    );
    const centerX = Math.max(
      radius * 1.15,
      Math.min(
        width * ORBIT_SPECTRUM_LAYOUT.centerXRatio,
        width - radius * ORBIT_SPECTRUM_LAYOUT.edgePaddingRatio
      )
    );
    const centerY = Math.max(
      radius * 1.18,
      Math.min(height * ORBIT_SPECTRUM_LAYOUT.centerYRatio, height - radius * 1.18)
    );

    let bassEnergy = 0;
    for (let index = 0; index < this.displayedBars.length; index += 1) {
      if (index < 5) bassEnergy += this.displayedBars[index];
    }
    bassEnergy /= 5;

    const macroGlow = Math.pow(this.macroEnergy, 1.05);
    const circlePulse =
      1 + bassEnergy * 0.035 + this.kickVisualPulse * 0.045 + this.climaxBurst * 0.03;
    const renderedRadius = radius * circlePulse;

    // 周波数帯と波形を一周へ展開する。隣接点も混ぜ、ギザギザではなく大きな塊で動かす。
    for (let pointIndex = 0; pointIndex < ORBIT_SPECTRUM_POINT_COUNT; pointIndex += 1) {
      const position = pointIndex / ORBIT_SPECTRUM_POINT_COUNT;
      const bandPosition = position * (BAR_COUNT_PER_SIDE - 1);
      const bandIndex = Math.floor(bandPosition);
      const bandMix = bandPosition - bandIndex;
      const band =
        this.displayedBars[bandIndex] * (1 - bandMix) +
        this.displayedBars[Math.min(BAR_COUNT_PER_SIDE - 1, bandIndex + 1)] * bandMix;
      const waveformIndex = Math.min(
        this.timeDomainData.length - 1,
        Math.floor(position * this.timeDomainData.length)
      );
      const waveform = this.timeDomainData[waveformIndex] || 0;
      this.orbitTargetProfile[pointIndex] =
        Math.pow(Math.min(1, band * 1.45), 0.62) * 0.64 +
        Math.abs(waveform) * 0.22 +
        waveform * 0.11;
    }

    for (let pointIndex = 0; pointIndex < ORBIT_SPECTRUM_POINT_COUNT; pointIndex += 1) {
      const previous = this.orbitTargetProfile[
        (pointIndex + ORBIT_SPECTRUM_POINT_COUNT - 1) % ORBIT_SPECTRUM_POINT_COUNT
      ];
      const current = this.orbitTargetProfile[pointIndex];
      const next = this.orbitTargetProfile[(pointIndex + 1) % ORBIT_SPECTRUM_POINT_COUNT];
      const target = previous * 0.23 + current * 0.54 + next * 0.23;
      const easing = target > this.orbitProfile[pointIndex] ? 0.48 : 0.18;
      this.orbitProfile[pointIndex] += (target - this.orbitProfile[pointIndex]) * easing;
    }

    this.orbitHistoryCursor =
      (this.orbitHistoryCursor + ORBIT_MESH_LAYER_COUNT - 1) % ORBIT_MESH_LAYER_COUNT;
    this.orbitHistory[this.orbitHistoryCursor].set(this.orbitProfile);
    this.orbitHistoryCount = Math.min(ORBIT_MESH_LAYER_COUNT, this.orbitHistoryCount + 1);

    // 広い白青Glowを一度だけ敷き、暗い映像でも輪郭と点が埋もれないようにする。
    const ambientGlow = context.createRadialGradient(
      centerX,
      centerY,
      renderedRadius * 0.38,
      centerX,
      centerY,
      renderedRadius * 1.48
    );
    ambientGlow.addColorStop(0, `rgba(150, 214, 255, ${0.018 + macroGlow * 0.035})`);
    ambientGlow.addColorStop(0.62, `rgba(115, 181, 255, ${0.025 + macroGlow * 0.045})`);
    ambientGlow.addColorStop(0.82, `rgba(240, 248, 255, ${0.04 + macroGlow * 0.07})`);
    ambientGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    context.fillStyle = ambientGlow;
    context.fillRect(
      centerX - renderedRadius * 1.7,
      centerY - renderedRadius * 1.7,
      renderedRadius * 3.4,
      renderedRadius * 3.4
    );

    const rotation = now * 0.000035;
    const historyLayers = Math.max(1, this.orbitHistoryCount);

    // 各リングは1点ずつ描画せず、4つのPathへまとめる（最大1472点・4fill）。
    context.save();
    context.globalCompositeOperation = 'lighter';
    context.shadowBlur = 0;
    for (let depthGroup = 0; depthGroup < 4; depthGroup += 1) {
      context.beginPath();
      for (let meshLayer = depthGroup; meshLayer < historyLayers; meshLayer += 4) {
        const layerRatio = meshLayer / Math.max(1, ORBIT_MESH_LAYER_COUNT - 1);
        const historyIndex =
          (this.orbitHistoryCursor + meshLayer) % ORBIT_MESH_LAYER_COUNT;
        const profile = this.orbitHistory[historyIndex];
        const angleOffset = rotation - layerRatio * (0.24 + macroGlow * 0.1);
        const baseRadiusRatio = 0.975 - layerRatio * 0.42;
        for (let pointIndex = 0; pointIndex < ORBIT_SPECTRUM_POINT_COUNT; pointIndex += 1) {
          const angle =
            (pointIndex / ORBIT_SPECTRUM_POINT_COUNT) * Math.PI * 2 +
            angleOffset;
          const energyShape = Math.max(0, profile[pointIndex]);
          const flow = Math.sin(angle * 2.4 - now * 0.0012 + meshLayer * 0.32);
          const pointRadius = renderedRadius * Math.max(
            0.42,
            baseRadiusRatio + energyShape * (0.34 - layerRatio * 0.055) +
              flow * energyShape * 0.018
          );
          const x = centerX + Math.cos(angle) * pointRadius;
          const y = centerY + Math.sin(angle) * pointRadius;
          const pointSize = 0.72 + (1 - layerRatio) * 0.78 + energyShape * 0.58;

          context.rect(x - pointSize / 2, y - pointSize / 2, pointSize, pointSize);
        }
      }
      context.fillStyle = `rgba(${210 + depthGroup * 12}, ${232 + depthGroup * 6}, 255, ${
        0.46 + depthGroup * 0.09 + macroGlow * 0.1
      })`;
      context.fill();
    }
    context.restore();

    // 最新輪郭を滑らかな二次曲線に変換し、NCSの太い白い外周を作る。
    for (let pointIndex = 0; pointIndex < ORBIT_SPECTRUM_POINT_COUNT; pointIndex += 1) {
      const angle = (pointIndex / ORBIT_SPECTRUM_POINT_COUNT) * Math.PI * 2 + rotation;
      const contourRadius = renderedRadius * (
        0.99 + this.orbitProfile[pointIndex] * 0.38 +
        this.kickVisualPulse * 0.025
      );
      this.orbitContourX[pointIndex] = centerX + Math.cos(angle) * contourRadius;
      this.orbitContourY[pointIndex] = centerY + Math.sin(angle) * contourRadius;
    }

    context.save();
    context.globalCompositeOperation = 'lighter';
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.beginPath();
    const lastIndex = ORBIT_SPECTRUM_POINT_COUNT - 1;
    context.moveTo(
      (this.orbitContourX[lastIndex] + this.orbitContourX[0]) / 2,
      (this.orbitContourY[lastIndex] + this.orbitContourY[0]) / 2
    );
    for (let pointIndex = 0; pointIndex < ORBIT_SPECTRUM_POINT_COUNT; pointIndex += 1) {
      const nextIndex = (pointIndex + 1) % ORBIT_SPECTRUM_POINT_COUNT;
      context.quadraticCurveTo(
        this.orbitContourX[pointIndex],
        this.orbitContourY[pointIndex],
        (this.orbitContourX[pointIndex] + this.orbitContourX[nextIndex]) / 2,
        (this.orbitContourY[pointIndex] + this.orbitContourY[nextIndex]) / 2
      );
    }
    context.closePath();
    context.strokeStyle = `rgba(246, 251, 255, ${0.76 + macroGlow * 0.2})`;
    context.lineWidth = 3.6 + macroGlow * 3.2 + this.snareVisualPulse * 1.3;
    context.shadowColor = `rgba(178, 224, 255, ${0.66 + macroGlow * 0.22})`;
    context.shadowBlur = 10 + macroGlow * 12;
    context.stroke();

    // 強い帯域だけ線幅を足し、大音量時に輪郭が局所的に大きく膨らむようにする。
    context.shadowBlur = 5 + macroGlow * 7;
    for (let tier = 0; tier < 3; tier += 1) {
      context.beginPath();
      const threshold = 0.18 + tier * 0.16;
      for (let pointIndex = 0; pointIndex < ORBIT_SPECTRUM_POINT_COUNT; pointIndex += 1) {
        if (this.orbitProfile[pointIndex] < threshold) continue;
        const nextIndex = (pointIndex + 1) % ORBIT_SPECTRUM_POINT_COUNT;
        context.moveTo(this.orbitContourX[pointIndex], this.orbitContourY[pointIndex]);
        context.lineTo(this.orbitContourX[nextIndex], this.orbitContourY[nextIndex]);
      }
      context.strokeStyle = `rgba(255, 255, 255, ${0.34 + tier * 0.14})`;
      context.lineWidth = 4.8 + tier * 2.8 + this.kickVisualPulse * 2;
      context.stroke();
    }
    context.restore();

    if (this.audioStatus !== 'ready') {
      const message = this.audioStatus === 'unsupported'
        ? 'Audio capture is unavailable'
        : this.audioStatus === 'silent'
          ? 'No analyzable audio signal'
          : 'Waiting for YouTube audio…';
      context.font = '500 12px system-ui, sans-serif';
      context.textAlign = 'center';
      context.fillStyle = 'rgba(255, 255, 255, 0.66)';
      context.fillText(message, centerX, Math.min(height - 18, centerY + renderedRadius + 32));
    }

    if (this.audioStatus === 'connecting') {
      const waitingRadius = renderedRadius * (1.02 + Math.sin(now / 360) * 0.018);
      context.strokeStyle = 'rgba(105, 194, 255, 0.32)';
      context.lineWidth = 1;
      context.beginPath();
      context.arc(centerX, centerY, waitingRadius, -0.55, 0.55);
      context.stroke();
    }
  }

  // 接続確認、解析、描画を毎フレーム順番に実行する。
  private render = (now: number) => {
    if (!this.active) return;
    this.animationFrame = window.requestAnimationFrame(this.render);
    this.ensureLayer();

    if (document.hidden || !this.canvas || !this.context) return;

    const video = document.querySelector<CapturableVideoElement>('video');
    const sourceIdentity = video?.currentSrc || video?.src || '';
    const hasLiveAudioTrack = this.capturedStream?.getAudioTracks().some((track) => track.readyState === 'live') ?? false;
    if (!this.analyser || !hasLiveAudioTrack || video !== this.connectedVideo || sourceIdentity !== this.connectedSource) {
      void this.ensureAudioSource();
    }

    const isOrbitMode = state.userSettings.visualMode === 'orbit-spectrum';
    if (isOrbitMode && now - this.lastOrbitFrameAt < ORBIT_TARGET_FRAME_INTERVAL_MS) return;
    if (isOrbitMode) this.lastOrbitFrameAt = now;

    this.sampleBars(now);
    const pixelRatio = this.getRenderPixelRatio();
    const width = this.canvas.width / pixelRatio;
    const height = this.canvas.height / pixelRatio;
    if (isOrbitMode) {
      this.drawOrbitSpectrum(width, height, now);
    } else {
      this.drawMirrorSpectrum(width, height, now);
    }
  };
}

const audioSpectrum = new AudioSpectrumVisualizer();

// 設定中のVisual Modeに合わせてVisualizerをON/OFFする。
export function syncVisualizerMode() {
  const isSpectrumMode =
    state.userSettings.visualMode === 'mirror-spectrum' ||
    state.userSettings.visualMode === 'orbit-spectrum';
  if (state.userSettings.isEnabled && isSpectrumMode) {
    audioSpectrum.start();
  } else {
    audioSpectrum.stop();
  }
}

// SPA遷移や動画変更後に新しい音声Trackを取り直す。
export function refreshVisualizerAudioSource() {
  audioSpectrum.refreshSource();
}

// 拡張機能の終了時に音声とCanvasを確実に片付ける。
export function stopVisualizer() {
  audioSpectrum.stop();
}

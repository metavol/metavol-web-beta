<script setup lang="ts">

//5/21 今後付け加える機能
// backup用の別URL
// ここまでを常田先生の講義(6/27)に間に合わせたい
//
// fusion
// シリーズ切り替えコンボボックス
// 学生用にpixel mappingやマウス下のCT値を表示するシステム
// DicomView.vueが肥大化しているので他ファイルに分散
// Nrrdも
// 1つでもエラーの出るファイルがあると開けない
// 上下さかさま　spinal tumor
// できれば位置合わせ　ブラウザ上で果たして出来るか
// 断面指示線
// ROIツール
//
// MIP/surfaceMIP -> done
// Niftiの読み込み -> done
// rainbowCLUTが遅い -> done
// phantomボタン -> done
// pagingボタン、シリーズ切り替えボタン -> done
// 2Dの表示、右上に -> done
// スライス←→ボタンがsyncに対応していない -> done
// 画像をクローズするボタン -> done
// 画像をもっと大きくしたいので、サイドバーを隠したり画像サイズをレスポンシブに -> done
//
// PNGを読み込めるように→ボツ

import { ref, watch } from "vue";
import { DataSet, parseDicom } from "dicom-parser";
import * as DicomLib from './dicomLib.ts';
import sidebar from "./Sidebar.vue";
import imagebox from "./ImageBox.vue";
import { ImageBoxInfoBase, DicomSliceImageBoxInfo, VolumeImageBoxInfo, defaultInfo, pushVolume, FusedVolumeImageBoxInfo } from "./DicomImageBoxInfo";
import { getAllFilesRecursive } from "./DragAndDropUtil";
import { generateVolumeFromDicom } from './dicom2volume.ts';
import * as DecompressJpegLossless from "./decompressJpegLossless";
import { getSeriesTransferSyntaxInfo } from "./transferSyntax";
import { isPrimaryForFusion, isRgbSeries } from "./seriesClassify";
import { buildClutLegend, type ClutLegend } from "./clutLegend";
import { ensureWasmCodecsReady, isWasmCodecsReady } from "./wasmCodec";
import { Volume, voxelToWorld, worldToVoxel } from "./Volume.ts";
import { solve } from "./linalg";
import * as THREE from 'three';
import {cluts, labelClut} from './Clut.ts';
import * as nifti from 'nifti-reader-js';
import * as Phantom from './phantom.ts';
import { useSegmentationStore } from '../stores/segmentation';
import { sphereStatsInPet, fillPolygonOnSlice, findMaximumAxis as maxAxis } from './segmentation/maskOps';
import { TRACER_PRESETS, tracerById, detectTracer, type TracerPreset } from './tracerPresets';
import SegmentationPanel from './SegmentationPanel.vue';
import DebugInspector from './DebugInspector.vue';
import { computed, onMounted, nextTick, provide } from 'vue';
import { useAutoSave } from '../composables/useAutoSave';
import { loadSession, deleteSession, type SessionPayload } from '../stores/persistence';

const segStore = useSegmentationStore();


const closingImages = defineModel<boolean>("closingImages");
const drawer = defineModel<boolean>("drawer");
const inspector = defineModel<boolean>("inspector");
const leftButtonFunction = defineModel<LeftButtonFunction>("leftButtonFunction");

const imageBoxW = defineModel<number>("imageBoxW");
const imageBoxH = defineModel<number>("imageBoxH");
const tileN = defineModel<number>("tileN");
const syncImageBox = defineModel<boolean>("syncImageBox");
// 4 隅 patient/exam info overlay のグローバルトグル
const showOverlayInfo = defineModel<boolean>("showOverlayInfo", { default: true });
// 「全体化」(タイル間の隙間を 0 にして画像エリアを最大化) トグル。
// autoFitMode と直交し、autoFit 計算時に gap/safety を 0 に切り替える。
const noGapMode = defineModel<boolean>("noGapMode", { default: false });

const setTimeOutInitAndShow = () => {
  setTimeout(() => {
    for (let a of imb.value!){
      a.init();
    }
    show();
  }, 10);
}

const imageBoxSizeChanged = () => {
  setTimeOutInitAndShow();
}

watch(imageBoxW, imageBoxSizeChanged);
watch(imageBoxH, imageBoxSizeChanged);
watch(closingImages, () => {
  if (closingImages.value){
    initializeDicomListsImagesBoxInfos();
    closingImages.value = false;
    setTimeOutInitAndShow();
  }
});

interface MyDicom extends DataSet {
  decompressed: ArrayBuffer;
}
interface Nii {
  niftiHeader: nifti.NIFTI1,
  pixelData: Float32Array
}

type OtherFile = Uint8Array;

let bagOfFiles: (MyDicom | Nii | OtherFile)[];

const selectedImageBoxId = ref(0);
const isLoading = ref(false);
const isEnter = ref(false);

const showSummary = ref(false);
const showTag = ref(false);
const summaryText = ref('');
const tagText = ref('');

const imb = ref<InstanceType<typeof imagebox>[]>();

interface SeriesList { // 複数のDICOMファイル、もしくはVolumeデータ、もしくは両方（同一画像）、、ということはnx,ny,nzを共有するという案もあるが・・
  myDicom: MyDicom[] | null,
  volume: Volume | null,
}
let seriesList: SeriesList[];

// Volume cardリスト用の reactive サマリ（doSort 後に rebuildSeriesSummaries で更新）
export interface SeriesSummary {
  index: number;
  description: string;
  modality: string;
  matrixSize: string;       // "rows x cols x slices"
  voxelSize: string;        // "dx x dy x dz mm"
  fileCount: number;
  hasVolume: boolean;
  thumbnail: string | null; // dataURL
  seriesUID: string;        // for active-for-segmentation matching
  // 圧縮対応状況 (★1)
  transferSyntaxName: string;
  transferSyntaxSupported: boolean;
  transferSyntaxReason?: string;
  // PT 識別用フィールド (★3)
  acquisitionTime?: string;     // "08:34"
  studyDate?: string;           // "2026-04-15"
  studyUID?: string;
  attenuationCorrected?: boolean; // true/false (PT only) / undefined for non-PT
  // PET-CT fusion 解析に使えるか (false なら Sidebar の Other セクションに分類)
  isPrimary: boolean;
  isRgb: boolean;     // RGB / カラー画像 (thumbnail 生成・表示の警告用)
}
const seriesSummaries = ref<SeriesSummary[]>([]);

// ===== デバッグ機能 =====
// Voxel inspector (旧 debugMode) — App-bar からも toggle 可能なよう defineModel で公開
const debugMode = defineModel<boolean>('debugMode', { default: false });
const debugHoverRows = ref<Array<{
  seriesIndex: number; modality: string; description: string;
  i: number; j: number; k: number;
  value: number | null; inBounds: boolean;
}>>([]);
const debugScreenX = ref(0);
const debugScreenY = ref(0);
const debugShow = ref(false);

// 「画像が画面にちょうど収まる」モード。autoFitMode=true のとき
// drawer 開閉やウィンドウリサイズで imageBoxW/H を再計算する。
const autoFitMode = ref(false);

const applyAutoFit = () => {
  if (!autoFitMode.value) return;
  if ((tileN.value ?? 0) <= 0) return;     // box が無いときは fit 計算しない
  const { w, h } = fitBoxSizeForCurrentTile();
  imageBoxW.value = w;
  imageBoxH.value = h;
};

// URL params:
//   ?debug=1       voxel inspector を初期有効化
//   ?dev=case001   sample-data/case001 を自動 fetch + loadFiles + PET Standard
// Ctrl+Shift+D で voxel inspector を toggle
onMounted(() => {
  try {
    const p = new URLSearchParams(window.location.search);
    if (p.get('debug') === '1') debugMode.value = true;
    const devCase = p.get('dev');
    if (devCase) loadDevCase(devCase);
  } catch {}
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')){
      e.preventDefault();
      debugMode.value = !debugMode.value;
      if (!debugMode.value) debugShow.value = false;
      console.log('[debug] mode =', debugMode.value);
    }
  });
  window.addEventListener('resize', applyAutoFit);
});

// Vite dev middleware (vite.config.mts の devSampleDataPlugin) 経由で
// sample-data/<caseId>/ 配下を fetch、loadFiles に流し込む。
// 完了後に PET Standard layout を自動セットアップする。
const loadDevCase = async (caseId: string) => {
  try {
    const listRes = await fetch(`/api/cases/${encodeURIComponent(caseId)}/files`);
    if (!listRes.ok) {
      console.warn(`[dev-case] case "${caseId}" not found (HTTP ${listRes.status})`);
      return;
    }
    const fileNames: string[] = await listRes.json();
    if (!Array.isArray(fileNames) || fileNames.length === 0) {
      console.warn(`[dev-case] case "${caseId}" has no files`);
      return;
    }
    console.log(`[dev-case] loading ${fileNames.length} files from "${caseId}"...`);
    const t0 = performance.now();
    const files: File[] = [];
    // 並列 fetch (10 並列まで)。File オブジェクトに変換して loadFiles へ。
    const concurrency = 10;
    let idx = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (idx < fileNames.length) {
        const my = idx++;
        const name = fileNames[my];
        const r = await fetch(`/samples/${encodeURIComponent(caseId)}/${name.split('/').map(encodeURIComponent).join('/')}`);
        if (!r.ok) { console.warn(`[dev-case] fetch failed: ${name}`); continue; }
        const buf = await r.arrayBuffer();
        files[my] = new File([buf], name.split('/').pop() ?? name, { type: 'application/octet-stream' });
      }
    });
    await Promise.all(workers);
    const t1 = performance.now();
    console.log(`[dev-case] fetched ${files.length} files in ${(t1 - t0).toFixed(0)}ms`);
    loadFiles(files.filter(Boolean));
  } catch (err) {
    console.warn('[dev-case] failed', err);
  }
};

// ===== 自動保存 + リカバリ (IndexedDB persistence) =====
useAutoSave();   // composable: maskVersion 等を watch して debounce 保存

const recoveryCandidate = ref<SessionPayload | null>(null);
const showRecoveryDialog = ref(false);
const lastCheckedRecoveryUid = ref<string | null>(null);

// PT volume が変わったら IndexedDB に対応 session があるか確認、あればダイアログ。
watch(() => segStore.petVolumeRef?.metadata?.seriesUID ?? null, async (uid) => {
  if (!uid || uid === lastCheckedRecoveryUid.value) return;
  lastCheckedRecoveryUid.value = uid;

  // Auto-detect tracer from SeriesDescription / StudyDescription.
  // user が tracer を明示選択していない (activeTracerId null) ときだけ走る。
  // Recovery dialog で user が Recover を選ぶと labels/threshold は上書きされるので、
  // ここでの先行適用は副作用にならない。
  if (segStore.activeTracerId == null) {
    const md = segStore.petVolumeRef?.metadata;
    const sd = md?.seriesDescription;
    const detected = detectTracer(sd);
    if (detected) {
      console.log(`[tracer] auto-detected "${detected.name}" from "${sd}"`);
      applyTracerPreset(detected);
    }
  }

  try {
    const session = await loadSession(uid);
    if (!session) return;
    // 直前 (10 秒以内) に自動保存されたばかりのものは出さない (現セッション継続)
    if (segStore.lastAutoSavedAt && session.savedAt <= segStore.lastAutoSavedAt + 10000) return;
    recoveryCandidate.value = session;
    showRecoveryDialog.value = true;
  } catch (err) {
    console.warn('[auto-save] loadSession failed', err);
  }
});

const formatRelativeTime = (ts: number): string => {
  const dt = Math.max(0, Date.now() - ts);
  const sec = Math.floor(dt / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const day = Math.floor(hr / 24);
  return `${day} d ago`;
};

const onRecoverYes = () => {
  if (!recoveryCandidate.value) return;
  const res = segStore.restoreFromPersistence(recoveryCandidate.value);
  if (!res.ok) {
    alert('Could not recover the session: ' + res.reason);
  } else {
    show();
  }
  recoveryCandidate.value = null;
  showRecoveryDialog.value = false;
};
const onRecoverDiscard = async () => {
  if (recoveryCandidate.value) {
    try { await deleteSession(recoveryCandidate.value.seriesUID); } catch {}
  }
  recoveryCandidate.value = null;
  showRecoveryDialog.value = false;
};
const onRecoverSkip = () => {
  // 削除も復元もしない (次回ロード時にまた聞かれる)
  recoveryCandidate.value = null;
  showRecoveryDialog.value = false;
};

// drawer / inspector / tileN の変化に追従して fit
watch([drawer, inspector, tileN], () => {
  if (autoFitMode.value) applyAutoFit();
});

// 「全体化」モード切替時は autoFit を有効にして即時 fit を走らせる
// (OFF 化されても直前の box サイズはそのまま保持し、ユーザが手動で fit するまで動かない)。
watch(noGapMode, () => {
  autoFitMode.value = true;
  applyAutoFit();
});

// tileN 変更後は ImageBox 群が再構成されるため、init して再描画
watch(tileN, async () => {
  await nextTick();
  if (imb.value){
    for (const a of imb.value){ a.init(); }
  }
  show();
});

const updateDebugHover = (boxId: number, e: MouseEvent) => {
  if (!debugMode.value) return;
  if (!isAnyVolumeBox(boxId)) {
    debugShow.value = false;
    return;
  }
  const [cx, cy] = getCanvasXY(e);
  const w = screenToWorld(boxId, cx, cy);
  const rows: typeof debugHoverRows.value = [];
  for (let s = 0; s < seriesList.length; s++){
    const v = seriesList[s].volume;
    if (!v) continue;
    const vox = worldToVoxel_(w, s);
    const i = Math.floor(vox.x), j = Math.floor(vox.y), k = Math.floor(vox.z);
    const inBounds = i >= 0 && i < v.nx && j >= 0 && j < v.ny && k >= 0 && k < v.nz;
    const value = inBounds ? v.voxel[k * v.nx * v.ny + j * v.nx + i] : null;
    rows.push({
      seriesIndex: s,
      modality: v.metadata?.modality ?? '-',
      description: v.metadata?.seriesDescription ?? `S${s}`,
      i, j, k, value, inBounds,
    });
  }
  debugHoverRows.value = rows;
  debugScreenX.value = e.clientX;
  debugScreenY.value = e.clientY;
  debugShow.value = true;
};

const handleDebugEditClick = (boxId: number, e: MouseEvent) => {
  if (!debugMode.value) return false;
  if (!e.shiftKey) return false;
  if (!isAnyVolumeBox(boxId)) return false;
  const [cx, cy] = getCanvasXY(e);
  const w = screenToWorld(boxId, cx, cy);

  // 編集対象シリーズを選択（Volume が複数なら一覧から選ばせる）
  const candidates: Array<{ idx: number; v: any; descr: string }> = [];
  for (let s = 0; s < seriesList.length; s++){
    const v = seriesList[s].volume;
    if (!v) continue;
    const vox = worldToVoxel_(w, s);
    const i = Math.floor(vox.x), j = Math.floor(vox.y), k = Math.floor(vox.z);
    if (i < 0 || i >= v.nx || j < 0 || j >= v.ny || k < 0 || k >= v.nz) continue;
    candidates.push({
      idx: s,
      v,
      descr: `[${s}] ${v.metadata?.modality ?? '-'} ${v.metadata?.seriesDescription ?? ''} → cur=${v.voxel[k*v.nx*v.ny + j*v.nx + i].toFixed(4)} @(${i},${j},${k})`,
    });
  }
  if (candidates.length === 0){
    console.log('[debug edit] no in-bounds volume at this position');
    return true;
  }

  let chosenIdx = candidates[0].idx;
  if (candidates.length > 1){
    const list = candidates.map((c, n) => `${n}: ${c.descr}`).join('\n');
    const resp = prompt(`Edit which series?\n${list}\n\nEnter index (0..${candidates.length-1}):`, '0');
    if (resp == null) return true;
    const n = Number(resp);
    if (!Number.isFinite(n) || n < 0 || n >= candidates.length) return true;
    chosenIdx = candidates[n].idx;
  }

  const target = seriesList[chosenIdx].volume!;
  const vox = worldToVoxel_(w, chosenIdx);
  const i = Math.floor(vox.x), j = Math.floor(vox.y), k = Math.floor(vox.z);
  const idx = k * target.nx * target.ny + j * target.nx + i;
  const cur = target.voxel[idx];
  const resp = prompt(`Edit voxel value\n  series ${chosenIdx} (${target.metadata?.modality ?? '-'}) at (${i},${j},${k})\n  current: ${cur}\n\nNew value:`, String(cur));
  if (resp == null) return true;
  const newVal = Number(resp);
  if (!Number.isFinite(newVal)){
    console.warn('[debug edit] invalid value:', resp);
    return true;
  }
  target.voxel[idx] = newVal;
  console.log(`[debug edit] series ${chosenIdx} (${i},${j},${k}): ${cur} → ${newVal}`);
  show();
  return true;
};

const imageBoxInfos = ref<ImageBoxInfoBase[]>([]);
const getDicomSliceImageBoxInfo = (index: number) => imageBoxInfos.value[index] as DicomSliceImageBoxInfo;
const getVolumeImageBoxInfo = (index: number) => imageBoxInfos.value[index] as VolumeImageBoxInfo;
const isDicomSliceImageBoxInfo = (i:number) => {
  return "currentSliceNumber" in imageBoxInfos.value[i]; //この方法では、プロパティ名を変更したときにバグった。
}
const isVolumeImageBoxInfo = (i:number) => {
  return ("clut" in imageBoxInfos.value[i]) && !("clut1" in imageBoxInfos.value[i]); //この方法では、プロパティ名を変更したときにバグった。
}
const isFusedImageBoxInfo = (i:number) => {
  return "clut1" in imageBoxInfos.value[i];
}
// Volume 系（単独 Volume または Fusion）の判定
const isAnyVolumeBox = (i:number) => isVolumeImageBoxInfo(i) || isFusedImageBoxInfo(i);

const getSelectedInfo = () => getVolumeImageBoxInfo(selectedImageBoxId.value);

// ---- Title bar 用 helpers ----
type BoxKind = 'dicom' | 'volume' | 'fusion' | 'mip';
const getBoxKind = (i: number): BoxKind => {
  if (i < 0 || i >= imageBoxInfos.value.length) return 'volume';
  if (isDicomSliceImageBoxInfo(i)) return 'dicom';
  if (isFusedImageBoxInfo(i)) return 'fusion';
  if (isVolumeImageBoxInfo(i)) {
    return getVolumeImageBoxInfo(i).isMip ? 'mip' : 'volume';
  }
  return 'volume';
};

const getBoxModalityLabel = (i: number): string => {
  const kind = getBoxKind(i);
  if (kind === 'fusion') return 'Fused';
  if (kind === 'mip') return 'MIP';
  if (kind === 'dicom') {
    const info = getDicomSliceImageBoxInfo(i);
    const s = seriesList[info.currentSeriesNumber];
    if (s && s.myDicom && s.myDicom.length > 0) {
      const m = (s.myDicom[0].string('x00080060') ?? '').toUpperCase();
      if (m === 'PT' || m === 'PET') return 'PT';
      if (m === 'CT' || m === 'MR') return m;
    }
    return '2D';
  }
  // volume
  const info = getVolumeImageBoxInfo(i);
  const v = seriesList[info.currentSeriesNumber]?.volume;
  return (v?.metadata?.modality ?? 'VOL').toUpperCase();
};

const getBoxDescription = (i: number): string => {
  const info = imageBoxInfos.value[i];
  return info?.description ?? '';
};

// 現在の plane を box state から導出。Volume の vecx/vecy/vecz を見て
// determinePlaneDirection で軸面を判別、isMip / isVr を見て MIP/sMIP/VR を判別。
// 注意: defaultInfo (未ロードの初期状態) は clut を持つが vecx を持たないため、
// `isAnyVolumeBox` が true を返しても vecx の defensive check が必須。
const getBoxCurrentPlane = (i: number): 'axi' | 'cor' | 'sag' | 'mip' | 'smip' | 'vr' | null => {
  if (i < 0 || i >= imageBoxInfos.value.length) return null;
  if (!isAnyVolumeBox(i)) return null;
  const d = imageBoxInfos.value[i] as VolumeImageBoxInfo;
  if (!d.vecx || !d.vecy || !d.vecz) return null;
  if (d.isVr) return 'vr';
  if (d.isMip) return d.mip?.isSurface ? 'smip' : 'mip';
  const dir = determinePlaneDirection(d);
  if (dir === 'axial')    return 'axi';
  if (dir === 'coronal')  return 'cor';
  if (dir === 'sagittal') return 'sag';
  return null;
};
const getBoxCurrentClut = (i: number): number | undefined => {
  if (i < 0 || i >= imageBoxInfos.value.length) return undefined;
  if (!isAnyVolumeBox(i)) return undefined;
  return (imageBoxInfos.value[i] as VolumeImageBoxInfo).clut;
};

// suffix 判定: PT は SUV 単位、CT は HU、それ以外は無印
const suffixForModality = (m: string): string => {
  const u = (m ?? '').toUpperCase();
  if (u === 'PT' || u === 'PET') return 'SUV';
  if (u === 'CT') return 'HU';
  return '';
};

// 主レイヤ legend (DICOM Slice / Volume / Fusion / MIP)。
// DICOM Slice box: 常にグレー (clut=0)。WC/WW は info の値、無ければ DICOM tag (0028,1050/1051) から導出。
const getBoxLegend = (i: number): ClutLegend | undefined => {
  if (i < 0 || i >= imageBoxInfos.value.length) return undefined;
  if (isDicomSliceImageBoxInfo(i)) {
    const info = imageBoxInfos.value[i] as DicomSliceImageBoxInfo;
    const series = seriesList[info.currentSeriesNumber];
    const ds = series?.myDicom?.[info.currentSliceNumber];
    if (!ds) return undefined;
    const wc = info.myWC ?? Number(ds.string('x00281050', 0) ?? '0');
    const ww = info.myWW ?? Number(ds.string('x00281051', 0) ?? '1');
    if (!isFinite(wc) || !isFinite(ww) || ww <= 0) return undefined;
    const mod = (ds.string('x00080060') ?? '').toUpperCase();
    return buildClutLegend(0, wc, ww, suffixForModality(mod));
  }
  if (!isAnyVolumeBox(i)) return undefined;
  const info = imageBoxInfos.value[i] as VolumeImageBoxInfo;
  if (info.myWC == null || info.myWW == null) return undefined;
  // Fusion box の場合: legend (主レイヤ) は CT
  if (isFusedImageBoxInfo(i)) {
    const f = info as FusedVolumeImageBoxInfo;
    const ctSeries = seriesList[f.currentSeriesNumber];
    const ctMod = ctSeries?.volume?.metadata?.modality
      ?? (ctSeries?.myDicom?.[0]?.string('x00080060') ?? '').toUpperCase();
    return buildClutLegend(f.clut, f.myWC!, f.myWW!, suffixForModality(ctMod));
  }
  // Volume / MIP box
  const series = seriesList[info.currentSeriesNumber];
  const mod = series?.volume?.metadata?.modality
    ?? (series?.myDicom?.[0]?.string('x00080060') ?? '').toUpperCase();
  return buildClutLegend(info.clut, info.myWC!, info.myWW!, suffixForModality(mod));
};

// Crosshair の screen 投影 (Volume / Fusion box のみ意味あり)
const getBoxCrosshairX = (i: number): number | null => {
  void segStore.crosshairVersion;     // reactive 依存
  const w = segStore.crosshairWorld;
  if (!w) return null;
  const s = worldToScreen(i, w);
  return s ? s.sx : null;
};
const getBoxCrosshairY = (i: number): number | null => {
  void segStore.crosshairVersion;
  const w = segStore.crosshairWorld;
  if (!w) return null;
  const s = worldToScreen(i, w);
  return s ? s.sy : null;
};

// 4 隅 patient/exam info overlay の各 box 用ヘルパ。
// グローバルトグル (showOverlayInfo) が OFF なら undefined。
// 情報は currentSeriesNumber の先頭 DICOM (患者/検査) + 各 box タイプ別 slice 情報から構築。
interface CornerInfo {
  tl?: string[]; tr?: string[]; bl?: string[]; br?: string[];
}
const formatDicomDate = (s: string | null | undefined): string => {
  if (!s || s.length < 8) return s ?? '';
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
};
const planeLabel = (p: 'axi'|'cor'|'sag'|'mip'|'smip'|'vr'|null): string => {
  switch (p) {
    case 'axi': return 'Axial';
    case 'cor': return 'Coronal';
    case 'sag': return 'Sagittal';
    case 'mip': return 'MIP';
    case 'smip': return 'sMIP';
    case 'vr': return 'VR';
    default: return '';
  }
};
const cornerInfoFor = (i: number): CornerInfo | undefined => {
  if (!showOverlayInfo.value) return undefined;
  if (i < 0 || i >= imageBoxInfos.value.length) return undefined;
  const info = imageBoxInfos.value[i];
  const j = info.currentSeriesNumber;
  if (j == null || j < 0 || j >= seriesList.length) return undefined;
  const series = seriesList[j];
  const firstDs = series?.myDicom?.[0];
  if (!firstDs) return undefined;   // NIfTI のみ等は当面 corner info 非対応

  const patientName = (firstDs.string('x00100010') ?? '').replace(/\^/g, ' ').trim();
  const patientId   = firstDs.string('x00100020') ?? '';
  const studyDate   = formatDicomDate(firstDs.string('x00080020'));
  const modality    = (firstDs.string('x00080060') ?? '').toUpperCase();
  const seriesDesc  = firstDs.string('x0008103e') ?? '';

  const tl: string[] = [];
  if (patientName) tl.push(patientName);
  if (patientId)   tl.push(`ID: ${patientId}`);

  const tr: string[] = [];
  if (studyDate) tr.push(studyDate);
  if (modality)  tr.push(modality);

  const bl: string[] = [];
  if (seriesDesc) bl.push(seriesDesc);
  if (isDicomSliceImageBoxInfo(i)) {
    const d = info as DicomSliceImageBoxInfo;
    const total = series?.myDicom?.length ?? 0;
    if (total > 0) bl.push(`Image ${d.currentSliceNumber + 1}/${total}`);
  } else if (isAnyVolumeBox(i)) {
    const p = getBoxCurrentPlane(i);
    const lbl = planeLabel(p);
    if (lbl) bl.push(lbl);
  }

  const br: string[] = [];
  if (isDicomSliceImageBoxInfo(i)) {
    const d = info as DicomSliceImageBoxInfo;
    if (d.zoom != null && isFinite(d.zoom)) br.push(`Zoom: ${d.zoom.toFixed(2)}x`);
  }

  return { tl, tr, bl, br };
};

// 第二レイヤ legend (Fusion box の PET レイヤのみ。それ以外は undefined)
const getBoxLegend2 = (i: number): ClutLegend | undefined => {
  if (i < 0 || i >= imageBoxInfos.value.length) return undefined;
  if (!isFusedImageBoxInfo(i)) return undefined;
  const f = imageBoxInfos.value[i] as FusedVolumeImageBoxInfo;
  if (f.myWC1 == null || f.myWW1 == null) return undefined;
  const petSeries = seriesList[f.currentSeriesNumber1];
  const petMod = petSeries?.volume?.metadata?.modality
    ?? (petSeries?.myDicom?.[0]?.string('x00080060') ?? '').toUpperCase();
  return buildClutLegend(f.clut1, f.myWC1!, f.myWW1!, suffixForModality(petMod));
};

// Cross-reference lines: box i 上に他の Volume/Fusion box の slice plane を直線投影。
// MIP / VR は flat slice plane を持たないので除外。
// box_j の plane equation: (P - c_j) · n_j = 0 (n_j = vecz_j)
// box_i の screen pixel (sx, sy) に対し world P = c_i + (sx-cx)*vx_i + (sy-cy)*vy_i
// 代入: A*(sx-cx) + B*(sy-cy) + C = 0  where
//   A = vx_i · n_j, B = vy_i · n_j, C = (c_i - c_j) · n_j
// この A*sx + B*sy = K (K = A*cx + B*cy - C) を canvas 端 (0,0)-(W,H) と clip して 2 点抽出。
const crossRefLinesFor = (i: number): Array<{ x1: number; y1: number; x2: number; y2: number }> | undefined => {
  void boxStateVersion.value;     // reactive 依存
  if (i < 0 || i >= imageBoxInfos.value.length) return undefined;
  if (!isAnyVolumeBox(i)) return undefined;
  const ai = imageBoxInfos.value[i] as VolumeImageBoxInfo;
  if (ai.isMip || ai.isVr) return undefined;
  if (!ai.vecx || !ai.vecy || !ai.centerInWorld) return undefined;

  const W = imageBoxW.value ?? 0;
  const H = imageBoxH.value ?? 0;
  if (W <= 0 || H <= 0) return undefined;
  const cx = W / 2;
  const cy = H / 2;
  const eps = 1e-9;
  const lines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];

  for (let j = 0; j < imageBoxInfos.value.length; j++){
    if (j === i) continue;
    if (!isAnyVolumeBox(j)) continue;
    const aj = imageBoxInfos.value[j] as VolumeImageBoxInfo;
    if (aj.isMip || aj.isVr) continue;
    if (!aj.vecz || !aj.centerInWorld) continue;

    const nj = aj.vecz;
    const A = ai.vecx.x*nj.x + ai.vecx.y*nj.y + ai.vecx.z*nj.z;
    const B = ai.vecy.x*nj.x + ai.vecy.y*nj.y + ai.vecy.z*nj.z;
    const dxc = ai.centerInWorld.x - aj.centerInWorld.x;
    const dyc = ai.centerInWorld.y - aj.centerInWorld.y;
    const dzc = ai.centerInWorld.z - aj.centerInWorld.z;
    const C = dxc*nj.x + dyc*nj.y + dzc*nj.z;
    if (Math.abs(A) < eps && Math.abs(B) < eps) continue; // 平行 / 同一面
    const K = A*cx + B*cy - C;

    const pts: Array<[number, number]> = [];
    if (Math.abs(A) > eps){
      // top edge sy=0
      const sx0 = K / A;
      if (sx0 >= 0 && sx0 <= W) pts.push([sx0, 0]);
      // bottom edge sy=H
      const sxH = (K - B*H) / A;
      if (sxH >= 0 && sxH <= W) pts.push([sxH, H]);
    }
    if (Math.abs(B) > eps){
      // left edge sx=0
      const sy0 = K / B;
      if (sy0 >= 0 && sy0 <= H) pts.push([0, sy0]);
      // right edge sx=W
      const syW = (K - A*W) / B;
      if (syW >= 0 && syW <= H) pts.push([W, syW]);
    }
    if (pts.length < 2) continue;
    // 異なる端点 2 つを抽出 (corner で重複があるので最初と最後)
    lines.push({ x1: pts[0][0], y1: pts[0][1], x2: pts[pts.length-1][0], y2: pts[pts.length-1][1] });
  }

  return lines.length > 0 ? lines : undefined;
};

// per-box Sync opt-out
const boxSyncEnabled = ref<boolean[]>([true, true, true, true, true, true, true, true]);
const isBoxSyncEnabled = (i: number) => boxSyncEnabled.value[i] ?? true;

// per-box mask overlay opt-out (true = この Box ではマスク非表示)
const boxOverlayDisabled = ref<boolean[]>([false, false, false, false, false, false, false, false]);
const isBoxOverlayEnabled = (i: number) => !boxOverlayDisabled.value[i];

// MIP 高速モード: ホイールで角度を変えている間だけ fast=true で描画 (4x speedup)。
// 静止 (200ms) で full-res で再描画。box ごとに独立 timer を持つ。
const mipFastBoxes = new Set<number>();
const mipIdleTimers = new Map<number, ReturnType<typeof setTimeout>>();
const triggerMipFast = (i: number) => {
  mipFastBoxes.add(i);
  const old = mipIdleTimers.get(i);
  if (old != null) clearTimeout(old);
  mipIdleTimers.set(i, setTimeout(() => {
    mipFastBoxes.delete(i);
    mipIdleTimers.delete(i);
    showImage(i);  // full-res で再描画
  }, 200));
};

// ---- Title bar emit ハンドラ ----
const onTitlebarClose = (i: number) => {
  // Box を初期状態 (defaultInfo) に戻す
  imageBoxInfos.value[i] = defaultInfo(i) as ImageBoxInfoBase;
  imb.value?.[i]?.clear?.();
  showImage(i);
};

const onTitlebarResetView = (i: number) => {
  const info = imageBoxInfos.value[i];
  if (!info) return;

  if (isDicomSliceImageBoxInfo(i)) {
    const d = info as DicomSliceImageBoxInfo;
    d.myWC = null;
    d.myWW = null;
    d.centerX = 0;
    d.centerY = 0;
    d.zoom = null;
  } else if (isAnyVolumeBox(i)) {
    const d = info as VolumeImageBoxInfo;
    const vol = seriesList[d.currentSeriesNumber]?.volume;
    d.myWC = null;
    d.myWW = null;
    if (isFusedImageBoxInfo(i)) {
      const f = d as FusedVolumeImageBoxInfo;
      f.myWC1 = null;
      f.myWW1 = null;
    }
    if (vol) {
      // 中心を volume 中点へ
      const p0 = voxelToWorld(new THREE.Vector3(0, 0, 0), vol);
      const p1 = voxelToWorld(new THREE.Vector3(vol.nx, vol.ny, vol.nz), vol);
      d.centerInWorld = p0.add(p1).divideScalar(2);
      // 現在 plane の canonical 軸でリセット (zoom=1)
      const plane = getBoxCurrentPlane(i);
      if (plane === 'axi' || plane == null) {
        d.vecx = vol.vectorX.clone();
        d.vecy = vol.vectorY.clone();
        d.vecz = vol.vectorZ.clone();
      } else if (plane === 'cor') {
        d.vecx = vol.vectorX.clone();
        d.vecy = vol.vectorZ.clone().normalize().multiplyScalar(vol.vectorX.length());
        d.vecz = vol.vectorY.clone();
      } else if (plane === 'sag') {
        d.vecx = vol.vectorY.clone();
        d.vecy = vol.vectorZ.clone().normalize().multiplyScalar(vol.vectorY.length());
        d.vecz = vol.vectorX.clone();
      }
      // MIP は angle のみリセット (mode は維持)
      if (d.isMip && d.mip) {
        d.mip.mipAngle = 0;
      }
    }
  }
  showImage(i);
};

const setPlaneOnBox = (i: number, plane: 'axi' | 'cor' | 'sag' | 'mip' | 'smip' | 'vr') => {
  if (!isAnyVolumeBox(i)) return;
  const d = imageBoxInfos.value[i] as VolumeImageBoxInfo;

  if (plane === 'mip' || plane === 'smip') {
    d.isMip = true;
    d.isVr = false;
    if (d.mip == null) {
      d.mip = { mipAngle: 0, isSurface: plane === 'smip', thresholdSurfaceMip: 0.3, depthSurfaceMip: 3 };
    } else {
      d.mip.isSurface = (plane === 'smip');
    }
    showImage(i);
    return;
  }

  if (plane === 'vr') {
    // VR: MIP と同じ rotation 機構を使うため mip オブジェクト (angle) は流用
    d.isMip = false;
    d.isVr = true;
    if (d.mip == null) {
      d.mip = { mipAngle: 0, isSurface: false, thresholdSurfaceMip: 0.3, depthSurfaceMip: 3 };
    }
    showImage(i);
    return;
  }

  // axi / cor / sag: 元 volume の canonical 軸を起点に再構築
  d.isMip = false;
  d.isVr = false;
  const vol = seriesList[d.currentSeriesNumber]?.volume;
  if (!vol) {
    showImage(i);
    return;
  }
  // ズーム倍率 (現 vec 長 / canonical 長) を保持して再構築
  const xZoom = d.vecx.length() / Math.max(1e-9, vol.vectorX.length());
  const yZoom = d.vecy.length() / Math.max(1e-9, vol.vectorY.length());

  if (plane === 'axi') {
    d.vecx = vol.vectorX.clone().multiplyScalar(xZoom);
    d.vecy = vol.vectorY.clone().multiplyScalar(yZoom);
    d.vecz = vol.vectorZ.clone();
  } else if (plane === 'cor') {
    d.vecx = vol.vectorX.clone().multiplyScalar(xZoom);
    d.vecy = vol.vectorZ.clone().normalize().multiplyScalar(d.vecx.length());
    d.vecz = vol.vectorY.clone();
  } else if (plane === 'sag') {
    d.vecx = vol.vectorY.clone().multiplyScalar(xZoom);
    d.vecy = vol.vectorZ.clone().normalize().multiplyScalar(d.vecx.length());
    d.vecz = vol.vectorX.clone();
  }
  showImage(i);
};

const setClutOnBox = (i: number, clutId: number) => {
  if (!isAnyVolumeBox(i)) return;
  const d = imageBoxInfos.value[i] as VolumeImageBoxInfo;
  if (clutId === -1) {
    // Reverse: ペアトグル (0↔1, 2↔3, 4↔5)
    if (d.clut % 2 === 0) d.clut = d.clut + 1;
    else d.clut = d.clut - 1;
  } else {
    d.clut = clutId;
  }
  showImage(i);
};

const onTitlebarSetPlane = (i: number, plane: 'axi' | 'cor' | 'sag' | 'mip' | 'smip' | 'vr') => {
  setPlaneOnBox(i, plane);
};
const onTitlebarSetClut = (i: number, clut: number) => {
  setClutOnBox(i, clut);
};
const onTitlebarToggleSync = (i: number) => {
  if (i < 0) return;
  while (boxSyncEnabled.value.length <= i) boxSyncEnabled.value.push(true);
  boxSyncEnabled.value[i] = !boxSyncEnabled.value[i];
};

// ---- Maximize / Restore ----
// tileN を 1 に切り替え、選んだ box info を slot 0 に swap する。
// 復元時は swap し戻して元 tileN に戻す。
let maximizedState: { prevTileN: number; originalSlot: number } | null = null;

const onTitlebarMaximize = (i: number) => {
  if (maximizedState !== null) {
    // Restore
    const slot = maximizedState.originalSlot;
    if (slot !== 0) {
      const tmp = imageBoxInfos.value[0];
      imageBoxInfos.value[0] = imageBoxInfos.value[slot];
      imageBoxInfos.value[slot] = tmp;
    }
    tileN.value = maximizedState.prevTileN;
    maximizedState = null;
    nextTick(() => show());
    return;
  }

  // Maximize
  maximizedState = {
    prevTileN: tileN.value ?? 1,
    originalSlot: i,
  };
  if (i !== 0) {
    const tmp = imageBoxInfos.value[0];
    imageBoxInfos.value[0] = imageBoxInfos.value[i];
    imageBoxInfos.value[i] = tmp;
  }
  tileN.value = 1;
  nextTick(() => show());
};
const onTitlebarToggleOverlay = (i: number) => {
  if (i < 0) return;
  while (boxOverlayDisabled.value.length <= i) boxOverlayDisabled.value.push(false);
  boxOverlayDisabled.value[i] = !boxOverlayDisabled.value[i];
  showImage(i);
};
const onTitlebarMakeMpr = (i: number) => {
  if (!isDicomSliceImageBoxInfo(i)) return;
  const info = getDicomSliceImageBoxInfo(i);
  const seriesIdx = info.currentSeriesNumber;
  if (seriesIdx < 0 || seriesIdx >= seriesList.length) return;
  if (!seriesList[seriesIdx].myDicom || seriesList[seriesIdx].myDicom!.length === 0) return;
  mpr_(seriesIdx);
  showImage(i);
};

type LeftButtonFunction = "window" | "pan" | "zoom" | "page" | "sphereROI" | "polygonROI" | "assignLabel";
// const leftButtonFunction = ref<LeftButtonFunction>("none");
const leftButtonFunctionChanged = (e: LeftButtonFunction) => {
  leftButtonFunction.value = e;
};

const initializeDicomListsImagesBoxInfos = () => {
  bagOfFiles = [];
  seriesList = [];
  imageBoxInfos.value = [defaultInfo(0), defaultInfo(1), defaultInfo(2), defaultInfo(3),defaultInfo(4),defaultInfo(5),defaultInfo(6),defaultInfo(7)];
  seriesSummaries.value = [];
  segStore.setPetVolume(null);
  segStore.setCtVolume(null);
};
initializeDicomListsImagesBoxInfos();

const changeSlice_ = (add_number: number) => {
  const srcId = selectedImageBoxId.value;
  doOneOrAll(srcId, (id: number) => {
    changeSlice(id, add_number);
    showImage(id);
  });
  // crosshair を source box の through-plane vec で連動
  if (segStore.crosshairWorld && isAnyVolumeBox(srcId)) {
    const src = imageBoxInfos.value[srcId] as VolumeImageBoxInfo;
    if (src.vecz && !src.isMip) {
      segStore.advanceCrosshair(src.vecz, add_number);
      doOneOrAll(srcId, (i: number) => showImage(i));
    }
  }
}

const changeSlice = (index: number, add_number: number) => {
  if (isDicomSliceImageBoxInfo(index)){
    const info = getDicomSliceImageBoxInfo(index);
    let temp = info.currentSliceNumber + add_number;
    const len = seriesList[info.currentSeriesNumber].myDicom!.length
    if (temp < 0) temp = 0;
    if (temp >= len) temp = len - 1;
    info.currentSliceNumber = temp;
  }else{
    const a = getVolumeImageBoxInfo(index);
    if ((a.isMip || a.isVr) && a.mip != null){
      // MIP / sMIP / VR は wheel で view angle を回転 (slice paging ではない)
      a.mip.mipAngle += 5*add_number;
      // 角度変更時は fast モードに切替 + 200ms idle で full-res 再描画
      triggerMipFast(index);
    }else{
      a.centerInWorld.addScaledVector(a.vecz, add_number);
    }
  }
};

const setMyWCWW = (i:number, wc:number | null, ww: number | null) => {
  imageBoxInfos.value[i].myWC= wc;
  imageBoxInfos.value[i].myWW= ww;
}

const getMyWCWW = (i:number) => {
  return [imageBoxInfos.value[i].myWC, imageBoxInfos.value[i].myWW];
}
const getMyWCWW1 = (i:number) => {
  const info = (imageBoxInfos.value[i] as FusedVolumeImageBoxInfo);
  return [info.myWC1, info.myWW1];
}

const presetSelected = (e: string) => {
  const id = selectedImageBoxId.value;
  // CT (HU) presets
  if (e === "Lung") setMyWCWW(id, -700, 1800);
  if (e === "Abd") setMyWCWW(id, 30, 200);
  if (e === "Med") setMyWCWW(id, 0, 320);
  if (e === "Fat") setMyWCWW(id, 10, 275);
  if (e === "Bone") setMyWCWW(id, 200, 2000);
  if (e === "Brain") setMyWCWW(id, 30, 80);
  // PET (SUV) presets — WC = (lo+hi)/2, WW = hi-lo
  if (e === "SUV-0-3")  setMyWCWW(id, 1.5, 3);
  if (e === "SUV-0-6")  setMyWCWW(id, 3,   6);
  if (e === "SUV-0-10") setMyWCWW(id, 5,  10);
  if (e === "SUV-0-15") setMyWCWW(id, 7.5, 15);
  if (e === "Reset") setMyWCWW(id, null, null);
  show();
};

// Tracer preset 適用: PT 表示窓 / CLUT を全 PT/Fusion box に書き換え + segStore の
// threshold + label preset を更新。Mask 数や label 数が変わると mask 全消去 (store 側で実施)。
//
// 注意: ImageBoxInfo は volume 直接ではなく `currentSeriesNumber` で seriesList を参照する設計。
// Volume が PT かどうかは seriesList[currentSeriesNumber].volume.metadata.modality で判定する。
const applyTracerPreset = (preset: TracerPreset) => {
  segStore.applyTracerLabelsAndThreshold(preset.id, preset.suvThreshold, preset.labels);

  const isPtSeries = (idx: number | undefined): boolean => {
    if (idx == null || idx < 0 || idx >= seriesList.length) return false;
    const v = seriesList[idx].volume;
    if (v?.metadata?.modality === 'PT') return true;
    // volume 未生成でも DICOM タグだけは確認できる
    const dlist = seriesList[idx].myDicom;
    const m = dlist?.[0]?.string("x00080060")?.toUpperCase();
    return m === 'PT' || m === 'PET';
  };

  for (let i = 0; i < imageBoxInfos.value.length; i++) {
    if (!isAnyVolumeBox(i)) continue;
    const info = imageBoxInfos.value[i];
    if (isFusedImageBoxInfo(i)) {
      // Fusion: PT layer は currentSeriesNumber1 のレイヤ。固定で myWC1/myWW1/clut1 を更新。
      const fi = info as FusedVolumeImageBoxInfo;
      fi.myWC1 = preset.suvWindow.wc;
      fi.myWW1 = preset.suvWindow.ww;
      fi.clut1 = preset.petClut;
    } else if (isVolumeImageBoxInfo(i)) {
      // Volume: そのボックスが参照する series が PT のときだけ更新 (CT/MR は触らない)
      const v = info as VolumeImageBoxInfo;
      if (isPtSeries(v.currentSeriesNumber)) {
        v.myWC = preset.suvWindow.wc;
        v.myWW = preset.suvWindow.ww;
        v.clut = preset.petClut;
      }
    }
  }
  show();
};

// applyTracerById は App.vue から呼び出される入口 (defineExpose 経由)。
const applyTracerById = (id: string) => {
  const p = tracerById(id);
  if (p) applyTracerPreset(p);
};

// DICOM tag viewer 用: 現在選択中の Box が指す series の **現スライス** を返す。
//   - DICOM 2D box: currentSliceNumber 直接
//   - Volume / Fusion box: centerInWorld を voxel に逆変換 → 最寄り slice index
//   - MIP / 不明: スライス 0
// reactive にしたいので computed として exposed する (function 形式は legacy として残す)。
interface TagContext {
    dataset: DataSet;
    label: string;
    sliceIndex: number;
    sliceCount: number;
}

const computeTagContext = (): TagContext | null => {
  const id = selectedImageBoxId.value;
  if (id < 0 || id >= imageBoxInfos.value.length) return null;
  // Volume / Fusion / MIP は DICOM tag view 非対応 (1 frame のタグが意味をなさないため)
  if (!isDicomSliceImageBoxInfo(id)) return null;
  const info = imageBoxInfos.value[id] as DicomSliceImageBoxInfo;
  const idx = info.currentSeriesNumber;
  if (idx == null || idx < 0 || idx >= seriesList.length) return null;
  const series = seriesList[idx];
  if (!series?.myDicom?.length) return null;
  const dlist = series.myDicom;

  let sliceIdx = info.currentSliceNumber ?? 0;
  if (sliceIdx < 0) sliceIdx = 0;
  if (sliceIdx >= dlist.length) sliceIdx = dlist.length - 1;

  const ds = dlist[sliceIdx];
  const desc = ds.string("x0008103e") ?? ds.string("x00081030") ?? '(no description)';
  return { dataset: ds, label: desc, sliceIndex: sliceIdx, sliceCount: dlist.length };
};

// reactive ref として外部に渡す (paging 時に dialog が自動更新)。
// imageBoxInfos.value の中の centerInWorld / currentSliceNumber が変わると再評価される。
const activeTagContext = computed<TagContext | null>(() => {
  // imageBoxInfos / selectedImageBoxId への依存を Vue に伝えるため明示参照
  void imageBoxInfos.value;
  void selectedImageBoxId.value;
  return computeTagContext();
});

// Function 形式 (open 時の一回限りの取得) — backward compat
const getActiveTagContext = (): TagContext | null => computeTagContext();
const getTagContextForSeries = (idx: number): TagContext | null => {
  if (idx < 0 || idx >= seriesList.length) return null;
  const series = seriesList[idx];
  if (!series?.myDicom?.length) return null;
  const ds = series.myDicom[0];
  const desc = ds.string("x0008103e") ?? ds.string("x00081030") ?? '(no description)';
  return { dataset: ds, label: desc, sliceIndex: 0, sliceCount: series.myDicom.length };
};

const dragEnter = () => { isEnter.value = true; }
const dragLeave = () => { isEnter.value = false; }

// drop は 2 種類:
//  (a) ファイル/フォルダ drop → loadFiles
//  (b) Sidebar の series card drop → 受けた box の series を差し替え
const dropFile = async (e: DragEvent, boxId?: number) => {
  isEnter.value = false;
  // 1. Fusion drag (modality chip): box 内のドラッグハンドルから来た「fuse this series here」要求
  const fusionSrcStr = e.dataTransfer?.getData('application/x-metavol-fusion-source');
  if (fusionSrcStr) {
    const srcSeriesIdx = Number(fusionSrcStr);
    const tgt = boxId ?? selectedImageBoxId.value;
    if (!isNaN(srcSeriesIdx) && srcSeriesIdx >= 0 && srcSeriesIdx < seriesList.length) {
      fuseSeriesIntoBox(srcSeriesIdx, tgt);
    }
    return;
  }
  // 2. Sidebar series card drag: シリーズを box にロード
  const seriesIdxStr = e.dataTransfer?.getData('application/x-metavol-series');
  if (seriesIdxStr) {
    const idx = Number(seriesIdxStr);
    const target = boxId ?? selectedImageBoxId.value;
    if (!isNaN(idx) && idx >= 0 && idx < seriesList.length) {
      onSelectSeriesIntoBox(idx, target);
    }
    return;
  }
  // 3. OS からのファイルドロップ
  const files = await getAllFilesRecursive(e);
  if (files && files.length > 0) loadFiles(files);
};

// Modality chip dragstart ハンドラ。Volume / Fusion box の場合のみ起動。
// dataTransfer に source series index を載せて drop ハンドラに引き渡す。
const onModalityDragStart = (e: DragEvent, srcBoxId: number) => {
  if (!e.dataTransfer) return;
  if (srcBoxId < 0 || srcBoxId >= imageBoxInfos.value.length) { e.preventDefault(); return; }
  if (!isAnyVolumeBox(srcBoxId)) { e.preventDefault(); return; }
  const a = imageBoxInfos.value[srcBoxId] as VolumeImageBoxInfo;
  // MIP / VR は flat slice plane を持たないので fusion 起点に不適
  if (a.isMip || a.isVr) { e.preventDefault(); return; }
  const seriesIdx = a.currentSeriesNumber;
  if (seriesIdx == null || seriesIdx < 0 || seriesIdx >= seriesList.length) { e.preventDefault(); return; }
  if (!seriesList[seriesIdx]?.volume) { e.preventDefault(); return; }
  e.dataTransfer.setData('application/x-metavol-fusion-source', String(seriesIdx));
  e.dataTransfer.effectAllowed = 'copy';
};

// Fusion 構築: src series を tgtBoxId の box に重ねる。
// PT は overlay、CT/MR は base に自動振り分け。target box の plane (centerInWorld / vecx,y,z) は保持する。
const fuseSeriesIntoBox = (srcSeriesIdx: number, tgtBoxId: number) => {
  if (tgtBoxId < 0 || tgtBoxId >= imageBoxInfos.value.length) return;
  if (!isAnyVolumeBox(tgtBoxId)) {
    alert('Drop target must be a Volume or Fusion box. Use MPR first.');
    return;
  }
  const tgtInfoBefore = imageBoxInfos.value[tgtBoxId] as VolumeImageBoxInfo;
  if (tgtInfoBefore.isMip || tgtInfoBefore.isVr) {
    alert('Cannot fuse onto MIP or VR boxes.');
    return;
  }
  const tgtSeriesIdx = tgtInfoBefore.currentSeriesNumber;
  if (srcSeriesIdx === tgtSeriesIdx) return; // 同シリーズは fuse 不能

  // Volume が無いシリーズは生成
  if (!seriesList[srcSeriesIdx].volume) { if (!mpr_(srcSeriesIdx)) return; }

  const srcMod = (seriesList[srcSeriesIdx].volume?.metadata?.modality ?? '').toUpperCase();
  const tgtMod = (seriesList[tgtSeriesIdx].volume?.metadata?.modality ?? '').toUpperCase();

  // 振り分け: PT は overlay、CT/MR/OTHER は base
  let baseIdx: number, overlayIdx: number;
  if (srcMod === 'PT' || srcMod === 'PET') {
    baseIdx = tgtSeriesIdx; overlayIdx = srcSeriesIdx;
  } else if (tgtMod === 'PT' || tgtMod === 'PET') {
    baseIdx = srcSeriesIdx; overlayIdx = tgtSeriesIdx;
  } else {
    baseIdx = tgtSeriesIdx; overlayIdx = srcSeriesIdx;
  }

  const baseModFinal = (seriesList[baseIdx].volume?.metadata?.modality ?? '').toUpperCase();
  const overlayModFinal = (seriesList[overlayIdx].volume?.metadata?.modality ?? '').toUpperCase();

  // Base: gray CLUT。CT は HU 40/400, それ以外は 0/1000 既定
  const baseClut = 0;
  const baseWC = baseModFinal === 'CT' ? 40 : 0;
  const baseWW = baseModFinal === 'CT' ? 400 : 1000;
  // Overlay: PT なら rainbow + SUV 3/6、それ以外は gray 0/1000
  const isPtOverlay = (overlayModFinal === 'PT' || overlayModFinal === 'PET');
  const overlayClut = isPtOverlay ? 2 : 0;
  const overlayWC = isPtOverlay ? 3 : 0;
  const overlayWW = isPtOverlay ? 6 : 1000;

  imageBoxInfos.value[tgtBoxId] = {
    centerInWorld: tgtInfoBefore.centerInWorld.clone(),
    vecx: tgtInfoBefore.vecx.clone(),
    vecy: tgtInfoBefore.vecy.clone(),
    vecz: tgtInfoBefore.vecz.clone(),
    clut: baseClut,
    clut1: overlayClut,
    currentSeriesNumber: baseIdx,
    currentSeriesNumber1: overlayIdx,
    description: 'Fusion',
    myWC: baseWC, myWW: baseWW,
    myWC1: overlayWC, myWW1: overlayWW,
    isMip: false,
    mip: null,
  } as FusedVolumeImageBoxInfo;

  refreshSegStoreVolumeRefs();
  showImage(tgtBoxId);
};

const doOneOrAll = (id: number, action: (i:number) => void ) => {
  if (syncImageBox.value){
    for (let i=0; i<imb.value!.length; i++){
      // 発信元 (id) は常に実行、それ以外は per-box opt-out 判定
      if (i !== id && !isBoxSyncEnabled(i)) continue;
      action(i);
    }
  }else{
    action(id);
  }
}

// Pan の実体ロジック（左ボタン pan ツール / Ctrl+中ボタン から共通利用）
// 注意: target box i ごとに DICOM/Volume を判定する。source id では sync 群内で
// 混合 (DICOM + Volume) すると panning が破綻するため。
const doPan = (id: number, dx: number, dy: number) => {
  const info = getDicomSliceImageBoxInfo;
  const infoV = getVolumeImageBoxInfo;
  doOneOrAll(id, (i:number) => {
    if (isDicomSliceImageBoxInfo(i)){
      const zoom = info(i).zoom!;
      info(i).centerX -= dx / zoom;
      info(i).centerY -= dy / zoom;
    }else{
      const a = infoV(i);
      a.centerInWorld.x -= (dx * a.vecx.x + dy * a.vecy.x);
      a.centerInWorld.y -= (dx * a.vecx.y + dy * a.vecy.y);
      a.centerInWorld.z -= (dx * a.vecx.z + dy * a.vecy.z);
    }
    showImage(i);
  });
};

const mouseMove = (e: MouseEvent) => {
  const id = getIdOfEventOccured(e);
  const info = getDicomSliceImageBoxInfo;
  const infoV = getVolumeImageBoxInfo;

  // デバッグ: マウス位置の voxel 値を更新
  if (debugMode.value && e.buttons === 0){
    updateDebugHover(id, e);
  }

  // 中ボタンドラッグで常時 Pan（ツール選択に関係なく）
  // e.buttons のビット: 1=左, 2=右, 4=中。
  if ((e.buttons & 4) !== 0){
    doPan(id, e.movementX, e.movementY);
    return;
  }

  if (leftButtonFunction.value == "window") {
    if (e.buttons == 1) {
      let [wc,ww] = getMyWCWW(id);
      if (wc === null) {
        wc = Number(seriesList[info(id).currentSeriesNumber].myDicom![info(id).currentSliceNumber].string("x00281050", 0)) ?? 0;
      }
      if (ww === null) {
        ww = Number(seriesList[info(id).currentSeriesNumber].myDicom![info(id).currentSliceNumber].string("x00281051", 0)) ?? 0;
        // ww = Number(dicomDataSetList[id][info(id).currentSliceNumber].string("x00281051", 0)) ?? 0;
      }
      wc += e.movementY;
      ww += e.movementX;
      if (ww < 1) ww = 1;
      setMyWCWW(id, wc, ww);
      show();
    }
  }

  if (leftButtonFunction.value == "page") {
    if (e.buttons == 1) {
      doOneOrAll(id, (i:number) => changeSlice(i, e.movementY));
      show();
    }
  }

  if (leftButtonFunction.value == "zoom") {
    if (e.buttons == 1) {
      doOneOrAll(id, (i:number) => {
        if (isDicomSliceImageBoxInfo(i)){
          let r = 1.02;
          if (e.movementY > 0) r = 1 / r;
          const zoom = info(i).zoom ?? 1;
          info(i).zoom = zoom * r;
          showImage(i);
        }else{
          let r = Math.pow(1.02, e.movementY);
          const a = infoV(i);
          a.vecx.multiplyScalar(r);
          a.vecy.multiplyScalar(r);
          showImage(i);
        }
      });
    }
  }

  if (leftButtonFunction.value == "pan") {
    if (e.buttons == 1) {
      doPan(id, e.movementX, e.movementY);
    }
  }
}

const wheel = (e: WheelEvent) => {
  const id = getIdOfEventOccured(e);

  // Ctrl/Cmd + wheel → 即時ズーム（視野中心固定）
  if (e.ctrlKey || e.metaKey){
    const r = e.deltaY > 0 ? 1 / 1.1 : 1.1;
    doOneOrAll(id, (i: number) => {
      if (isDicomSliceImageBoxInfo(i)){
        const zoom = info(i).zoom ?? 1;
        info(i).zoom = zoom * r;
      } else if (isAnyVolumeBox(i)){
        // Volume / Fusion 共通: vecx/vecy を縮小すると画面上の mm 解像度が上がり拡大表示。
        // FusedVolumeImageBoxInfo にも vecx/vecy があるため同じ処理で OK。
        const a = getVolumeImageBoxInfo(i);
        a.vecx.multiplyScalar(1 / r);
        a.vecy.multiplyScalar(1 / r);
      }
      showImage(i);
    });
    return;
  }

  // 球 ROI ツール active かつ、マウスが球内 → 半径変更
  if (leftButtonFunction.value === "sphereROI" && segStore.sphere && segStore.petVolumeRef && isVolumeImageBoxInfo(id)){
    const [x, y] = getCanvasXY(e as unknown as MouseEvent);
    const w = screenToWorld(id, x, y);
    const c = segStore.sphere.centerWorld;
    const dx = w.x - c.x, dy = w.y - c.y, dz = w.z - c.z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (dist < segStore.sphere.radiusMm){
      const step = e.deltaY > 0 ? -2 : 2;
      let r = segStore.sphere.radiusMm + step;
      if (r < 1) r = 1;
      if (r > 200) r = 200;
      segStore.sphere.radiusMm = r;
      recomputeSphereStats();
      show();
      return;
    }
  }

  doOneOrAll(id, (id: number) => {
    const change = e.deltaY > 0 ? 1 : -1;
    changeSlice(id, change);
    showImage(id);
  });
  // crosshair を source box の through-plane vec で連動 (1 回だけ実行)
  const change = e.deltaY > 0 ? 1 : -1;
  if (segStore.crosshairWorld && isAnyVolumeBox(id)) {
    const src = imageBoxInfos.value[id] as VolumeImageBoxInfo;
    if (src.vecz && !src.isMip) {
      segStore.advanceCrosshair(src.vecz, change);
      // sync が ON で他 box が描画済みの後に crosshair が動いたので再描画
      doOneOrAll(id, (i: number) => showImage(i));
    }
  }
};

const getIdOfEventOccured = (e:MouseEvent | WheelEvent) => 
  Number((e.currentTarget! as any).getAttribute("imageBoxId"));; // anyじゃないほうがいいのだけど

const imageBoxClicked = (e:MouseEvent) => {
  const id = getIdOfEventOccured(e);
  selectedImageBoxId.value = id;

  // デバッグ: Shift+クリックで voxel 編集（debug mode のときのみ）
  if (debugMode.value && e.shiftKey){
    if (handleDebugEditClick(id, e)) return;
  }

  if (leftButtonFunction.value === "sphereROI") {
    handleSphereClick(e);
  } else if (leftButtonFunction.value === "polygonROI") {
    handlePolygonClick(e);
  } else if (leftButtonFunction.value === "assignLabel") {
    handleAssignLabelClick(e);
  }
}

const handleAssignLabelClick = (e: MouseEvent) => {
  const id = getIdOfEventOccured(e);
  if (!isVolumeImageBoxInfo(id)) return;
  if (!segStore.petVolumeRef || !segStore.componentMap) return;
  const petIdx = findPetSeriesIndex();
  if (petIdx < 0) return;
  const [x, y] = getCanvasXY(e);
  const w = screenToWorld(id, x, y);
  const v = worldToVoxel_(w, petIdx);
  const i = Math.round(v.x), j = Math.round(v.y), k = Math.round(v.z);
  const pet = segStore.petVolumeRef;
  if (i < 0 || i >= pet.nx || j < 0 || j >= pet.ny || k < 0 || k >= pet.nz) return;
  segStore.assignLabelAtVoxel(i, j, k, segStore.currentLabelId);
  show();
};

const getCanvasXY = (e: MouseEvent): [number, number] => {
  const target = e.currentTarget as HTMLElement;
  const cv = target.querySelector('canvas') as HTMLCanvasElement | null;
  if (cv) {
    const rect = cv.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }
  return [e.offsetX, e.offsetY];
};

const handlePolygonClick = (e: MouseEvent) => {
  const id = getIdOfEventOccured(e);
  if (!isVolumeImageBoxInfo(id)) return;
  if (!segStore.petVolumeRef) return;

  const [x, y] = getCanvasXY(e);
  const cur = segStore.polygon;
  if (!cur || !cur.inProgress || cur.imageBoxId !== id){
    // 新規開始
    const a = getVolumeImageBoxInfo(id);
    const sliceAxis = maxAxis(a.vecz);
    const planeName = determinePlaneDirection(a) as ('axial'|'coronal'|'sagittal'|'unknown');
    // PET ボクセル空間でのスライスインデックス（描画と同じ floor 規則で決定）
    // drawNiftiSlice は p00 + v01*y + v10*x を floor して voxel を決めるため、
    // 画面中央画素 (W/2, H/2) の voxel index も同様に floor するのが正しい。
    const petIdx = findPetSeriesIndex();
    let sliceIndexInPet = 0;
    if (petIdx >= 0){
      const wCenter = screenToWorld(id, imageBoxW.value!/2, imageBoxH.value!/2);
      const vc = worldToVoxel_(wCenter, petIdx);
      const arr = [vc.x, vc.y, vc.z];
      sliceIndexInPet = Math.floor(arr[sliceAxis]);
    }
    segStore.polygon = {
      plane: planeName,
      sliceAxis,
      sliceIndexInPet,
      screenVertices: [[x, y]],
      mode: segStore.defaultPolygonMode,
      inProgress: true,
      imageBoxId: id,
    };
  } else {
    cur.screenVertices.push([x, y]);
  }
  show();
};

const finalizePolygon = () => {
  const p = segStore.polygon;
  if (!p || !p.inProgress) return;
  if (p.screenVertices.length < 3){
    segStore.polygon = null;
    show();
    return;
  }
  const petIdx = findPetSeriesIndex();
  if (petIdx < 0){
    segStore.polygon = null;
    show();
    return;
  }
  segStore.ensureMaskAllocated();
  if (!segStore.manualEdits || !segStore.petVolumeRef){
    segStore.polygon = null;
    show();
    return;
  }

  // screen → PET voxel (u,v) 投影：sliceAxis 以外の 2 軸を採用
  const polyVoxelUV: Array<[number, number]> = [];
  for (const [sx, sy] of p.screenVertices){
    const w = screenToWorld(p.imageBoxId, sx, sy);
    const v = worldToVoxel_(w, petIdx);
    let u: number, vv: number;
    if (p.sliceAxis === 2){ u = v.x; vv = v.y; }
    else if (p.sliceAxis === 1){ u = v.x; vv = v.z; }
    else { u = v.y; vv = v.z; }
    polyVoxelUV.push([u, vv]);
  }

  // 操作前のスライスをundoStackに保存
  saveSliceToUndoStack(p.sliceAxis, p.sliceIndexInPet);

  const writeValue = p.mode === 'add' ? segStore.currentLabelId : (0xFFFF /* erase sentinel */);

  fillPolygonOnSlice({
    pet: segStore.petVolumeRef,
    target: segStore.manualEdits,
    sliceAxis: p.sliceAxis,
    sliceIndex: p.sliceIndexInPet,
    polygonVoxelXY: polyVoxelUV,
    writeValue,
  });

  segStore.recomputeFinalMask();
  segStore.markManualEditsChanged();
  segStore.polygon = null;
  show();
};

const cancelPolygon = () => {
  if (segStore.polygon){
    segStore.polygon = null;
    show();
  }
};

const saveSliceToUndoStack = (sliceAxis: 0|1|2, sliceIndex: number) => {
  const m = segStore.manualEdits;
  const pet = segStore.petVolumeRef;
  if (!m || !pet) return;
  const { nx, ny, nz } = pet;
  let dimU: number, dimV: number;
  if (sliceAxis === 2){ dimU = nx; dimV = ny; }
  else if (sliceAxis === 1){ dimU = nx; dimV = nz; }
  else { dimU = ny; dimV = nz; }
  const before = new Uint16Array(dimU * dimV);
  let k = 0;
  for (let v = 0; v < dimV; v++){
    for (let u = 0; u < dimU; u++){
      let idx: number;
      if (sliceAxis === 2) idx = sliceIndex * nx * ny + v * nx + u;
      else if (sliceAxis === 1) idx = v * nx * ny + sliceIndex * nx + u;
      else idx = v * nx * ny + u * nx + sliceIndex;
      before[k++] = m[idx];
    }
  }
  segStore.undoStack.push({ sliceAxis, sliceIndex, before });
  // limit stack to last 50
  if (segStore.undoStack.length > 50) segStore.undoStack.shift();
};

const polygonUndo = () => {
  const e = segStore.undoStack.pop();
  if (!e) return;
  const m = segStore.manualEdits;
  const pet = segStore.petVolumeRef;
  if (!m || !pet) return;
  const { nx, ny, nz } = pet;
  let dimU: number, dimV: number;
  if (e.sliceAxis === 2){ dimU = nx; dimV = ny; }
  else if (e.sliceAxis === 1){ dimU = nx; dimV = nz; }
  else { dimU = ny; dimV = nz; }
  let k = 0;
  for (let v = 0; v < dimV; v++){
    for (let u = 0; u < dimU; u++){
      let idx: number;
      if (e.sliceAxis === 2) idx = e.sliceIndex * nx * ny + v * nx + u;
      else if (e.sliceAxis === 1) idx = v * nx * ny + e.sliceIndex * nx + u;
      else idx = v * nx * ny + u * nx + e.sliceIndex;
      m[idx] = e.before[k++];
    }
  }
  segStore.recomputeFinalMask();
  segStore.markManualEditsChanged();
  show();
};

const onContextMenu = (e: MouseEvent) => {
  if (leftButtonFunction.value === "polygonROI" && segStore.polygon?.inProgress){
    e.preventDefault();
    finalizePolygon();
  }
};

const onDblClick = (e: MouseEvent) => {
  if (leftButtonFunction.value === "polygonROI" && segStore.polygon?.inProgress){
    e.preventDefault();
    finalizePolygon();
  }
};

const onKeyDown = (e: KeyboardEvent) => {
  if (e.key === "Escape" && segStore.polygon?.inProgress){
    cancelPolygon();
  } else if ((e.key === "z" || e.key === "Z") && (e.ctrlKey || e.metaKey)){
    e.preventDefault();
    polygonUndo();
  }
};

if (typeof window !== "undefined"){
  window.addEventListener("keydown", onKeyDown);
}

const handleSphereClick = (e: MouseEvent) => {
  const id = getIdOfEventOccured(e);
  if (!isVolumeImageBoxInfo(id)) return;
  if (!segStore.petVolumeRef) return;
  const [x, y] = getCanvasXY(e);
  const w = screenToWorld(id, x, y);
  const radius = segStore.sphere?.radiusMm ?? 10;
  // sphere が無ければ作成、あれば center だけ更新 (crosshair も同位置に)
  if (!segStore.sphere) segStore.setSphere(w, radius);
  segStore.setCrosshairWorld(w);  // 内部で sphere center 同期 + stats 再計算
  show();
};

const recomputeSphereStats = () => {
  const s = segStore.sphere;
  const pet = segStore.petVolumeRef;
  if (!s || !pet) return;
  const stats = sphereStatsInPet(pet, s.centerWorld, s.radiusMm);
  s.suvMax = stats.suvMax;
  s.suvMean = stats.suvMean;
  s.suvStd = stats.suvStd;
  s.voxelCount = stats.voxelCount;
};

// シリーズ idx を box id にロードする (drop ハンドラから呼ばれる)。
const onSelectSeriesIntoBox = (idx: number, id: number) => {
  if (idx < 0 || idx >= seriesList.length) return;
  if (id < 0 || id >= imageBoxInfos.value.length) return;
  selectedImageBoxId.value = id;
  const info = imageBoxInfos.value[id];
  // 既存の Box が DICOM 表示中なら currentSeriesNumber を切替、Volume 表示中なら mpr_ で再構築
  if (isDicomSliceImageBoxInfo(id)){
    (info as DicomSliceImageBoxInfo).currentSeriesNumber = idx;
    (info as DicomSliceImageBoxInfo).currentSliceNumber = 0;
    (info as DicomSliceImageBoxInfo).description = seriesSummaries.value[idx]?.description ?? "";
  } else {
    // Volume 表示中: 該当シリーズが volume を持たないなら生成
    if (!seriesList[idx].volume && seriesList[idx].myDicom){
      if (!mpr_(idx)) return;
    }
    if (seriesList[idx].volume){
      const v = seriesList[idx].volume!;
      const p0 = voxelToWorld_(new THREE.Vector3(0,0,0), idx);
      const p1 = voxelToWorld_(new THREE.Vector3(v.nx, v.ny, v.nz), idx);
      const center = p0.add(p1).divideScalar(2);
      imageBoxInfos.value[id] = {
        clut: (info as VolumeImageBoxInfo).clut ?? 0,
        myWC: info.myWC ?? null,
        myWW: info.myWW ?? null,
        description: seriesSummaries.value[idx]?.description ?? "",
        currentSeriesNumber: idx,
        centerInWorld: center,
        vecx: v.vectorX.clone(),
        vecy: v.vectorY.clone(),
        vecz: v.vectorZ.clone(),
        isMip: false,
        mip: null,
      } as VolumeImageBoxInfo;
    }
  }
  show();
};

const hasNonZeroMask = (m: Uint16Array | null): boolean => {
  if (!m) return false;
  for (let i = 0; i < m.length; i++) {
    if (m[i] !== 0) return true;
  }
  return false;
};

const onSetActiveForSeg = (payload: { index: number; modality: 'PT' | 'CT' }) => {
  const { index, modality } = payload;
  if (index < 0 || index >= seriesList.length) return;
  const s = seriesList[index];
  if (!s) return;

  // Volume が未生成なら mpr_ で生成 (DICOM 必須)。未対応圧縮なら mpr_ が false を返す。
  if (!s.volume) {
    if (!s.myDicom || s.myDicom.length === 0) {
      alert('Cannot activate: this series has no volume and no DICOM files.');
      return;
    }
    if (!mpr_(index)) return;
  }
  const v = s.volume;
  if (!v) return;

  // 切り替え先 seriesUID と現在 active が同じならノーオペで OK (mask 保持される)。
  const targetUid = v.metadata?.seriesUID ?? '';
  const currentRef = modality === 'PT' ? segStore.petVolumeRef : segStore.ctVolumeRef;
  const currentUid = currentRef?.metadata?.seriesUID ?? '';
  const isSwitch = !!targetUid && !!currentUid && targetUid !== currentUid;

  // PT を別 series に切り替え + マスク編集が乗っているとき: confirm
  if (isSwitch && modality === 'PT') {
    const dirty = hasNonZeroMask(segStore.finalMask) || hasNonZeroMask(segStore.manualEdits);
    if (dirty) {
      const ok = window.confirm(
        'Switching the active PT will discard the current segmentation mask and labels.\n\nProceed?'
      );
      if (!ok) return;
    }
  }

  if (modality === 'PT') {
    segStore.setPetVolume(v);
  } else {
    segStore.setCtVolume(v);
  }
  rebuildSeriesSummaries();
  show();
};

const onSetSeriesModality = (payload: { index: number; modality: 'PT' | 'CT' | 'MR' }) => {
  const { index, modality } = payload;
  if (index < 0 || index >= seriesList.length) return;
  const v = seriesList[index].volume;
  if (!v) return;
  const existing = v.metadata;
  v.metadata = {
    modality,
    seriesUID: existing?.seriesUID ?? `nii-${index}-${Date.now()}`,
    seriesDescription: existing?.seriesDescription,
    suvFactor: existing?.suvFactor,
    patientWeightKg: existing?.patientWeightKg,
    radionuclideHalfLifeSec: existing?.radionuclideHalfLifeSec,
    radionuclideTotalDoseBq: existing?.radionuclideTotalDoseBq,
    doseStartTimeSec: existing?.doseStartTimeSec,
    acquisitionTimeSec: existing?.acquisitionTimeSec,
    units: existing?.units,
  };
  if (modality === 'PT') {
    segStore.setPetVolume(v);
  } else if (modality === 'CT') {
    segStore.setCtVolume(v);
  } else {
    segStore.setMrVolume(v);
  }
  rebuildSeriesSummaries();
  show();
};

const doSort = () => {
  let serieses:string[] = [];
  for (const f of bagOfFiles){

    if (f instanceof Uint8Array){
      console.log(`otherfile: ${f.length} bytes`);
    }else if ("niftiHeader" in f){
      const dim = f['niftiHeader']['dims'];
      const af = f['niftiHeader']['affine'];
      // NIfTI-1 description (80 char) を seriesDescription に流用。
      // 空ならカード上は "Series N" にフォールバック。
      const niftiDesc = ((f['niftiHeader'] as { description?: string })['description'] ?? '').trim();

      const vx = new THREE.Vector3(af[0][0],af[0][1],af[0][2]).multiplyScalar(-1);
      const vy = new THREE.Vector3(af[1][0],af[1][1],af[1][2]).multiplyScalar(-1);
      const vz = new THREE.Vector3(af[2][0],af[2][1],af[2][2]);
      const pos = new THREE.Vector3(af[0][3], af[1][3], af[2][3]);

      const niftiIdx = seriesList.length;
      seriesList.push({
        myDicom: null,
        volume:{
          nx: dim[1],
          ny: dim[2],
          nz: dim[3],
          imagePosition: pos,
          vectorX: vx,
          vectorY: vy,
          vectorZ: vz,
          voxel: f.pixelData,
          metadata: {
            // modality 不明時の sentinel。UI は SeriesList の Set as PT/CT/MR ボタンで上書きを促す。
            modality: 'OTHER',
            seriesUID: `nii-${niftiIdx}-${Date.now()}`,
            seriesDescription: niftiDesc || undefined,
          },
        }
      });

    }else{

      const suid = f.string("x0020000e") ?? ""; // series instance uid
      const sd = f.string("x0008103e") ?? ""; // series description
      const name = suid+sd;

      let id = serieses.indexOf(name);
      if (id === -1){
        id = serieses.length;
        serieses.push(name);
      }
      if (seriesList[id] == null){
        seriesList[id] = {myDicom:null, volume:null};
      }
      if (seriesList[id].myDicom == null){
        seriesList[id].myDicom = [];
      }
      seriesList[id].myDicom!.push(f);
    }

  }
  bagOfFiles=[];

  for (const d of seriesList){
    if (d.myDicom != null){
      d.myDicom.sort((a: DataSet, b: DataSet) => {
        return Number(a.string("x00200013")) - Number(b.string("x00200013"));
      });
    }
  }

  detectPetCtFromDicom();
  rebuildSeriesSummaries();

  summaryText.value = "";
  // for (let i=0; i<serieses.length; i++){
  //   summaryText.value += `${serieses[i]}  ${seriesList[i].length} images \n`;
  // }
  // for (let i=0; i<volumeList.length; i++){
  //   summaryText.value += `${volumeList[i].nx} ${volumeList[i].ny} ${volumeList[i].ny} \n`;
  // }
};


const loadFile = async (file: File) => {
  loadFiles([file]);
};

// JPEG Lossless 圧縮されている全フレームを WASM (dcmjs-codecs) で復号する。
// WASM は main thread で sync 実行され純 JS 比 5-20x 速いため Web Worker は不要。
// frame ごとに setTimeout(0) で event loop に譲り UI 応答性を保つ。
// 完了後は rebuildSeriesSummaries() でサムネを再生成し、show() で即時反映。
const jpegDecompressInProgress = ref(false);
const jpegDecompressDone = ref(0);
const jpegDecompressTotal = ref(0);

const decompressAllJpegLossless = async (): Promise<void> => {
  // 対象フレーム収集
  const targets: MyDicom[] = [];
  for (const s of seriesList) {
    if (!s.myDicom) continue;
    for (const ds of s.myDicom) {
      if (DecompressJpegLossless.check(ds) && (ds as MyDicom).decompressed == null) {
        targets.push(ds as MyDicom);
      }
    }
  }
  if (targets.length === 0) return;

  // WASM プリウォーム (初回のみ実 fetch + instantiate; ~500ms 程度)。
  try {
    await ensureWasmCodecsReady();
  } catch (err) {
    console.warn('[jpeg-lossless] WASM init failed; using JS fallback for all frames', err);
  }

  jpegDecompressInProgress.value = true;
  jpegDecompressTotal.value = targets.length;
  jpegDecompressDone.value = 0;
  const t0 = performance.now();
  const backend = isWasmCodecsReady() ? 'WASM (dcmjs-codecs)' : 'JS (jpeg-lossless-decoder-js)';
  console.log(`[jpeg-lossless] decompressing ${targets.length} frames via ${backend}...`);

  for (const ds of targets) {
    try {
      ds.decompressed = DecompressJpegLossless.decode(ds);
    } catch (err) {
      console.warn('[jpeg-lossless] frame decode failed', err);
    }
    jpegDecompressDone.value++;
    // 8 frame ごとに event loop へ譲る (UI 応答性確保、WASM は速いので頻度低めで OK)
    if (jpegDecompressDone.value % 8 === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }
  const t1 = performance.now();
  const ms = (t1 - t0);
  const perFrame = (ms / targets.length).toFixed(2);
  console.log(`[jpeg-lossless] decompressed ${jpegDecompressDone.value} frames in ${ms.toFixed(0)}ms (${perFrame} ms/frame, ${backend})`);
  jpegDecompressInProgress.value = false;
};

const loadFiles = (files: FileList | File[]) => {
  initializeDicomListsImagesBoxInfos();
  // 起動直後 (tileN=0 = box なし) に file を投げ込まれたら最低 1 box 表示してロード進捗を出す。
  // PT/CT 揃いなら後段で setupPetStandardView が tileN=4 に拡張する。
  if ((tileN.value ?? 0) <= 0) tileN.value = 1;
  const localFileList = Array.from(files);

  isLoading.value = true;
  for (const f of localFileList) {
    loadFromLocal(f);
  }

  // loadFromLocalは非同期に読み込むので、この段階では全部読み込み終了していない。
  // setIntervalで定期的にチェックして、読み込みが終了していたらソートしてインターバルをキャンセルする。
  let intervalId : any | null = null;
  const callback = () => {
    const msg = `${bagOfFiles.length} / ${localFileList.length}`;
    if (imb.value && imb.value[0]) imb.value[0].clear(msg);
    if (localFileList.length === bagOfFiles.length){
      clearInterval(intervalId!);
      doSort();
      show();
      isLoading.value = false;
      // 背景で全 JPEG Lossless frame を decompress。完了後にサムネ再生成 + 再描画。
      decompressAllJpegLossless().then(() => {
        rebuildSeriesSummaries();
        show();
      });
    }
  };
  intervalId = setInterval(callback, 100);
};

const loadFromLocal = (f: File) => {
  const reader = new FileReader();
  reader.onload = () => {

    if (reader.result !== null) {
      const buf = reader.result as ArrayBuffer;
      const u8a = new Uint8Array(buf);
      try{
        const dataSet = parseDicom(u8a) as MyDicom;
        bagOfFiles.push(dataSet);
      }catch{
        try{
          loadNii(buf);
        }catch{
          bagOfFiles.push(u8a);
        }
      }
    }
  };
  reader.readAsArrayBuffer(f);
};

const loadNii = (arraybuffer: ArrayBuffer) => {

  if (nifti.isCompressed(arraybuffer)){
    arraybuffer = nifti.decompress(arraybuffer);
  }

  if (nifti.isNIFTI(arraybuffer)) {
    const hdr = nifti.readHeader(arraybuffer) as nifti.NIFTI1;
    const px: ArrayBuffer = nifti.readImage(hdr, arraybuffer);

    if (hdr["numBitsPerVoxel"] == 32) {
      const px0 = new Float32Array(px);
      bagOfFiles.push({ niftiHeader: hdr, pixelData: px0 });
    } else if (hdr["numBitsPerVoxel"] == 64) {
      const px1 = new Float64Array(px);
      bagOfFiles.push({ niftiHeader: hdr, pixelData: new Float32Array(px1) });
    } else {
      const px1 = new Int16Array(px);
      bagOfFiles.push({ niftiHeader: hdr, pixelData: new Float32Array(px1) });
    }
  }
}

// 各 box の state (centerInWorld / vecx,y,z など) は Vector3 を mutate-in-place するため、
// Vue の reactive proxy では深い変更を検知できない。show()/showImage() の末尾で bump して
// 「描画状態が更新された」signal とし、cross-ref line など派生計算の reactivity に使う。
const boxStateVersion = ref(0);

const show = () => {
  if (imb.value == null) return;
  for (let i=0; i<imb.value.length; i++){
    showImage(i);
  }
  boxStateVersion.value++;
};

const showImage = (i:number) => {

  const info1 = imageBoxInfos.value[i];

  if (isDicomSliceImageBoxInfo(i)){
    const info = info1 as DicomSliceImageBoxInfo;

    const j = info.currentSeriesNumber;
    
    if (seriesList[j] == null || seriesList[j].myDicom == null) return;

    const dataSet = seriesList[j].myDicom![info.currentSliceNumber];

    if (showTag.value && i == selectedImageBoxId.value){
      tagText.value = DicomLib.allDicomTagToString(dataSet);
    }

    try {
      if (dataSet === undefined) {
        imb.value![i].clear();
      } else {
        // ★1: 未対応 transfer syntax の DICOM は明示エラーで empty state 表示
        const _ts = getSeriesTransferSyntaxInfo([dataSet]);
        if (!_ts.supported) {
          imb.value![i].clear(`Unsupported: ${_ts.name}`);
          return;
        }
        // DICOM Library https://www.dicomlibrary.com/dicom/dicom-tags/
        // const studyInstanceUid = dataSet.string('x0020000d');
        // const patientid = dataSet.string('x00100020');
        // const mod = dataSet.string('x00080060');
        const rows = dataSet.int16("x00280010") ?? 512;
        const cols = dataSet.int16("x00280011") ?? 512;

        const wc = imageBoxInfos.value[i].myWC ?? Number(dataSet.string("x00281050", 0) ?? "0");
        const ww = imageBoxInfos.value[i].myWW ?? Number(dataSet.string("x00281051", 0) ?? "1");

        const intercept = Number(dataSet.string("x00281052") ?? "0");
        const slope = Number(dataSet.string("x00281053") ?? "1");

        const centerX = info.centerX;
        const centerY = info.centerY;
        
        if (info.zoom == null){
          info.zoom = imageBoxW.value! / rows;
        }
        const zoom = info.zoom;

        info.imageNumberOfDicomTag = Number(dataSet.string("x00200013"));
        info.description = dataSet.string("x0008103e") ?? "SeriesName";

        const pixelDataElement = dataSet.elements.x7fe00010;
        // pixel data 要素を持たない DICOM (Structured Report / Presentation State 等) は
        // 表示できないので明示エラーで empty state にして抜ける。
        if (!pixelDataElement) {
          imb.value![i].clear('No pixel data in this DICOM');
          return;
        }

        // 2024/5/12 ここでjpeg解凍するのはあまりよろしくない。事前に非同期でしたい。今日のところは我慢する。
        if (DecompressJpegLossless.check(dataSet) && dataSet.decompressed == null){
          dataSet.decompressed = DecompressJpegLossless.decode(dataSet);
        }

        const buf = dataSet.decompressed == null ? dataSet.byteArray.buffer as ArrayBuffer : dataSet.decompressed;
        const offset = dataSet.decompressed == null ? pixelDataElement.dataOffset : 0;
        const length = dataSet.decompressed == null ? pixelDataElement.length : buf.byteLength;

        if (dataSet.string("x00280004") == "RGB") {
          const ui8a = new Uint8Array(buf, offset, length);
          imb.value![i].showRgb(ui8a, rows!, cols!, centerX, centerY, zoom);
        } else {
          const i16a = new Int16Array(buf, offset, length / 2);
          imb.value![i].show(
            i16a, rows, cols, wc, ww, intercept, slope, centerX, centerY, zoom
          );
        }
      }
    } catch (ex) {
      console.log("Error parsing byte stream", ex);
    }
  }
  else if (isVolumeImageBoxInfo(i)){
    const info = info1 as VolumeImageBoxInfo;

    const j = info.currentSeriesNumber;
    const dv = seriesList[j].volume!;
    const pixelData0 = dv.voxel;
    const nx = dv.nx;
    const ny = dv.ny;
    const nz = dv.nz;
    const p00 = worldToVoxel_(screenToWorld(i,0,0),j);
    const v01 = worldToVoxel_(screenToWorld(i,0,1),j).sub(p00);
    const v10 = worldToVoxel_(screenToWorld(i,1,0),j).sub(p00);
    const [wc,ww] = getMyWCWW(i);
    const clut = cluts[info.clut];

    if (info.isVr){
      // Volume Rendering: front-to-back composite ray casting
      const angle = info.mip?.mipAngle ?? 0;
      imb.value![i].drawNiftiVR(pixelData0, nx, ny, nz, wc!, ww!,
        p00, v01, v10, angle, clut, mipFastBoxes.has(i));
    } else if (!info.isMip){
        // CT 寝台除去: この volume が CT で、segStore に body mask があれば適用
        // Pinia Proxy 回避のため seriesUID で照合 (voxel TypedArray 同一でも可)
        const ctRefUid = segStore.ctVolumeRef?.metadata?.seriesUID;
        const dvUid = dv.metadata?.seriesUID;
        const isThisCt = !!ctRefUid && ctRefUid === dvUid;
        const ctBodyMask = (segStore.ctBodyMaskEnabled
            && segStore.ctBodyMask
            && isThisCt)
          ? segStore.ctBodyMask
          : undefined;
        imb.value![i].drawNiftiSlice(pixelData0,nx,ny,nz, wc!, ww!, p00,v01,v10,clut,
          buildMaskOverlayForBox(i), ctBodyMask);
      }else{
      const angle = info.mip!.mipAngle;
      // MIP の対象 volume が PET と一致する場合のみマスク overlay を渡す
      // （マスクは PET 格子と同形なので、同じ pix と同じ index で参照可能）
      const petIdx = findPetSeriesIndex();
      const overlayForMip = (info.currentSeriesNumber === petIdx)
        ? buildMipMaskOverlay(i)
        : undefined;
      imb.value![i].drawNiftiMip(pixelData0,nx,ny,nz, wc!, ww!, p00,v01,v10,
        angle, info.mip!.thresholdSurfaceMip, info.mip!.depthSurfaceMip, clut,
        info.mip!.isSurface, overlayForMip, mipFastBoxes.has(i));
      }
  }else{ // fusion
    const info = info1 as FusedVolumeImageBoxInfo;

    const j0 = info.currentSeriesNumber;
    const j1 = info.currentSeriesNumber1;

    const dv0 = seriesList[j0].volume!;
    const dv1 = seriesList[j1].volume!;

    const pixelData0 = dv0.voxel;
    const pixelData1 = dv1.voxel;

    const nx0 = dv0.nx;
    const ny0 = dv0.ny;
    const nz0 = dv0.nz;
    const nx1 = dv1.nx;
    const ny1 = dv1.ny;
    const nz1 = dv1.nz;

    const [wc0,ww0] = getMyWCWW(i);
    const [wc1,ww1] = getMyWCWW1(i);

    const p00_0 = worldToVoxel_(screenToWorld(i,0,0),j0);
    const v01_0 = worldToVoxel_(screenToWorld(i,0,1),j0).sub(p00_0);
    const v10_0 = worldToVoxel_(screenToWorld(i,1,0),j0).sub(p00_0);

    const p00_1 = worldToVoxel_(screenToWorld(i,0,0),j1);
    const v01_1 = worldToVoxel_(screenToWorld(i,0,1),j1).sub(p00_1);
    const v10_1 = worldToVoxel_(screenToWorld(i,1,0),j1).sub(p00_1);

    const clut0 = cluts[info.clut];
    const clut1 = cluts[info.clut1];

    // CT 寝台除去: pix0 (CT layer) が segStore.ctVolumeRef なら body mask を渡す
    // Pinia Proxy 回避のため seriesUID で照合
    const ctRefUid = segStore.ctVolumeRef?.metadata?.seriesUID;
    const dv0Uid = dv0.metadata?.seriesUID;
    const isFusionCtMatch = !!ctRefUid && ctRefUid === dv0Uid;
    const fusionCtBodyMask = (segStore.ctBodyMaskEnabled
        && segStore.ctBodyMask
        && isFusionCtMatch)
      ? segStore.ctBodyMask
      : undefined;
    // Fusion view ではマスク overlay を描かない（要望により）。
    imb.value![i].drawNiftiSliceFusion(
      pixelData0, nx0,ny0,nz0, wc0!, ww0!, p00_0,v01_0,v10_0,clut0,
      pixelData1, nx1,ny1,nz1, wc1!, ww1!, p00_1,v01_1,v10_1,clut1,
      undefined,
      fusionCtBodyMask,
    );

  }

  drawAnnotationOverlays(i);
  // box i の state が更新されたので reactive trigger を bump (cross-ref line 等)
  boxStateVersion.value++;
};

const drawAnnotationOverlays = (i: number) => {
  if (!isVolumeImageBoxInfo(i)) return;
  const a = getVolumeImageBoxInfo(i);

  // 球: 現スライス面と球の交差円を描く。
  const s = segStore.sphere;
  if (s){
    const c = s.centerWorld;
    const planeOrigin = a.centerInWorld;
    const normal = a.vecz.clone().normalize();
    const d = (c.x - planeOrigin.x) * normal.x + (c.y - planeOrigin.y) * normal.y + (c.z - planeOrigin.z) * normal.z;
    if (Math.abs(d) <= s.radiusMm){
      const rIntersect = Math.sqrt(s.radiusMm * s.radiusMm - d * d);
      // 中心を screen 座標へ。screenToWorld の逆: vecx, vecy で展開しているので、(x,y)→ world のうち (x,y) を解く。
      const dxw = c.x - planeOrigin.x - d * normal.x;
      const dyw = c.y - planeOrigin.y - d * normal.y;
      const dzw = c.z - planeOrigin.z - d * normal.z;
      // dx*vecx + dy*vecy = (dxw,dyw,dzw) を最小二乗で。vecx,vecy は直交とは限らないが大体直交。
      const ax = a.vecx, ay = a.vecy;
      const a11 = ax.x*ax.x + ax.y*ax.y + ax.z*ax.z;
      const a22 = ay.x*ay.x + ay.y*ay.y + ay.z*ay.z;
      const a12 = ax.x*ay.x + ax.y*ay.y + ax.z*ay.z;
      const b1 = ax.x*dxw + ax.y*dyw + ax.z*dzw;
      const b2 = ay.x*dxw + ay.y*dyw + ay.z*dzw;
      const det = a11*a22 - a12*a12;
      if (Math.abs(det) > 1e-12){
        const u = (a22*b1 - a12*b2) / det;
        const v = (a11*b2 - a12*b1) / det;
        const cx = u + imageBoxW.value!/2;
        const cy = v + imageBoxH.value!/2;
        const pixPerMm = 1 / Math.sqrt(a11);
        const rPx = rIntersect * pixPerMm;
        imb.value![i].drawSphereOverlay(cx, cy, rPx);
      }
    }
  }

  // polygon: 描画中のものをオーバーレイ。
  const p = segStore.polygon;
  if (p && p.imageBoxId === i && p.screenVertices.length > 0){
    imb.value![i].drawPolygonOverlay(p.screenVertices, p.mode, !p.inProgress);
  }
};

const screenToWorld = (imageBoxNumber: number, x: number, y:number) => {

  // 今はVolumeのときしか対応していないが、理論的にはDicomにも対応できる。

  const world = new THREE.Vector3(0,0,0);
  const a = imageBoxInfos.value[imageBoxNumber] as VolumeImageBoxInfo;
  world.add(a.centerInWorld).addScaledVector(a.vecx,x-imageBoxW.value!/2).addScaledVector(a.vecy,y-imageBoxH.value!/2);
  return world;
}

const voxelToWorld_ = (p: THREE.Vector3, vol_id:number) => {
  const v = seriesList[vol_id].volume!;
  return voxelToWorld(p, v);
}

// world 座標 → 画面 (sx, sy, sz) に逆射影。screenToWorld の inverse。
// sx, sy は canvas 内 px (0..imageBoxW/H)、sz は plane からの距離 (off-plane 判定用)。
// Volume / Fusion box でのみ意味を持つ。
const worldToScreen = (boxId: number, w: THREE.Vector3): { sx: number; sy: number; sz: number } | null => {
  if (boxId < 0 || boxId >= imageBoxInfos.value.length) return null;
  if (!isAnyVolumeBox(boxId)) return null;
  const a = imageBoxInfos.value[boxId] as VolumeImageBoxInfo;
  if (!a.vecx || !a.vecy || !a.vecz) return null;
  const cx = (imageBoxW.value ?? 0) / 2;
  const cy = (imageBoxH.value ?? 0) / 2;
  const dx = w.x - a.centerInWorld.x;
  const dy = w.y - a.centerInWorld.y;
  const dz = w.z - a.centerInWorld.z;
  // [vecx vecy vecz] * (sx_off, sy_off, sz_off)^T = (dx, dy, dz)^T
  const A = [
    [a.vecx.x, a.vecy.x, a.vecz.x],
    [a.vecx.y, a.vecy.y, a.vecz.y],
    [a.vecx.z, a.vecy.z, a.vecz.z],
  ];
  try {
    const ans = solve(A, [dx, dy, dz]);
    return { sx: ans[0] + cx, sy: ans[1] + cy, sz: ans[2] };
  } catch {
    return null;
  }
}

const worldToVoxel_ = (p: THREE.Vector3, vol_id:number) => {
  const v = seriesList[vol_id].volume!;
  return worldToVoxel(p,v);
}

const changeSuv = (a:number,b:number, doShow: boolean) => {
  for (let i=0; i<imageBoxInfos.value.length; i++){
    setMyWCWW(i, (a+b)/2, b-a);
  }
  if (doShow){
    show();
  }
}

const findPetSeriesIndex = (): number => {
  const ref = segStore.petVolumeRef;
  if (!ref) return -1;
  // Pinia は state を Proxy 化するので === では一致しない。voxel TypedArray の同一性で照合。
  for (let i = 0; i < seriesList.length; i++) {
    const v = seriesList[i].volume;
    if (!v) continue;
    if (v.voxel === ref.voxel) return i;
    if (v === ref) return i;
    if (v.metadata?.seriesUID && ref.metadata?.seriesUID && v.metadata.seriesUID === ref.metadata.seriesUID) return i;
  }
  // フォールバック: modality === 'PT' のシリーズを返す
  for (let i = 0; i < seriesList.length; i++) {
    const v = seriesList[i].volume;
    if (v?.metadata?.modality === 'PT') return i;
  }
  return -1;
};

// MIP 用のマスクオーバレイ。drawNiftiMip では mask の (nx,ny,nz) が
// pix と一致している前提で、内部で投影マップを生成する。
// p00/v01/v10 は drawNiftiMip 側では使われない（投影後の 2D 配列で参照）が、
// 型を満たすためにダミーで渡す。
const buildMipMaskOverlay = (boxId?: number) => {
  if (!segStore.overlayEnabled) return undefined;
  if (boxId !== undefined && !isBoxOverlayEnabled(boxId)) return undefined;
  const mask = segStore.finalMask;
  const pet = segStore.petVolumeRef;
  if (!mask || !pet) return undefined;
  return {
    mask,
    p00: new THREE.Vector3(0,0,0),
    v01: new THREE.Vector3(0,0,0),
    v10: new THREE.Vector3(0,0,0),
    nx: pet.nx, ny: pet.ny, nz: pet.nz,
    labelClut,
    alpha: segStore.overlayAlpha,
  };
};

const buildMaskOverlayForBox = (i: number) => {
  if (!segStore.overlayEnabled) return undefined;
  if (!isBoxOverlayEnabled(i)) return undefined;
  const mask = segStore.finalMask;
  const pet = segStore.petVolumeRef;
  if (!mask || !pet) return undefined;
  const petIdx = findPetSeriesIndex();
  if (petIdx < 0) return undefined;

  const p00 = worldToVoxel_(screenToWorld(i, 0, 0), petIdx);
  const v01 = worldToVoxel_(screenToWorld(i, 0, 1), petIdx).sub(p00);
  const v10 = worldToVoxel_(screenToWorld(i, 1, 0), petIdx).sub(p00);

  return {
    mask,
    p00, v01, v10,
    nx: pet.nx, ny: pet.ny, nz: pet.nz,
    labelClut,
    alpha: segStore.overlayAlpha,
  };
};

// 中央スライスから 96x96 のサムネイルを作る。
// volume があれば voxel から、なければ DICOM 中央スライスから生成。
const generateThumbnail = (s: SeriesList, modality: string, sliceIdx?: number): string | null => {
  const TH = 96;
  const cv = document.createElement('canvas');
  cv.width = TH; cv.height = TH;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  const img = ctx.getImageData(0, 0, TH, TH);

  // WC/WW のデフォルト
  const isPet = modality === 'PT' || modality === 'PET';
  const defaultWC = isPet ? 3 : 40;
  const defaultWW = isPet ? 6 : 400;

  if (s.volume){
    const v = s.volume;
    const k = sliceIdx != null
      ? Math.max(0, Math.min(v.nz - 1, sliceIdx))
      : Math.floor(v.nz / 2);
    const wc = defaultWC, ww = defaultWW;
    let ad = 0;
    for (let y = 0; y < TH; y++){
      for (let x = 0; x < TH; x++){
        const px = Math.floor(x / TH * v.nx);
        const py = Math.floor(y / TH * v.ny);
        const raw = v.voxel[k * v.nx * v.ny + py * v.nx + px];
        let p = Math.floor((raw - (wc - ww/2)) * (255/ww));
        if (p < 0) p = 0; if (p > 255) p = 255;
        img.data[ad] = p;
        img.data[ad+1] = p;
        img.data[ad+2] = p;
        img.data[ad+3] = 255;
        ad += 4;
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL('image/png');
  }
  if (s.myDicom && s.myDicom.length > 0){
    try {
      const k = sliceIdx != null
        ? Math.max(0, Math.min(s.myDicom.length - 1, sliceIdx))
        : Math.floor(s.myDicom.length / 2);
      const ds = s.myDicom[k];
      const rows = ds.int16("x00280010") ?? 512;
      const cols = ds.int16("x00280011") ?? 512;
      const intercept = Number(ds.string("x00281052") ?? "0");
      const slope = Number(ds.string("x00281053") ?? "1");
      const wc = Number(ds.string("x00281050", 0) ?? defaultWC);
      const ww = Number(ds.string("x00281051", 0) ?? defaultWW);
      const pde = ds.elements.x7fe00010;
      if (!pde) return null;
      const photo = (ds.string("x00280004") ?? '').toUpperCase();

      // RGB 8bit interleaved: そのまま色をサンプリング (windowing 不要)
      if (photo === 'RGB') {
        const u8 = new Uint8Array(ds.byteArray.buffer, pde.dataOffset, pde.length);
        let ad = 0;
        for (let y = 0; y < TH; y++) {
          for (let x = 0; x < TH; x++) {
            const px = Math.floor(x / TH * cols);
            const py = Math.floor(y / TH * rows);
            const adP = (py * cols + px) * 3;
            img.data[ad]   = u8[adP]   ?? 0;
            img.data[ad+1] = u8[adP+1] ?? 0;
            img.data[ad+2] = u8[adP+2] ?? 0;
            img.data[ad+3] = 255;
            ad += 4;
          }
        }
        ctx.putImageData(img, 0, 0);
        return cv.toDataURL('image/png');
      }

      // grayscale 16bit (MONOCHROME1/2 含む)
      // JPEG Lossless: decompressed キャッシュがあればそれを使う、無ければ
      // サムネ生成は諦める (背景 decompress が完了すれば再 build される)
      let i16: Int16Array;
      if (DecompressJpegLossless.check(ds)) {
        const cached = (ds as MyDicom).decompressed;
        if (cached == null) return null;
        i16 = new Int16Array(cached, 0, (cached as ArrayBuffer).byteLength / 2);
      } else {
        i16 = new Int16Array(ds.byteArray.buffer, pde.dataOffset, pde.length / 2);
      }
      let ad = 0;
      for (let y = 0; y < TH; y++){
        for (let x = 0; x < TH; x++){
          const px = Math.floor(x / TH * cols);
          const py = Math.floor(y / TH * rows);
          const raw = i16[py * cols + px] * slope + intercept;
          let p = Math.floor((raw - (wc - ww/2)) * (255/ww));
          if (p < 0) p = 0; if (p > 255) p = 255;
          img.data[ad] = p;
          img.data[ad+1] = p;
          img.data[ad+2] = p;
          img.data[ad+3] = 255;
          ad += 4;
        }
      }
      ctx.putImageData(img, 0, 0);
      return cv.toDataURL('image/png');
    } catch {
      return null;
    }
  }
  return null;
}

const rebuildSeriesSummaries = () => {
  const out: SeriesSummary[] = [];
  for (let i = 0; i < seriesList.length; i++){
    const s = seriesList[i];
    let description = '', modality = '-', matrixSize = '-', voxelSize = '-', fileCount = 0;
    if (s.myDicom && s.myDicom.length > 0){
      const ds = s.myDicom[0];
      description = ds.string("x0008103e") ?? '';
      modality = (ds.string("x00080060") ?? '').toUpperCase();
      const rows = ds.int16("x00280010") ?? 0;
      const cols = ds.int16("x00280011") ?? 0;
      matrixSize = `${rows}×${cols}×${s.myDicom.length}`;
      const px = ds.floatString("x00280030", 0);
      const py = ds.floatString("x00280030", 1);
      if (px != null && py != null){
        voxelSize = `${px.toFixed(2)}×${py.toFixed(2)} mm`;
      }
      fileCount = s.myDicom.length;
    }
    if (s.volume){
      const v = s.volume;
      modality = v.metadata?.modality ?? modality;
      description = v.metadata?.seriesDescription ?? description;
      matrixSize = `${v.nx}×${v.ny}×${v.nz}`;
      voxelSize = `${v.vectorX.length().toFixed(2)}×${v.vectorY.length().toFixed(2)}×${v.vectorZ.length().toFixed(2)} mm`;
    }
    if (!description) description = `Series ${i}`;
    let seriesUID = '';
    if (s.myDicom && s.myDicom.length > 0) {
      seriesUID = s.myDicom[0].string('x0020000e') ?? '';
    } else if (s.volume?.metadata?.seriesUID) {
      seriesUID = s.volume.metadata.seriesUID;
    }

    // ★1: transfer syntax 判定
    const tsInfo = s.myDicom && s.myDicom.length > 0
      ? getSeriesTransferSyntaxInfo(s.myDicom)
      : { name: 'NIfTI / Other', supported: true };

    // ★3: PT 識別用フィールド
    let acquisitionTime: string | undefined;
    let studyDate: string | undefined;
    let studyUID: string | undefined;
    let attenuationCorrected: boolean | undefined;
    if (s.myDicom && s.myDicom.length > 0) {
      const ds = s.myDicom[0];
      const at = ds.string('x00080032'); // AcquisitionTime "HHMMSS.FFFFFF"
      if (at && at.length >= 4) {
        acquisitionTime = `${at.substring(0,2)}:${at.substring(2,4)}`;
      }
      const sd = ds.string('x00080020'); // StudyDate "YYYYMMDD"
      if (sd && sd.length >= 8) {
        studyDate = `${sd.substring(0,4)}-${sd.substring(4,6)}-${sd.substring(6,8)}`;
      }
      studyUID = ds.string('x0020000d') ?? undefined;
      if (modality === 'PT' || modality === 'PET') {
        // (0028,0051) Corrected Image: backslash-separated values like "ATTN\\DECY"
        const corrected = ds.string('x00280051') ?? '';
        attenuationCorrected = corrected.toUpperCase().includes('ATTN');
      }
    }

    const ds0 = s.myDicom?.[0];
    const photometric = ds0?.string('x00280004');
    const imageType   = ds0?.string('x00080008');
    // フレーム数: DICOM は myDicom.length、NIfTI のみは volume.nz
    const nFramesEffective = s.myDicom?.length ?? s.volume?.nz ?? 0;
    const isPrimary = isPrimaryForFusion({
      nFrames: nFramesEffective,
      modality,
      photometric,
      imageType,
    });
    const isRgb = isRgbSeries(photometric);

    out.push({
      index: i,
      description,
      modality: modality || '-',
      matrixSize,
      voxelSize,
      fileCount,
      hasVolume: !!s.volume,
      thumbnail: generateThumbnail(s, modality),
      seriesUID,
      transferSyntaxName: tsInfo.name,
      transferSyntaxSupported: tsInfo.supported,
      transferSyntaxReason: tsInfo.reason,
      acquisitionTime,
      studyDate,
      studyUID,
      attenuationCorrected,
      isPrimary,
      isRgb,
    });
  }
  seriesSummaries.value = out;
}

const detectPetCtFromDicom = () => {
  // DICOM ファイル群から PET/CT/MR modality を検出して store に登録。
  // volume が未生成のシリーズは modality タグだけでも検出して候補として扱う。
  let petIdx = -1, ctIdx = -1, mrIdx = -1;
  for (let i = 0; i < seriesList.length; i++) {
    const dlist = seriesList[i].myDicom;
    if (!dlist || dlist.length === 0) continue;
    const m = (dlist[0].string("x00080060") ?? "").toUpperCase();
    if ((m === "PT" || m === "PET") && petIdx < 0) petIdx = i;
    if (m === "CT" && ctIdx < 0) ctIdx = i;
    if (m === "MR" && mrIdx < 0) mrIdx = i;
  }
  segStore.setPetVolume(petIdx >= 0 ? (seriesList[petIdx].volume ?? null) : null);
  segStore.setCtVolume(ctIdx >= 0 ? (seriesList[ctIdx].volume ?? null) : null);
  segStore.setMrVolume(mrIdx >= 0 ? (seriesList[mrIdx].volume ?? null) : null);
};

const refreshSegStoreVolumeRefs = () => {
  // mpr_ 後など、volume が新規生成されたタイミングで store の参照を更新。
  for (let i = 0; i < seriesList.length; i++) {
    const v = seriesList[i].volume;
    if (!v) continue;
    const m = v.metadata?.modality;
    if (m === "PT" && segStore.petVolumeRef !== v) {
      segStore.setPetVolume(v);
    }
    if (m === "CT" && segStore.ctVolumeRef !== v) {
      segStore.setCtVolume(v);
    }
    if (m === "MR" && segStore.mrVolumeRef !== v) {
      segStore.setMrVolume(v);
    }
  }
};

const mpr_ = (i: number): boolean => {
  // ★1: 未対応 transfer syntax の series は MPR/Volume 生成を弾く
  const ts = getSeriesTransferSyntaxInfo(seriesList[i].myDicom);
  if (!ts.supported) {
    alert(`Cannot create MPR: ${ts.reason ?? `unsupported transfer syntax (${ts.uid})`}.\n\nSeries: ${ts.name}`);
    return false;
  }
  const d = generateVolumeFromDicom(seriesList[i].myDicom!);
  seriesList[i].volume = d;
  refreshSegStoreVolumeRefs();
  rebuildSeriesSummaries();

  const p0 = voxelToWorld_(new THREE.Vector3(0,0,0),i);
  const p1 = voxelToWorld_(new THREE.Vector3(d.nx,d.ny, d.nz),i);
  p0.add(p1).divideScalar(2); // 中点

  imageBoxInfos.value[i] = {
    clut: 0,
    myWC: 3,
    myWW: 6,
    description: "metavol generated",
    currentSeriesNumber: i,
    centerInWorld: p0,
    vecx: d.vectorX.clone(),
    vecy: d.vectorY.clone(),
    vecz: d.vectorZ.clone(),
    isMip: false,
    mip: null,
  } as VolumeImageBoxInfo;

  return true;
}


const mpr = (doShow: boolean) => {

  const i = imageBoxInfos.value[selectedImageBoxId.value].currentSeriesNumber;
  mpr_(i);
  if (doShow){
    show();
  }

}

const fusion = () => {

  mpr_(0);
  mpr_(1);
  const info = (imageBoxInfos.value[1] as VolumeImageBoxInfo) as VolumeImageBoxInfo;

  imageBoxInfos.value![0] = {
    centerInWorld: info.centerInWorld,
    vecx: info.vecx,
    vecy: info.vecy,
    vecz: info.vecz,
    clut: 2, // white-black
    clut1: 0, // rainbow
    currentSeriesNumber: 0,
    currentSeriesNumber1: 1,
    description: "fusion",
    myWC: 3,
    myWW: 6,
    myWC1: 40,
    myWW1: 340,
  } as FusedVolumeImageBoxInfo;

  show();

}


const findMaximumAxis = (v: THREE.Vector3) => {
  if (v.x>v.y && v.x>v.z){
    return 0;
  }
  else if (v.y>v.x && v.y>v.z){
    return 1;
  }
  else{
    return 2
  }
}

const determinePlaneDirection = (d: VolumeImageBoxInfo) => {
  if (findMaximumAxis(d.vecx)===0 && findMaximumAxis(d.vecy)===1){
    return "axial";
  }
  else if (findMaximumAxis(d.vecx)===0 && findMaximumAxis(d.vecy)===2){
    return "coronal";
  }
  else if (findMaximumAxis(d.vecx)===1 && findMaximumAxis(d.vecy)===2){
    return "sagittal";
  }
  else return "unknown";
}


const switchToAxial = (doShow: boolean) => {
  const d = getSelectedInfo();
  if (determinePlaneDirection(d)=="coronal"){
    const temp = d.vecy;
    d.vecy = d.vecz;
    d.vecy.normalize().multiplyScalar(d.vecx.length());
    d.vecz = temp;
    if (doShow){
      show();
    }
  }
}

const switchToCoronal = (doShow: boolean) => {
  debugger;
  const d = getSelectedInfo();
  if (determinePlaneDirection(d)=="axial"){
    const temp = d.vecy;
    d.vecy = d.vecz;
    d.vecy.normalize().multiplyScalar(d.vecx.length());
    d.vecz = temp;
    if (doShow){
      show();
    }
  }
}


const reverse = (doShow: boolean) => {
  const d = getSelectedInfo();
  if (d.clut == 0) d.clut = 1;
  else if (d.clut == 1) d.clut = 0;
  else if (d.clut == 2) d.clut = 3;
  else if (d.clut == 3) d.clut = 2;
  else if (d.clut == 4) d.clut = 5;
  else if (d.clut == 5) d.clut = 4;
  if (doShow){
    show();
  }
}

const switchToMonochrome = (doShow: boolean) => { 
  getSelectedInfo().clut=0;
  if (doShow){
    show();
  }
}
const switchToRainbow = (doShow: boolean) => {
   getSelectedInfo().clut=2;
   if (doShow){
    show();
  }
}
const switchToHot = (doShow: boolean) => { 
  getSelectedInfo().clut=4;
  if (doShow){
    show();
  }
}

const switchToMip = (doShow: boolean) => {
  const d = getSelectedInfo();
  d.isMip = true;
  if (d.mip == null){
    d.mip = {
      mipAngle: 0,
      isSurface: false,
      thresholdSurfaceMip: 0.3,
      depthSurfaceMip: 3,
    }
  }else{
    d.mip.isSurface = false;
  }
  if (doShow){
    show();
  }
}

const switchToSMip = (doShow: boolean) => {
  const d = getSelectedInfo();
  if (!d.isMip) switchToMip(false);
  d.mip!.isSurface = true;
  if (doShow){
    show();
  }
}

const phantom1 = () => {
  const P = Phantom.generatePhantom();
  const c = pushVolume(seriesList, P);
  imageBoxInfos.value[selectedImageBoxId.value] = c;
  show();
}
const phantom2 = () => {
  const P = Phantom.generatePhantom2();
  const c = pushVolume(seriesList, P);
  imageBoxInfos.value[selectedImageBoxId.value] = c;
  show();
}

const phantom3 = () => {
  const P = Phantom.generatePhantom3();
  const c = pushVolume(seriesList, P);
  imageBoxInfos.value[selectedImageBoxId.value] = c;
  switchToSMip(true);
}

const runDebugger = () => {
  console.log(innerWidth);
};

const maximize = () => {
  const hello = document.getElementById("hello");
  debugger;
  imageBoxW.value=hello!.scrollWidth! / 2 - 10;
}

const gridCols = (n: number) => {
  if (n <= 1) return 1;
  if (n <= 2) return 2;
  if (n <= 4) return 2;
  if (n <= 6) return 3;
  if (n <= 9) return 3;
  return 4;
};
const gridStyle = computed(() => {
  const cols = gridCols(tileN.value ?? 1);
  return { gridTemplateColumns: `repeat(${cols}, max-content)` };
});

// 画像エリアのサイズから cols x rows がちょうど収まる box サイズを算出。
// 正方形に固執せず、横と縦を独立に最大化して隙間を埋める。
//
// Vuetify の box-sizing: border-box / scrollbar の有無 / drawer の transition 中の
// 中間サイズなど計算で詰めると環境依存で必ずズレる。.mv-imagearea 要素を直接測って
// そこから padding / gap / title bar / safety を引くのが最も堅い。
const TITLEBAR_H = 22;
const GAP_PX = 6;             // .mv-tile-grid の gap
const SAFETY_PX = 4;          // 各方向のクリッピング保険 (border 1px + 余裕)

const computeFitBoxSize = (cols: number, rows: number): { w: number; h: number } => {
  const ia = document.querySelector('.mv-imagearea') as HTMLElement | null;
  let availW: number, availH: number;
  if (ia) {
    // imagearea は padding: 8px 入っているので clientWidth/Height で padding 内側を取る
    availW = ia.clientWidth - 16;   // padding 8px each side
    availH = ia.clientHeight - 16;
  } else {
    // mount 前のフォールバック
    const sidebarW = drawer.value ? 280 : 0;
    const inspectorW = inspector.value ? 320 : 0;
    availW = Math.max(200, window.innerWidth - sidebarW - inspectorW - 16);
    availH = Math.max(200, window.innerHeight - 48 - 16);
  }

  // noGapMode 時は gap も safety も 0 にして画像エリアいっぱいに敷き詰める。
  const gap = noGapMode.value ? 0 : GAP_PX;
  const safe = noGapMode.value ? 0 : SAFETY_PX;
  const gapH = gap * Math.max(0, cols - 1);
  const gapV = gap * Math.max(0, rows - 1);

  // 各 cell に title bar (1 行 26px) と border (約 2px) と保険 SAFETY_PX を引く
  const w = Math.max(120, Math.floor((availW - gapH - cols * safe) / cols));
  const h = Math.max(120, Math.floor((availH - gapV - rows * (TITLEBAR_H + safe)) / rows));
  return { w, h };
}

// 現在の tileN と drawer 状態から最適な box サイズを返す
const fitBoxSizeForCurrentTile = (): { w: number; h: number } => {
  const n = tileN.value ?? 1;
  const cols = gridCols(n);
  const rows = Math.ceil(n / cols);
  return computeFitBoxSize(cols, rows);
}

// PET 標準ビュー: 2x2 で
//   Box 0 = CT axial
//   Box 1 = PET axial
//   Box 2 = Fusion axial
//   Box 3 = PET MIP
const setupPetStandardView = async () => {
  // PET/CT のシリーズインデックスを抽出
  let petIdx = -1, ctIdx = -1;
  for (let i = 0; i < seriesList.length; i++) {
    const dlist = seriesList[i].myDicom;
    if (!dlist || dlist.length === 0) continue;
    const m = (dlist[0].string("x00080060") ?? "").toUpperCase();
    if ((m === "PT" || m === "PET") && petIdx < 0) petIdx = i;
    if (m === "CT" && ctIdx < 0) ctIdx = i;
  }
  if (petIdx < 0 || ctIdx < 0){
    console.warn("Both PET and CT are required. petIdx=", petIdx, " ctIdx=", ctIdx);
    return;
  }

  // PET と CT を Volume 化（未生成なら）
  if (!seriesList[petIdx].volume) mpr_(petIdx);
  if (!seriesList[ctIdx].volume) mpr_(ctIdx);
  const pet = seriesList[petIdx].volume!;
  const ct  = seriesList[ctIdx].volume!;

  // 各 Box の中心は CT の中心を基準に揃える（同じ世界座標を表示）
  const ctCenter = (() => {
    const p0 = voxelToWorld_(new THREE.Vector3(0,0,0), ctIdx);
    const p1 = voxelToWorld_(new THREE.Vector3(ct.nx, ct.ny, ct.nz), ctIdx);
    return p0.add(p1).divideScalar(2);
  })();
  const petCenter = (() => {
    const p0 = voxelToWorld_(new THREE.Vector3(0,0,0), petIdx);
    const p1 = voxelToWorld_(new THREE.Vector3(pet.nx, pet.ny, pet.nz), petIdx);
    return p0.add(p1).divideScalar(2);
  })();

  // CT axial: black2white
  imageBoxInfos.value[0] = {
    clut: 0, myWC: 40, myWW: 400, description: "CT axial",
    currentSeriesNumber: ctIdx,
    centerInWorld: ctCenter.clone(),
    vecx: ct.vectorX.clone(),
    vecy: ct.vectorY.clone(),
    vecz: ct.vectorZ.clone(),
    isMip: false, mip: null,
  } as VolumeImageBoxInfo;

  // PET axial: white2black (0=white, high count=black)
  imageBoxInfos.value[1] = {
    clut: 1, myWC: 3, myWW: 6, description: "PET axial",
    currentSeriesNumber: petIdx,
    centerInWorld: petCenter.clone(),
    vecx: pet.vectorX.clone(),
    vecy: pet.vectorY.clone(),
    vecz: pet.vectorZ.clone(),
    isMip: false, mip: null,
  } as VolumeImageBoxInfo;

  // Fusion axial: CT (black2white) + PET (rainbow)
  imageBoxInfos.value[2] = {
    centerInWorld: ctCenter.clone(),
    vecx: ct.vectorX.clone(),
    vecy: ct.vectorY.clone(),
    vecz: ct.vectorZ.clone(),
    clut: 0,    // black2white (CT そのまま)
    clut1: 2,   // rainbow (PET)
    currentSeriesNumber: ctIdx,
    currentSeriesNumber1: petIdx,
    description: "Fusion axial",
    myWC: 40,  myWW: 400,
    myWC1: 3,  myWW1: 6,
  } as FusedVolumeImageBoxInfo;

  // PET MIP: white2black
  imageBoxInfos.value[3] = {
    clut: 1,
    myWC: 3, myWW: 6,
    description: "PET MIP",
    currentSeriesNumber: petIdx,
    centerInWorld: petCenter.clone(),
    vecx: pet.vectorX.clone(),
    vecy: pet.vectorZ.clone().normalize().multiplyScalar(pet.vectorX.length()),
    vecz: pet.vectorY.clone(),
    isMip: true,
    mip: { mipAngle: 0, isSurface: false, thresholdSurfaceMip: 0.3, depthSurfaceMip: 3 },
  } as VolumeImageBoxInfo;

  // store の参照を更新
  refreshSegStoreVolumeRefs();

  // 1画面に2x2が収まるサイズに自動調整
  autoFitMode.value = true;
  applyAutoFit();

  // ImageBox 再 init してから描画
  await nextTick();
  if (imb.value){
    for (const a of imb.value){ a.init(); }
  }
  show();
}

// ===== レイアウトプリセット =====
// PET Standard と同じスタイルで複数のレイアウトを切り替え可能にする。

// 与えた volume と plane で VolumeImageBoxInfo を生成する小ヘルパ。
const makeVolumeBoxForPlane = (
  volIdx: number,
  plane: 'axi' | 'cor' | 'sag' | 'mip',
  description: string,
  clut: number,
  wcWw: { wc: number; ww: number },
  isMip = false,
): VolumeImageBoxInfo => {
  const v = seriesList[volIdx].volume!;
  const p0 = voxelToWorld_(new THREE.Vector3(0, 0, 0), volIdx);
  const p1 = voxelToWorld_(new THREE.Vector3(v.nx, v.ny, v.nz), volIdx);
  const center = p0.add(p1).divideScalar(2);
  let vecx: THREE.Vector3, vecy: THREE.Vector3, vecz: THREE.Vector3;
  if (plane === 'cor') {
    vecx = v.vectorX.clone();
    vecy = v.vectorZ.clone().normalize().multiplyScalar(v.vectorX.length());
    vecz = v.vectorY.clone();
  } else if (plane === 'sag') {
    vecx = v.vectorY.clone();
    vecy = v.vectorZ.clone().normalize().multiplyScalar(v.vectorY.length());
    vecz = v.vectorX.clone();
  } else {
    // axial / mip (mip uses axial vectors with isMip=true)
    vecx = v.vectorX.clone();
    vecy = v.vectorY.clone();
    vecz = v.vectorZ.clone();
  }
  return {
    clut, myWC: wcWw.wc, myWW: wcWw.ww, description,
    currentSeriesNumber: volIdx, centerInWorld: center,
    vecx, vecy, vecz, isMip,
    mip: isMip ? { mipAngle: 0, isSurface: false, thresholdSurfaceMip: 0.3, depthSurfaceMip: 3 } : null,
  } as VolumeImageBoxInfo;
};

// L1 Triplanar PT: 1×3 (PT axial / coronal / sagittal)
const setupTriplanarPt = async () => {
  const petIdx = findPetSeriesIndex();
  if (petIdx < 0) { alert('No PT series found.'); return; }
  if (!seriesList[petIdx].volume) { if (!mpr_(petIdx)) return; }
  const wcww = { wc: 3, ww: 6 };
  imageBoxInfos.value[0] = makeVolumeBoxForPlane(petIdx, 'axi', 'PT axial',    1, wcww);
  imageBoxInfos.value[1] = makeVolumeBoxForPlane(petIdx, 'cor', 'PT coronal',  1, wcww);
  imageBoxInfos.value[2] = makeVolumeBoxForPlane(petIdx, 'sag', 'PT sagittal', 1, wcww);
  tileN.value = 3;
  refreshSegStoreVolumeRefs();
  autoFitMode.value = true;
  applyAutoFit();
  await nextTick();
  if (imb.value) for (const a of imb.value) a.init();
  show();
};

// L2 Triplanar Fused: 1×3 (Fused axial / coronal / sagittal)
// Fusion 用 base layer (CT or MR) を探す。CT 優先、なければ MR。
const findBaseSeriesIndexForFusion = (): { idx: number; modality: 'CT' | 'MR' } | null => {
  let ctIdx = -1, mrIdx = -1;
  for (let i = 0; i < seriesList.length; i++) {
    const v = seriesList[i].volume;
    const tag = (seriesList[i].myDicom?.[0]?.string('x00080060') ?? '').toUpperCase();
    const m = v?.metadata?.modality ?? tag;
    if (m === 'CT' && ctIdx < 0) ctIdx = i;
    if (m === 'MR' && mrIdx < 0) mrIdx = i;
  }
  if (ctIdx >= 0) return { idx: ctIdx, modality: 'CT' };
  if (mrIdx >= 0) return { idx: mrIdx, modality: 'MR' };
  return null;
};

const setupTriplanarFused = async () => {
  const petIdx = findPetSeriesIndex();
  const base = findBaseSeriesIndexForFusion();
  if (petIdx < 0 || !base) {
    alert('PT plus a CT or MR series are required for Fusion.');
    return;
  }
  const baseIdx = base.idx;
  if (!seriesList[petIdx].volume) { if (!mpr_(petIdx)) return; }
  if (!seriesList[baseIdx].volume) { if (!mpr_(baseIdx)) return; }
  const baseVol = seriesList[baseIdx].volume!;
  const baseP0 = voxelToWorld_(new THREE.Vector3(0, 0, 0), baseIdx);
  const baseP1 = voxelToWorld_(new THREE.Vector3(baseVol.nx, baseVol.ny, baseVol.nz), baseIdx);
  const baseCenter = baseP0.add(baseP1).divideScalar(2);
  // base modality に応じた windowing デフォルト
  const baseWC = base.modality === 'CT' ? 40 : 0;
  const baseWW = base.modality === 'CT' ? 400 : 1000;
  const labelPrefix = base.modality === 'CT' ? 'Fused' : 'Fused (MR+PT)';
  const makeFused = (plane: 'axi' | 'cor' | 'sag', desc: string): FusedVolumeImageBoxInfo => {
    let vecx: THREE.Vector3, vecy: THREE.Vector3, vecz: THREE.Vector3;
    if (plane === 'cor') {
      vecx = baseVol.vectorX.clone();
      vecy = baseVol.vectorZ.clone().normalize().multiplyScalar(baseVol.vectorX.length());
      vecz = baseVol.vectorY.clone();
    } else if (plane === 'sag') {
      vecx = baseVol.vectorY.clone();
      vecy = baseVol.vectorZ.clone().normalize().multiplyScalar(baseVol.vectorY.length());
      vecz = baseVol.vectorX.clone();
    } else {
      vecx = baseVol.vectorX.clone(); vecy = baseVol.vectorY.clone(); vecz = baseVol.vectorZ.clone();
    }
    return {
      centerInWorld: baseCenter.clone(), vecx, vecy, vecz,
      clut: 0, clut1: 2,
      currentSeriesNumber: baseIdx, currentSeriesNumber1: petIdx,
      description: desc, myWC: baseWC, myWW: baseWW, myWC1: 3, myWW1: 6,
    } as FusedVolumeImageBoxInfo;
  };
  imageBoxInfos.value[0] = makeFused('axi', `${labelPrefix} axial`);
  imageBoxInfos.value[1] = makeFused('cor', `${labelPrefix} coronal`);
  imageBoxInfos.value[2] = makeFused('sag', `${labelPrefix} sagittal`);
  tileN.value = 3;
  refreshSegStoreVolumeRefs();
  autoFitMode.value = true;
  applyAutoFit();
  await nextTick();
  if (imb.value) for (const a of imb.value) a.init();
  show();
};

// L3 PT-only 4-up: 2×2 (PT axi / cor / sag / MIP)
const setupPtOnly4up = async () => {
  const petIdx = findPetSeriesIndex();
  if (petIdx < 0) { alert('No PT series found.'); return; }
  if (!seriesList[petIdx].volume) { if (!mpr_(petIdx)) return; }
  const wcww = { wc: 3, ww: 6 };
  imageBoxInfos.value[0] = makeVolumeBoxForPlane(petIdx, 'axi', 'PT axial',    1, wcww);
  imageBoxInfos.value[1] = makeVolumeBoxForPlane(petIdx, 'cor', 'PT coronal',  1, wcww);
  imageBoxInfos.value[2] = makeVolumeBoxForPlane(petIdx, 'sag', 'PT sagittal', 1, wcww);
  // MIP は PET の coronal-like 視軸を使う (既存 PET Standard と同じ式)
  const pet = seriesList[petIdx].volume!;
  const pP0 = voxelToWorld_(new THREE.Vector3(0, 0, 0), petIdx);
  const pP1 = voxelToWorld_(new THREE.Vector3(pet.nx, pet.ny, pet.nz), petIdx);
  imageBoxInfos.value[3] = {
    clut: 1, myWC: 3, myWW: 6, description: 'PT MIP',
    currentSeriesNumber: petIdx,
    centerInWorld: pP0.add(pP1).divideScalar(2),
    vecx: pet.vectorX.clone(),
    vecy: pet.vectorZ.clone().normalize().multiplyScalar(pet.vectorX.length()),
    vecz: pet.vectorY.clone(),
    isMip: true,
    mip: { mipAngle: 0, isSurface: false, thresholdSurfaceMip: 0.3, depthSurfaceMip: 3 },
  } as VolumeImageBoxInfo;
  tileN.value = 4;
  refreshSegStoreVolumeRefs();
  autoFitMode.value = true;
  applyAutoFit();
  await nextTick();
  if (imb.value) for (const a of imb.value) a.init();
  show();
};

// L4 Compare 2-up: 1×2 (同 plane で 2 series 横並び)
// PT が 2 つ以上あれば PT axial × 2、無ければ CT/PT 並びにフォールバック。
const setupCompare2up = async () => {
  // PT 2 つ
  const ptIdxs: number[] = [];
  for (let i = 0; i < seriesList.length; i++) {
    const v = seriesList[i].volume;
    const m = (v?.metadata?.modality)
      ?? ((seriesList[i].myDicom?.[0]?.string('x00080060') ?? '').toUpperCase() === 'PT' ? 'PT' : '');
    if (m === 'PT' || m === 'PET') ptIdxs.push(i);
  }
  let leftIdx: number, rightIdx: number, leftDesc: string, rightDesc: string;
  let leftClut = 1, rightClut = 1;
  let wcL = { wc: 3, ww: 6 }, wcR = { wc: 3, ww: 6 };
  if (ptIdxs.length >= 2) {
    leftIdx = ptIdxs[0]; rightIdx = ptIdxs[1];
    leftDesc = seriesSummaries.value[leftIdx]?.description ?? 'PT 1';
    rightDesc = seriesSummaries.value[rightIdx]?.description ?? 'PT 2';
  } else {
    // Fallback: CT vs PT
    let ctIdx = -1, petIdx = -1;
    for (let i = 0; i < seriesList.length; i++) {
      const dl = seriesList[i].myDicom;
      const m = (dl?.[0]?.string('x00080060') ?? '').toUpperCase();
      if (m === 'CT' && ctIdx < 0) ctIdx = i;
      if ((m === 'PT' || m === 'PET') && petIdx < 0) petIdx = i;
    }
    if (ctIdx < 0 && petIdx < 0) { alert('At least one PT or CT series is required.'); return; }
    if (ctIdx < 0) { leftIdx = petIdx; rightIdx = petIdx; }
    else if (petIdx < 0) { leftIdx = ctIdx; rightIdx = ctIdx; leftClut = 0; rightClut = 0; wcL = { wc: 40, ww: 400 }; wcR = wcL; }
    else { leftIdx = ctIdx; rightIdx = petIdx; leftClut = 0; wcL = { wc: 40, ww: 400 }; }
    leftDesc = seriesSummaries.value[leftIdx]?.description ?? '';
    rightDesc = seriesSummaries.value[rightIdx]?.description ?? '';
  }
  if (!seriesList[leftIdx].volume)  { if (!mpr_(leftIdx))  return; }
  if (!seriesList[rightIdx].volume) { if (!mpr_(rightIdx)) return; }
  imageBoxInfos.value[0] = makeVolumeBoxForPlane(leftIdx,  'axi', leftDesc,  leftClut,  wcL);
  imageBoxInfos.value[1] = makeVolumeBoxForPlane(rightIdx, 'axi', rightDesc, rightClut, wcR);
  tileN.value = 2;
  refreshSegStoreVolumeRefs();
  autoFitMode.value = true;
  applyAutoFit();
  await nextTick();
  if (imb.value) for (const a of imb.value) a.init();
  show();
};

// ===== テスト DICOM 自動オープン =====
// Chromium 系: showDirectoryPicker() を使い、選んだフォルダのハンドルをセッション中キャッシュ。
// 一度選べば「Load test DICOM」ボタンで即時再ロード可能。
let cachedTestDirHandle: any = null;

const collectFilesFromDirHandle = async (dirHandle: any): Promise<File[]> => {
  const out: File[] = [];
  const walk = async (h: any) => {
    for await (const entry of h.values()){
      if (entry.kind === 'file'){
        try { out.push(await entry.getFile()); } catch {}
      } else if (entry.kind === 'directory'){
        await walk(entry);
      }
    }
  };
  await walk(dirHandle);
  return out;
};

const loadTestDicom = async () => {
  const w = window as any;
  if (typeof w.showDirectoryPicker !== 'function'){
    alert('This browser does not support the File System Access API. Please use Chrome or Edge.');
    return;
  }
  try {
    if (!cachedTestDirHandle){
      cachedTestDirHandle = await w.showDirectoryPicker();
    }
    isLoading.value = true;
    const files = await collectFilesFromDirHandle(cachedTestDirHandle);
    if (files.length === 0){
      alert('No files found in the selected folder.');
      isLoading.value = false;
      return;
    }
    // ロード完了 → 自動で PET Standard へ。loadFiles は非同期（FileReader ベース）なので
    // doSort 完了を待ってから setupPetStandardView を実行する。
    // loadFiles の poll callback が isLoading を false にするので、それを watch で検知。
    const stopWatch = watch(isLoading, async (v) => {
      if (v === false){
        stopWatch();
        await nextTick();
        // PET/CT が揃っていれば自動で標準ビューへ
        const list = seriesSummaries.value;
        const hasPt = list.some(s => s.modality === 'PT' || s.modality === 'PET');
        const hasCt = list.some(s => s.modality === 'CT');
        if (hasPt && hasCt){
          tileN.value = 4;
          await nextTick();
          await setupPetStandardView();
        }
      }
    });
    loadFiles(files);
  } catch (err){
    console.warn('loadTestDicom canceled or failed', err);
    isLoading.value = false;
  }
};

const disableAutoFit = () => { autoFitMode.value = false; };
const fitToWindow = () => {
  autoFitMode.value = true;
  applyAutoFit();
};

// SeriesList でサムネ paging するときに任意 slice のサムネを生成するための provide。
// SeriesList は seriesList[] や myDicom 配列を直接見られないので、ここからクロージャで提供。
provide('getThumbnailForSlice', (seriesIdx: number, sliceIdx: number): string | null => {
  if (seriesIdx < 0 || seriesIdx >= seriesList.length) return null;
  const s = seriesList[seriesIdx];
  if (!s) return null;
  const modality = seriesSummaries.value[seriesIdx]?.modality ?? '-';
  return generateThumbnail(s, modality, sliceIdx);
});
provide('getSliceCount', (seriesIdx: number): number => {
  if (seriesIdx < 0 || seriesIdx >= seriesList.length) return 0;
  const s = seriesList[seriesIdx];
  if (!s) return 0;
  if (s.volume) return s.volume.nz;
  if (s.myDicom) return s.myDicom.length;
  return 0;
});

defineExpose({
  setupPetStandardView,
  setupTriplanarPt,
  setupTriplanarFused,
  setupPtOnly4up,
  setupCompare2up,
  loadTestDicom,
  disableAutoFit,
  fitToWindow,
  seriesSummariesPublic: seriesSummaries,
  fusion,
  // ★2: JPEG Lossless decompress 進捗を App-bar から参照可能に
  jpegDecompressInProgress,
  jpegDecompressDone,
  jpegDecompressTotal,
  // Tracer preset
  applyTracerPreset,
  applyTracerById,
  // DICOM tag viewer
  getActiveTagContext,
  getTagContextForSeries,
  activeTagContext,
});

</script>

<template>
  <!-- Left sidebar: navigation / IO / view / series -->
  <v-navigation-drawer
    v-model="drawer"
    width="280"
    class="mv-pane"
    :border="0"
  >
    <sidebar
      :series-summaries="seriesSummaries"
      @fileLoaded="loadFile"
      @dirLoaded="loadFiles"
      @sort="doSort"
      @leftButtonFunctionChanged="leftButtonFunctionChanged"
      @presetSelected="presetSelected"
      @changeSlice="changeSlice_"
      @setModality="onSetSeriesModality"
      @setActiveForSeg="onSetActiveForSeg"
      @phantom1="phantom1"
      @phantom2="phantom2"
      @phantom3="phantom3"
      @redraw="show"
    />
  </v-navigation-drawer>

  <!-- Right inspector: segmentation -->
  <v-navigation-drawer
    v-model="inspector"
    width="320"
    location="right"
    class="mv-pane"
    :border="0"
  >
    <div class="mv-inspector-header">
      <span class="mv-section-title">Segmentation</span>
      <v-spacer />
      <v-btn
        icon="mdi-close"
        size="x-small"
        variant="text"
        @click="inspector = false"
      />
    </div>
    <SegmentationPanel @redraw="show" />
  </v-navigation-drawer>

  <!-- Image area -->
  <div class="mv-imagearea" id="hello"
       @dragover.prevent
       @drop.prevent="(e: DragEvent) => dropFile(e)">
    <!-- 起動直後 / Close all 後の empty state。box ゼロ時のみ表示 -->
    <div v-if="(tileN ?? 0) === 0" class="mv-imagearea-empty">
      <v-icon icon="mdi-image-off-outline" size="56" />
      <span class="mv-imagearea-empty-title">No image</span>
      <span class="mv-imagearea-empty-hint">Drop DICOM or NIfTI files (.nii / .nii.gz) here</span>
    </div>
    <div class="mv-tile-grid" :class="{ 'is-no-gap': noGapMode }" :style="gridStyle">
      <imagebox
        v-for="i in tileN"
        :key="i"
        :class="['mv-imagebox-cell', { 'is-selected': i-1 === selectedImageBoxId, 'cursor-grab': leftButtonFunction==='pan' }]"
        ref="imb"
        :imageBoxId="i-1"
        :width="imageBoxW"
        :height="imageBoxH"
        @wheel.prevent="wheel"
        @click="imageBoxClicked"
        @mousemove="mouseMove"
        @mouseleave="debugShow = false"
        @mousedown.middle.prevent
        @auxclick.prevent
        @contextmenu="onContextMenu"
        @dblclick="onDblClick"
        @dragenter="dragEnter"
        @dragleave="dragLeave"
        @dragover.prevent
        @drop.prevent="(e: DragEvent) => dropFile(e, i-1)"
        :isEnter="isEnter"
        :selected="i-1 === selectedImageBoxId"
        :modality-label="getBoxModalityLabel(i-1)"
        :description="getBoxDescription(i-1)"
        :box-kind="getBoxKind(i-1)"
        :current-plane="getBoxCurrentPlane(i-1)"
        :current-clut="getBoxCurrentClut(i-1)"
        :legend="getBoxLegend(i-1)"
        :legend2="getBoxLegend2(i-1)"
        :corner-info="cornerInfoFor(i-1)"
        :cross-ref-lines="crossRefLinesFor(i-1)"
        :crosshair-x="getBoxCrosshairX(i-1)"
        :crosshair-y="getBoxCrosshairY(i-1)"
        :sync-enabled="isBoxSyncEnabled(i-1)"
        :global-sync-on="!!syncImageBox"
        @close-box="onTitlebarClose(i-1)"
        @reset-view="onTitlebarResetView(i-1)"
        @set-plane="(p: 'axi'|'cor'|'sag'|'mip'|'smip'|'vr') => onTitlebarSetPlane(i-1, p)"
        @set-clut="(c: number) => onTitlebarSetClut(i-1, c)"
        @toggle-sync="onTitlebarToggleSync(i-1)"
        @maximize="onTitlebarMaximize(i-1)"
        @toggle-overlay="onTitlebarToggleOverlay(i-1)"
        @make-mpr="onTitlebarMakeMpr(i-1)"
        @modality-drag-start="(e: DragEvent) => onModalityDragStart(e, i-1)"
      />
    </div>

    <textarea v-if="showSummary" v-model="summaryText" style="height: auto;" />
    <textarea v-if="showTag" v-model="tagText" style="height: 400px;" />

    <!-- Debug: voxel hover inspector -->
    <DebugInspector
      :enabled="debugMode"
      :rows="debugHoverRows"
      :screen-x="debugScreenX"
      :screen-y="debugScreenY"
      :show="debugShow"
    />

    <!-- Debug: indicator badge (画面右下) -->
    <div v-if="debugMode" class="mv-debug-badge">
      <v-icon icon="mdi-bug" size="x-small" />
      DEBUG
      <span class="hint">Shift+Click=edit voxel / Ctrl+Shift+D=toggle</span>
    </div>
  </div>

  <!-- Auto-save recovery dialog -->
  <v-dialog v-model="showRecoveryDialog" max-width="480" persistent>
    <v-card v-if="recoveryCandidate" class="mv-recovery-card">
      <v-card-title class="mv-recovery-title">
        <v-icon icon="mdi-history" class="mr-2" color="primary" />
        Recover previous session?
      </v-card-title>
      <v-card-text>
        <div class="mv-recovery-line">
          <strong>{{ recoveryCandidate.seriesDescription || 'Unknown series' }}</strong>
        </div>
        <div class="mv-recovery-line mv-recovery-meta">
          Last edited <strong>{{ formatRelativeTime(recoveryCandidate.savedAt) }}</strong>
          ({{ new Date(recoveryCandidate.savedAt).toLocaleString() }})
        </div>
        <div class="mv-recovery-line mv-recovery-meta">
          {{ recoveryCandidate.dims[0] }}×{{ recoveryCandidate.dims[1] }}×{{ recoveryCandidate.dims[2] }}
          · {{ recoveryCandidate.labels?.length ?? 0 }} labels
        </div>
        <div class="mv-recovery-hint">
          Loading the saved mask will replace any current segmentation on this PT.
        </div>
      </v-card-text>
      <v-card-actions>
        <v-btn variant="text" @click="onRecoverDiscard">Discard saved</v-btn>
        <v-spacer />
        <v-btn variant="text" @click="onRecoverSkip">Skip</v-btn>
        <v-btn variant="flat" color="primary" @click="onRecoverYes">Recover</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.mv-tile-grid {
  display: grid;
  gap: 6px;
  justify-content: center;
  align-content: start;
  margin: auto;
}
/* 「全体化」モード: タイル間 gap を排除して画像エリアを最大限活用 */
.mv-tile-grid.is-no-gap {
  gap: 0;
}

/* 起動直後 / Close all 後: box ゼロのときの empty state */
.mv-imagearea-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  height: 100%;
  color: var(--mv-text-muted, #5A6877);
  user-select: none;
  pointer-events: none;
}
.mv-imagearea-empty-title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.mv-imagearea-empty-hint {
  font-size: 11px;
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  color: var(--mv-text-dim, #8FA0B0);
}

.mv-inspector-header {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid var(--mv-border);
  position: sticky;
  top: 0;
  background: var(--mv-surface);
  z-index: 1;
}

/* drawer 内のテキストが上端で見切れないよう */
:deep(.v-navigation-drawer__content) {
  padding-top: 0;
}

.mv-debug-badge {
  position: fixed;
  right: 12px;
  bottom: 12px;
  z-index: 9998;
  background: rgba(255, 92, 122, 0.18);
  border: 1px solid var(--mv-error);
  color: var(--mv-error);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 4px 8px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
  pointer-events: none;
}
.mv-debug-badge .hint {
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  color: var(--mv-text-muted);
  margin-left: 6px;
}

/* Auto-save recovery dialog */
.mv-recovery-card {
  background: var(--mv-surface) !important;
  color: var(--mv-text);
}
.mv-recovery-title {
  display: flex;
  align-items: center;
  font-size: 16px !important;
  font-weight: 600;
  padding-top: 16px !important;
}
.mv-recovery-line {
  font-size: 13px;
  margin-bottom: 4px;
}
.mv-recovery-meta {
  color: var(--mv-text-dim);
  font-size: 12px;
  font-feature-settings: 'tnum';
}
.mv-recovery-hint {
  margin-top: 10px;
  padding: 8px 10px;
  background: rgba(255, 180, 84, 0.08);
  border: 1px solid rgba(255, 180, 84, 0.3);
  border-radius: 4px;
  color: var(--mv-warning);
  font-size: 11px;
}
</style>



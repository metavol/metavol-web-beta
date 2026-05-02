<template>
  <v-app>
    <v-app-bar class="mv-appbar" flat density="compact" :height="48">
      <template v-slot:prepend>
        <v-menu>
          <template v-slot:activator="{ props: act }">
            <v-btn
              v-bind="act"
              icon="mdi-menu"
              variant="text"
              size="small"
            />
          </template>
          <v-list density="compact">
            <v-list-item @click="drawerLeft = !drawerLeft">
              <template v-slot:prepend>
                <v-icon icon="mdi-dock-left" size="small" />
              </template>
              <v-list-item-title>{{ drawerLeft ? 'Hide sidebar' : 'Show sidebar' }}</v-list-item-title>
            </v-list-item>
            <v-list-item
              :disabled="!canShowTags"
              @click="onShowTags"
            >
              <template v-slot:prepend>
                <v-icon icon="mdi-tag-text-outline" size="small" />
              </template>
              <v-list-item-title>DICOM Tags</v-list-item-title>
              <v-list-item-subtitle v-if="!canShowTags">
                Select a DICOM box first
              </v-list-item-subtitle>
            </v-list-item>
            <v-divider />
            <v-list-item @click="browserSupportOpen = true">
              <template v-slot:prepend>
                <v-icon icon="mdi-web" size="small" />
              </template>
              <v-list-item-title>Browser support</v-list-item-title>
            </v-list-item>
          </v-list>
        </v-menu>
      </template>

      <div class="mv-brand ml-1">
        meta<span class="mv-brand-accent">vol</span>-web
      </div>

      <v-divider vertical class="mx-3" />

      <!-- Tool icons -->
      <div class="mv-tools">
        <v-btn
          v-for="t in tools"
          :key="t.value"
          :class="['mv-tool-btn', { 'is-active': leftButtonFunction === t.value }]"
          variant="text"
          size="small"
          @click="leftButtonFunction = leftButtonFunction === t.value ? null : t.value"
        >
          <v-icon :icon="t.icon" />
          <v-tooltip activator="parent" location="bottom">{{ t.label }}</v-tooltip>
        </v-btn>
      </div>

      <v-spacer />

      <!-- JPEG Lossless decompress progress (★2) -->
      <div v-if="jpegProgress.inProgress" class="mv-jpeg-progress mr-2">
        <v-icon icon="mdi-package-variant" size="x-small" class="mr-1" />
        <span class="mv-jpeg-progress-label">
          Decompressing JPEG Lossless… {{ jpegProgress.done }} / {{ jpegProgress.total }}
        </span>
        <v-progress-linear
          :model-value="jpegProgress.percent"
          height="3"
          color="primary"
          class="mv-jpeg-progress-bar"
        />
      </div>

      <v-btn
        class="mv-pet-std-btn mr-1"
        variant="flat"
        size="small"
        :disabled="!petCtReady"
        @click="petStandardView"
      >
        <v-icon icon="mdi-view-grid" class="mr-1" size="small" />
        PET Standard
        <v-tooltip activator="parent" location="bottom">
          {{ petCtReady ? '2x2: CT axi / PET axi / Fusion axi / PET MIP' : 'Load both PET and CT first' }}
        </v-tooltip>
      </v-btn>

      <v-menu>
        <template v-slot:activator="{ props: act }">
          <v-btn
            v-bind="act"
            class="mv-tool-btn mv-tool-btn--wide mr-1"
            variant="text"
            size="small"
          >
            <v-icon icon="mdi-view-dashboard-outline" />
            <span class="mv-tool-label">Layouts</span>
            <v-tooltip activator="parent" location="bottom">More layout presets</v-tooltip>
          </v-btn>
        </template>
        <v-list density="compact">
          <v-list-item @click="runLayout('triplanarPt')">
            <template v-slot:prepend>
              <v-icon icon="mdi-view-week-outline" size="small" />
            </template>
            <v-list-item-title>Triplanar PT (1×3)</v-list-item-title>
            <v-list-item-subtitle>PT axial / coronal / sagittal</v-list-item-subtitle>
          </v-list-item>
          <v-list-item @click="runLayout('triplanarFused')">
            <template v-slot:prepend>
              <v-icon icon="mdi-view-week" size="small" />
            </template>
            <v-list-item-title>Triplanar Fused (1×3)</v-list-item-title>
            <v-list-item-subtitle>Fused axial / coronal / sagittal</v-list-item-subtitle>
          </v-list-item>
          <v-list-item @click="runLayout('ptOnly4up')">
            <template v-slot:prepend>
              <v-icon icon="mdi-view-grid" size="small" />
            </template>
            <v-list-item-title>PT-only 4-up (2×2)</v-list-item-title>
            <v-list-item-subtitle>PT axi / cor / sag / MIP</v-list-item-subtitle>
          </v-list-item>
          <v-list-item @click="runLayout('compare2up')">
            <template v-slot:prepend>
              <v-icon icon="mdi-compare" size="small" />
            </template>
            <v-list-item-title>Compare 2-up (1×2)</v-list-item-title>
            <v-list-item-subtitle>Two series side-by-side, same plane</v-list-item-subtitle>
          </v-list-item>
        </v-list>
      </v-menu>

      <v-menu>
        <template v-slot:activator="{ props: act }">
          <v-btn
            v-bind="act"
            :class="['mv-tool-btn', 'mv-tool-btn--wide', 'mr-1', { 'is-active': !!activeTracer }]"
            variant="text"
            size="small"
          >
            <v-icon icon="mdi-flask-outline" />
            <span class="mv-tool-label">{{ activeTracer ? activeTracer.name : 'Tracer' }}</span>
            <v-tooltip activator="parent" location="bottom">
              {{ activeTracer
                ? `Active: ${activeTracer.name} — click to switch`
                : 'Pick a tracer preset (SUV threshold + window + labels)' }}
            </v-tooltip>
          </v-btn>
        </template>
        <v-list density="compact">
          <v-list-item
            v-for="t in tracerPresets"
            :key="t.id"
            :active="segStore.activeTracerId === t.id"
            @click="onTracerSelected(t.id)"
          >
            <template v-slot:prepend>
              <v-icon icon="mdi-radioactive" size="small" />
            </template>
            <v-list-item-title>{{ t.name }}</v-list-item-title>
            <v-list-item-subtitle class="mv-tracer-sub">
              SUV {{ t.suvThreshold }} · 0–{{ (t.suvWindow.wc + t.suvWindow.ww / 2).toFixed(0) }} · {{ t.labels.length }} labels
            </v-list-item-subtitle>
          </v-list-item>
        </v-list>
      </v-menu>

      <v-btn
        class="mv-tool-btn mv-tool-btn--wide mr-2"
        variant="text"
        size="small"
        :disabled="!petCtReady"
        @click="runFusion"
      >
        <v-icon icon="mdi-circle-multiple-outline" />
        <span class="mv-tool-label">Fusion</span>
        <v-tooltip activator="parent" location="bottom">
          {{ petCtReady ? 'Fuse CT (base) + PET (overlay) into the active box' : 'Load both PET and CT first' }}
        </v-tooltip>
      </v-btn>

      <v-divider vertical class="mx-2" />

      <v-btn
        :class="['mv-tool-btn', { 'is-active': syncImageBox }]"
        variant="text"
        size="small"
        @click="syncImageBox = !syncImageBox"
      >
        <v-icon icon="mdi-link-variant" />
        <v-tooltip activator="parent" location="bottom">{{ syncImageBox ? 'Sync ON' : 'Sync OFF' }}</v-tooltip>
      </v-btn>

      <v-btn
        :class="['mv-tool-btn', { 'is-active': voxelInspector }]"
        variant="text"
        size="small"
        @click="voxelInspector = !voxelInspector"
      >
        <v-icon icon="mdi-eyedropper" />
        <v-tooltip activator="parent" location="bottom">
          {{ voxelInspector ? 'Voxel inspector ON (hover to read voxel values)' : 'Voxel inspector OFF (Ctrl+Shift+D)' }}
        </v-tooltip>
      </v-btn>

      <v-btn
        :class="['mv-tool-btn', { 'is-active': showOverlayInfo }]"
        variant="text"
        size="small"
        @click="showOverlayInfo = !showOverlayInfo"
      >
        <v-icon icon="mdi-information-outline" />
        <v-tooltip activator="parent" location="bottom">
          {{ showOverlayInfo ? 'Hide patient/exam info overlay' : 'Show patient/exam info overlay' }}
        </v-tooltip>
      </v-btn>

      <v-btn
        class="mv-tool-btn"
        variant="text" size="small"
        @click="changeImageBoxSize(-50)"
      >
        <v-icon icon="mdi-magnify-minus-outline" />
        <v-tooltip activator="parent" location="bottom">Smaller</v-tooltip>
      </v-btn>
      <v-btn
        class="mv-tool-btn"
        variant="text" size="small"
        @click="changeImageBoxSize(50)"
      >
        <v-icon icon="mdi-magnify-plus-outline" />
        <v-tooltip activator="parent" location="bottom">Larger</v-tooltip>
      </v-btn>
      <v-btn
        class="mv-tool-btn"
        variant="text" size="small"
        @click="fitToWindow"
      >
        <v-icon icon="mdi-fit-to-screen-outline" />
        <v-tooltip activator="parent" location="bottom">Fit to window</v-tooltip>
      </v-btn>
      <v-btn
        :class="['mv-tool-btn', { 'is-active': noGapMode }]"
        variant="text" size="small"
        @click="noGapMode = !noGapMode"
      >
        <v-icon icon="mdi-arrow-expand-all" />
        <v-tooltip activator="parent" location="bottom">
          {{ noGapMode ? 'Edge-to-edge tiles ON (gap = 0)' : 'Edge-to-edge tiles OFF (click to fill the image area without gaps)' }}
        </v-tooltip>
      </v-btn>

      <v-divider vertical class="mx-1" />

      <v-menu>
        <template v-slot:activator="{ props }">
          <v-btn class="mv-tool-btn mv-tool-btn--wide" variant="text" size="small" v-bind="props">
            <v-icon icon="mdi-view-grid-outline" />
            <span class="mv-tool-label">{{ tileN }}</span>
            <v-tooltip activator="parent" location="bottom">Tile count</v-tooltip>
          </v-btn>
        </template>
        <v-list density="compact" @click:select="clickItem">
          <v-list-item v-for="n in [1,2,3,4,6,8,9,10,12]" :key="n" :value="String(n)">
            <v-list-item-title>{{ n }} {{ n === 1 ? 'box' : 'boxes' }}</v-list-item-title>
          </v-list-item>
        </v-list>
      </v-menu>

      <v-btn
        class="mv-tool-btn"
        variant="text"
        size="small"
        @click="drawerRight = !drawerRight"
      >
        <v-icon icon="mdi-format-vertical-align-top" style="transform: rotate(90deg)" />
        <v-tooltip activator="parent" location="bottom">{{ drawerRight ? 'Hide inspector' : 'Show inspector' }}</v-tooltip>
      </v-btn>

      <v-btn
        class="mv-tool-btn"
        variant="text"
        size="small"
        color="error"
        @click="closingImages = true"
      >
        <v-icon icon="mdi-trash-can-outline" />
        <v-tooltip activator="parent" location="bottom">Close all</v-tooltip>
      </v-btn>
    </v-app-bar>

    <v-main>
      <DicomView
        ref="dicomViewRef"
        v-model:drawer="drawerLeft"
        v-model:inspector="drawerRight"
        v-model:leftButtonFunction="leftButtonFunction"
        v-model:imageBoxW="imageBoxW"
        v-model:imageBoxH="imageBoxH"
        v-model:tileN="tileN"
        v-model:syncImageBox="syncImageBox"
        v-model:closingImages="closingImages"
        v-model:debugMode="voxelInspector"
        v-model:showOverlayInfo="showOverlayInfo"
        v-model:noGapMode="noGapMode"
      />
    </v-main>

    <DicomTagDialog
      v-model="tagDialogOpen"
      :dataset="tagContext?.dataset ?? null"
      :series-label="tagContext?.label ?? ''"
      :slice-index="tagContext?.sliceIndex"
      :slice-count="tagContext?.sliceCount"
    />

    <!-- Browser support dialog -->
    <v-dialog v-model="browserSupportOpen" max-width="540">
      <v-card>
        <v-card-title class="text-body-1">Browser support</v-card-title>
        <v-card-text>
          <div class="mv-ua-line">{{ userAgent }}</div>
          <v-list density="compact" class="mv-bs-list">
            <v-list-item v-for="c in browserChecks" :key="c.name">
              <template v-slot:prepend>
                <v-icon
                  :icon="c.supported ? 'mdi-check-circle' : (c.critical ? 'mdi-alert-circle' : 'mdi-information-outline')"
                  :color="c.supported ? 'success' : (c.critical ? 'error' : 'warning')"
                  size="small"
                />
              </template>
              <v-list-item-title>{{ c.name }}</v-list-item-title>
              <v-list-item-subtitle v-if="!c.supported && !c.critical">
                Optional — feature unavailable in this browser
              </v-list-item-subtitle>
            </v-list-item>
          </v-list>
          <p class="mv-bs-note">
            Best experienced on Chrome or Edge. DICOM/NIfTI loading via drag-and-drop works on Firefox and Safari too.
          </p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="browserSupportOpen = false">Close</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-app>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import DicomView from "./components/DicomView.vue";
import { getWH, getTileN } from "./components/UrlParser.ts";
import { useSegmentationStore } from "./stores/segmentation";
import { ensureWasmCodecsReady } from "./components/wasmCodec";
import { TRACER_PRESETS, tracerById } from "./components/tracerPresets";
import DicomTagDialog from "./components/DicomTagDialog.vue";

// アプリ起動時に dcmjs-codecs WASM をプリウォーム (DICOM JPEG Lossless 用)。
// ~4 MB の WASM を fetch + instantiate するので体感 0.3-1s かかる。
// バックグラウンドで進行、失敗時は jpeg-lossless-decoder-js (純 JS) にフォールバック。
onMounted(() => {
  ensureWasmCodecsReady().catch(err => {
    console.warn('[wasm-codecs] init failed (will fall back to pure JS for JPEG Lossless):', err);
  });
});

const segStore = useSegmentationStore();

// PET Standard ボタンを enable する条件:
//   (a) PET/CT 両方の Volume が既に MPR 済み、または
//   (b) DicomView が公開する seriesSummaries に PT と CT の DICOM がある
const seriesSummariesView = computed(() => dicomViewRef.value?.seriesSummariesPublic ?? []);
const petCtReady = computed(() => {
  if (segStore.petVolumeRef && segStore.ctVolumeRef) return true;
  const list = seriesSummariesView.value as Array<any>;
  const hasPt = list.some(s => s.modality === 'PT' || s.modality === 'PET');
  const hasCt = list.some(s => s.modality === 'CT');
  return hasPt && hasCt;
});

const drawerLeft = ref(true);
// Inspector (右ドロワ) は初期非表示 — segmentation 開始時にユーザが ☰ 横の inspector トグルで開く
const drawerRight = ref(false);
const leftButtonFunction = ref<string | null>(null);
const [w, h] = getWH();
const imageBoxW = ref(w);
const imageBoxH = ref(h);
const closingImages = ref(false);
const tileN = ref(getTileN());
const syncImageBox = ref(false);
const voxelInspector = ref(false);
const showOverlayInfo = ref(true);
const noGapMode = ref(false);

const tools = [
  { value: 'window',     icon: 'mdi-contrast-circle',       label: 'Window/Level' },
  { value: 'pan',        icon: 'mdi-hand-back-right-outline', label: 'Pan' },
  { value: 'zoom',       icon: 'mdi-magnify-plus-outline',  label: 'Zoom' },
  { value: 'page',       icon: 'mdi-arrow-up-down',         label: 'Page' },
  { value: 'sphereROI',  icon: 'mdi-circle-outline',        label: 'Sphere ROI' },
  { value: 'polygonROI', icon: 'mdi-pentagon-outline',      label: 'Polygon ROI' },
  { value: 'assignLabel',icon: 'mdi-tag-outline',           label: 'Assign Label' },
];

const changeImageBoxSize = (d: number) => {
  // 現在のアスペクト比を保持したまま縦サイズを d だけ増減 (横は比例変化)
  const curH = imageBoxH.value || 1;
  const curW = imageBoxW.value || 1;
  const ratio = curW / curH;
  let h = curH + d;
  if (h < 100) h = 100;
  if (h > 1500) h = 1500;
  const w = Math.max(100, Math.round(h * ratio));
  imageBoxH.value = h;
  imageBoxW.value = w;
  // 手動サイズ変更で autoFit を解除
  dicomViewRef.value?.disableAutoFit?.();
};

const fitToWindow = () => {
  dicomViewRef.value?.fitToWindow?.();
};

const clickItem = (e: any) => {
  tileN.value = Number(e.id);
};

const dicomViewRef = ref<any>(null);
const petStandardView = () => {
  tileN.value = 4;
  setTimeout(() => {
    dicomViewRef.value?.setupPetStandardView?.();
  }, 50);
};

const runFusion = () => {
  dicomViewRef.value?.fusion?.();
};

const runLayout = (kind: 'triplanarPt' | 'triplanarFused' | 'ptOnly4up' | 'compare2up') => {
  const r = dicomViewRef.value;
  if (!r) return;
  if (kind === 'triplanarPt')   r.setupTriplanarPt?.();
  if (kind === 'triplanarFused') r.setupTriplanarFused?.();
  if (kind === 'ptOnly4up')     r.setupPtOnly4up?.();
  if (kind === 'compare2up')    r.setupCompare2up?.();
};

// Tracer preset を pull-down で適用
const tracerPresets = TRACER_PRESETS;
const activeTracer = computed(() => {
  const id = segStore.activeTracerId;
  return id ? tracerById(id) : null;
});
const onTracerSelected = (id: string) => {
  dicomViewRef.value?.applyTracerById?.(id);
};

// DICOM tag viewer (non-modal). 開いている間 paging に追従して中身が更新される。
// dicomViewRef が expose する activeTagContext (computed ref) を直接読む。
const tagDialogOpen = ref(false);
const tagContext = computed(() => {
  if (!tagDialogOpen.value) return null;
  // Vue の defineExpose で expose された computed は ref として渡される。.value で unwrap。
  const ctxRef: any = dicomViewRef.value?.activeTagContext;
  if (ctxRef == null) return null;
  // dicomViewRef.value は ComponentPublicInstance 越しなので、computed は自動 unwrap される。
  return ctxRef as { dataset: any; label: string; sliceIndex: number; sliceCount: number } | null;
});
const onShowTags = () => {
  tagDialogOpen.value = true;
};

// メニュー項目の disable 制御:
// activeTagContext は Volume / Fusion / MIP の Box が選択されているとき null を返す。
const canShowTags = computed<boolean>(() => {
  return !!dicomViewRef.value?.activeTagContext;
});

// Browser support dialog
const browserSupportOpen = ref(false);
const userAgent = computed(() => navigator.userAgent);
const browserChecks = computed(() => {
  const w = window as unknown as { showDirectoryPicker?: unknown };
  const hasFolderDrag = typeof DataTransferItem !== 'undefined'
    && typeof DataTransferItem.prototype !== 'undefined'
    && 'webkitGetAsEntry' in DataTransferItem.prototype;
  return [
    { name: 'File API (FileReader)',         supported: typeof FileReader !== 'undefined', critical: true },
    { name: 'Drag-and-drop files',           supported: typeof DragEvent !== 'undefined',  critical: true },
    { name: 'Drag folders into the app',     supported: hasFolderDrag,                     critical: false },
    { name: 'Folder picker (showDirectoryPicker)', supported: typeof w.showDirectoryPicker === 'function', critical: false },
    { name: 'Canvas 2D rendering',           supported: typeof HTMLCanvasElement !== 'undefined', critical: true },
    { name: 'Typed arrays (Float32 / Int16)', supported: typeof Float32Array !== 'undefined' && typeof Int16Array !== 'undefined', critical: true },
  ];
});

// ★2: JPEG Lossless decompress 進捗を app-bar に表示
const jpegProgress = computed(() => {
  const r = dicomViewRef.value;
  const inProgress = !!r?.jpegDecompressInProgress;
  const done = (r?.jpegDecompressDone as number) ?? 0;
  const total = (r?.jpegDecompressTotal as number) ?? 0;
  const percent = total > 0 ? (done / total) * 100 : 0;
  return { inProgress, done, total, percent };
});
</script>

<style scoped>
.mv-tools {
  display: flex;
  gap: 2px;
  align-items: center;
  flex-wrap: nowrap;
}

/* app-bar 内の divider を細く */
:deep(.v-app-bar .v-divider) {
  border-color: var(--mv-border) !important;
  height: 24px !important;
  min-height: 24px !important;
  align-self: center !important;
  opacity: 1;
}

.mv-pet-std-btn {
  background: var(--mv-accent) !important;
  color: var(--mv-bg) !important;
  font-weight: 600;
  text-transform: none;
  letter-spacing: 0.01em;
  border-radius: 6px;
  height: 32px;
}
.mv-pet-std-btn:hover {
  background: #00B894 !important;
}

:deep(.mv-tool-btn--wide) {
  width: auto !important;
  padding: 0 8px !important;
  gap: 4px;
}
:deep(.mv-tool-label) {
  font-size: 12px;
  font-weight: 600;
  color: var(--mv-text);
}

.mv-tracer-sub {
  font-size: 10px !important;
  color: var(--mv-text-muted) !important;
  font-family: 'JetBrains Mono', 'Consolas', monospace;
}

:deep(.v-app-bar) {
  border-bottom: 1px solid var(--mv-border);
}

/* ★2: JPEG Lossless decompress progress chip — pulse animation で「作業中」を強調 */
@keyframes mv-pulse-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(0, 212, 170, 0.45); }
  50%      { box-shadow: 0 0 8px 2px rgba(0, 212, 170, 0.55); }
}
.mv-jpeg-progress {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  padding: 4px 12px;
  background: var(--mv-surface-2, #222B36);
  border: 1px solid var(--mv-accent-dim, #007E66);
  border-radius: 6px;
  min-width: 240px;
  animation: mv-pulse-glow 1.6s ease-in-out infinite;
}
.mv-jpeg-progress-label {
  font-size: 11px;
  color: var(--mv-accent, #00D4AA);
  font-feature-settings: 'tnum';
  white-space: nowrap;
  font-weight: 600;
}
.mv-jpeg-progress-bar {
  border-radius: 2px;
}

/* Browser support dialog */
.mv-ua-line {
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  font-size: 11px;
  color: var(--mv-text-dim, #8FA0B0);
  word-break: break-all;
  background: var(--mv-surface-2, #222B36);
  padding: 6px 8px;
  border-radius: 3px;
  margin-bottom: 8px;
}
.mv-bs-list {
  background: transparent !important;
}
.mv-bs-note {
  margin-top: 8px;
  font-size: 11px;
  color: var(--mv-text-dim, #8FA0B0);
  line-height: 1.5;
}
</style>

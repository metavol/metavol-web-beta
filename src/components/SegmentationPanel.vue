<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import * as THREE from 'three';
import { useSegmentationStore } from '../stores/segmentation';
import { readNiftiMask } from './segmentation/niftiReader';
import { summarizeLesions, type LesionStat } from './segmentation/maskOps';
import { triggerDownload } from './segmentation/niftiWriter';
import { getSuvSanityWarnings, getSuvMetadataSummary } from './suvSanity';
import { applyRigidToVolume, type RegistrationSnapshot } from './registration/transform';
import { registerMrToPt } from './registration/registerMrPt';

const store = useSegmentationStore();

// Auto-saved relative time, refreshed every 5s so the label stays current.
const nowTick = ref(Date.now());
let nowTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => { nowTimer = setInterval(() => { nowTick.value = Date.now(); }, 5000); });
onUnmounted(() => { if (nowTimer) clearInterval(nowTimer); });

const autoSavedRel = computed(() => {
    const ts = store.lastAutoSavedAt;
    if (ts == null) return '';
    const dt = Math.max(0, nowTick.value - ts);
    const sec = Math.floor(dt / 1000);
    if (sec < 5) return 'just now';
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    return `${hr} h ago`;
});

const emit = defineEmits<{
    (e: 'redraw'): void;
}>();

const newLabelName = ref('');

const THRESHOLD_PRESETS = [
    { title: 'SUV 2.5', value: '2.5' },
    { title: 'SUV 3.0', value: '3.0' },
    { title: 'SUV 3.5', value: '3.5' },
    { title: 'SUV 4.0', value: '4.0' },
    { title: 'Manual', value: 'manual' },
];

// store.threshold に追従する combobox 表示。tracer preset 等で外部から変えられても UI が同期する。
// String(3.0) === "3" なので 1 桁固定の比較で行う。
const thresholdSelection = computed<string>({
    get: () => {
        const v = store.threshold;
        if (!Number.isFinite(v)) return 'manual';
        const s = v.toFixed(1);
        return ['2.5', '3.0', '3.5', '4.0'].includes(s) ? s : 'manual';
    },
    set: () => { /* setter は onThresholdSelectionChange 側で行う */ },
});

const onThresholdSelectionChange = (val: string) => {
    if (val !== 'manual') {
        store.threshold = Number(val);
    } else {
        // Manual を選んだだけでは数値は変えない (text-field で個別入力)
    }
};

const petAvailable = computed(() => store.hasPet);

const labelRows = computed(() => {
    const m = store.volumesByLabel;
    return store.labels.map(l => ({
        ...l,
        volume_mm3: m.get(l.id) ?? 0,
        colorCss: `rgb(${l.color[0]},${l.color[1]},${l.color[2]})`,
    }));
});

// 現在ラベルの PET 値ヒストグラム。
// finalMask 全 voxel をスキャン (maskVersion 依存) → label に該当する voxel の PET 値を bin 集計。
const HIST_BINS = 30;
const labelHistogram = computed(() => {
    void store.maskVersion; // reactivity 依存
    const id = store.currentLabelId;
    const pet = store.petVolumeRef;
    const mask = store.finalMask;
    if (!pet || !mask) return null;
    const pix = pet.voxel;

    let mn = Infinity, mx = -Infinity, sum = 0, sumSq = 0, n = 0;
    for (let i = 0; i < mask.length; i++) {
        if (mask[i] !== id) continue;
        const v = pix[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        sum += v;
        sumSq += v * v;
        n++;
    }
    if (n === 0) {
        return { count: 0, min: 0, max: 0, mean: 0, std: 0, counts: [] as number[], lo: 0, hi: 0, binWidth: 0, peak: 0 };
    }
    const mean = sum / n;
    const variance = Math.max(0, sumSq / n - mean * mean);
    const std = Math.sqrt(variance);

    const lo = 0;
    const hi = mx > lo ? mx : lo + 1;
    const binWidth = (hi - lo) / HIST_BINS;
    const counts = new Array<number>(HIST_BINS).fill(0);
    for (let i = 0; i < mask.length; i++) {
        if (mask[i] !== id) continue;
        const v = pix[i];
        let bi = Math.floor((v - lo) / binWidth);
        if (bi < 0) bi = 0;
        if (bi >= HIST_BINS) bi = HIST_BINS - 1;
        counts[bi]++;
    }
    let peak = 0;
    for (const c of counts) if (c > peak) peak = c;

    return { count: n, min: mn, max: mx, mean, std, counts, lo, hi, binWidth, peak };
});

const currentLabel = computed(() => store.labelById(store.currentLabelId));
const currentLabelColorCss = computed(() => {
    const l = currentLabel.value;
    if (!l) return 'var(--mv-accent)';
    return `rgb(${l.color[0]},${l.color[1]},${l.color[2]})`;
});

// SVG 表示領域
const HIST_VB_W = 220;
const HIST_VB_H = 60;

const onApplyThreshold = () => {
    store.applyThreshold(store.threshold);
    store.findIslands();
    emit('redraw');
};

const onClearThreshold = () => {
    store.clearThresholdMask();
    emit('redraw');
};

const onClearManual = () => {
    store.clearManualEdits();
    emit('redraw');
};

const onAddLabel = () => {
    const name = newLabelName.value.trim() || `lesion${store.labels.length + 1}`;
    const e = store.addLabel(name);
    store.currentLabelId = e.id;
    newLabelName.value = '';
};

const onSelectLabel = (id: number) => {
    store.currentLabelId = id;
};

const onRemoveLabel = (id: number) => {
    store.removeLabel(id);
    emit('redraw');
};

const onToggleOverlay = (val: boolean) => {
    store.overlayEnabled = val;
    emit('redraw');
};

const onAlphaChange = (val: number) => {
    store.overlayAlpha = val;
    emit('redraw');
};

const onFindIslands = () => {
    store.findIslands();
    emit('redraw');
};

const formatMm = (v: number) => v.toFixed(1);
const formatDeg = (v: number) => (v * 180 / Math.PI).toFixed(1);

const onRegisterMrPt = async () => {
    const pt = store.petVolumeRef;
    const mr = store.mrVolumeRef;
    if (!pt || !mr) {
        alert('PT and MR volumes are both required for registration.');
        return;
    }
    // snapshot 確保 (初回 or 既に存在)
    store.ensureMrRegistrationSnapshot();
    const snap = store.mrRegistrationSnapshot as RegistrationSnapshot;
    if (!snap) { alert('Could not capture MR snapshot.'); return; }
    // snapshot から原状復元してから最適化開始 (既存 transform は破棄)
    applyRigidToVolume(mr, snap, [0, 0, 0, 0, 0, 0]);
    store.setMrRegistrationParams(null);
    store.setMrRegistrationInProgress(true);
    store.setMrRegistrationProgress(null);

    // setTimeout でブラウザにレンダー機会を渡してから heavy 計算開始
    await new Promise(r => setTimeout(r, 30));
    try {
        const res = registerMrToPt(
            pt, mr,
            [0, 0, 0, 0, 0, 0],
            (info) => {
                store.setMrRegistrationProgress({
                    level: info.level, nLevels: info.nLevels,
                    iter: info.iter, mi: info.bestNegMI,
                });
            },
        );
        // 最適パラメータを MR に適用
        applyRigidToVolume(mr, snap, res.params);
        store.setMrRegistrationParams(res.params as [number, number, number, number, number, number]);
        console.log(`[mr-pt-reg] done in ${res.elapsedMs.toFixed(0)}ms, ${res.iterationsTotal} iters, MI=${(-res.finalNegMI).toFixed(4)}`);
        emit('redraw');
    } catch (err: any) {
        console.error('[mr-pt-reg] failed', err);
        alert('Registration failed: ' + (err?.message ?? err));
    } finally {
        store.setMrRegistrationInProgress(false);
    }
};

const onResetRegistration = () => {
    const mr = store.mrVolumeRef;
    const snap = store.mrRegistrationSnapshot as RegistrationSnapshot | null;
    if (mr && snap) applyRigidToVolume(mr, snap, [0, 0, 0, 0, 0, 0]);
    store.setMrRegistrationParams(null);
    store.setMrRegistrationProgress(null);
    emit('redraw');
};

const onComputeBodyMask = () => {
    const ok = store.computeCtBodyMask(-300);
    if (!ok) {
        alert('No CT volume loaded.');
        return;
    }
    emit('redraw');
};
const onToggleBodyMask = () => {
    store.toggleCtBodyMaskEnabled();
    emit('redraw');
};
const onClearBodyMask = () => {
    store.clearCtBodyMask();
    emit('redraw');
};

const onSave = () => {
    store.saveMaskAsNifti();
};

const loadFileInput = ref<HTMLInputElement | null>(null);

const onLoadMaskClick = () => {
    loadFileInput.value?.click();
};

const readFileAsArrayBuffer = (f: File): Promise<ArrayBuffer> =>
    new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onerror = () => reject(new Error(`Failed to read ${f.name}`));
        r.onload = () => resolve(r.result as ArrayBuffer);
        r.readAsArrayBuffer(f);
    });

const readFileAsText = (f: File): Promise<string> =>
    new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onerror = () => reject(new Error(`Failed to read ${f.name}`));
        r.onload = () => resolve(r.result as string);
        r.readAsText(f);
    });

const onLoadMaskFiles = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length === 0) return;

    if (!store.hasPet) {
        alert('Load a PET volume first, then load the mask.');
        return;
    }

    const niiFile = files.find(f => /\.nii(\.gz)?$/i.test(f.name));
    const jsonFile = files.find(f => /\.json$/i.test(f.name));

    if (!niiFile) {
        alert('Please select a .nii or .nii.gz mask file.');
        return;
    }

    try {
        const buf = await readFileAsArrayBuffer(niiFile);
        const parsed = readNiftiMask(buf);

        let sidecar:
            | { threshold?: number; thresholdUnit?: 'SUV' | 'CNTS'; labels?: any[]; petMetadata?: { seriesUID?: string; seriesDescription?: string } }
            | null = null;
        if (jsonFile) {
            try {
                const text = await readFileAsText(jsonFile);
                sidecar = JSON.parse(text);
            } catch {
                alert(`Could not parse sidecar JSON ${jsonFile.name}. Mask will still be loaded.`);
            }
        }

        // ★4: sidecar に PT seriesUID があり、現在 PT の seriesUID と異なる場合は警告。
        const sidecarUid = sidecar?.petMetadata?.seriesUID;
        const currentUid = store.petVolumeRef?.metadata?.seriesUID;
        if (sidecarUid && currentUid && sidecarUid !== currentUid) {
            const sidecarDesc = sidecar?.petMetadata?.seriesDescription ?? sidecarUid;
            const currentDesc = store.petVolumeRef?.metadata?.seriesDescription ?? currentUid;
            const ok = window.confirm(
                `This mask was created for PT series:\n  ${sidecarDesc}\n\n` +
                `but the currently active PT is:\n  ${currentDesc}\n\n` +
                `The geometry (dims/voxel size) may match by coincidence, but the mask may not align anatomically. Load anyway?`
            );
            if (!ok) return;
        }

        const res = store.loadMaskFromNifti(parsed.mask, parsed.dims, sidecar);
        if (!res.ok) {
            alert(res.reason);
            return;
        }
        emit('redraw');
    } catch (err: any) {
        alert(`Failed to load mask: ${err?.message ?? err}`);
    }
};

// ===== Lesion table =====
// finalMask の 26-CC を 1 病変として SUVmax / SUVmean / MTV / TLG / centroid を集計。
// maskVersion に依存して reactive 更新。3M voxel ≒ 30 ms 想定なので click→Apply 直後でも許容範囲。
interface LesionRow extends LesionStat {
    colorCss: string;
}

const lesionRows = computed<LesionRow[]>(() => {
    void store.maskVersion;
    const pet = store.petVolumeRef;
    const mask = store.finalMask;
    if (!pet || !mask) return [];
    const stats = summarizeLesions(pet, mask, store.labels);
    const colorById = new Map<number, [number, number, number]>();
    for (const l of store.labels) colorById.set(l.id, l.color);
    return stats.map(s => {
        const c = colorById.get(s.labelId) ?? [180, 180, 180];
        return { ...s, colorCss: `rgb(${c[0]},${c[1]},${c[2]})` };
    });
});

const onJumpToLesion = (l: LesionRow) => {
    const p = new THREE.Vector3(l.centroidWorld[0], l.centroidWorld[1], l.centroidWorld[2]);
    store.setCrosshairWorld(p);
    emit('redraw');
};

const onExportLesionCsv = () => {
    const rows = lesionRows.value;
    if (rows.length === 0) return;
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const headers = [
        '#', 'Label', 'SUVmax', 'SUVmean', 'MTV_cc', 'TLG',
        'VoxelCount', 'Centroid_x_mm', 'Centroid_y_mm', 'Centroid_z_mm',
    ];
    const lines = [headers.join(',')];
    rows.forEach((l, i) => {
        lines.push([
            String(i + 1),
            esc(l.labelName),
            l.suvMax.toFixed(4),
            l.suvMean.toFixed(4),
            l.mtvCc.toFixed(4),
            l.tlg.toFixed(4),
            String(l.voxelCount),
            l.centroidWorld[0].toFixed(2),
            l.centroidWorld[1].toFixed(2),
            l.centroidWorld[2].toFixed(2),
        ].join(','));
    });
    // BOM 付き UTF-8 で Excel が文字化けしないようにする
    const csv = '﻿' + lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const sid = store.petVolumeRef?.metadata?.seriesUID
        ? store.petVolumeRef.metadata.seriesUID.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 32)
        : 'lesions';
    triggerDownload(blob, `${sid}_lesions_${ts}.csv`);
};

// TLG / MTV は値の幅が大きいので桁数に応じて表示を切替
const fmtTlg = (v: number): string => {
    if (!Number.isFinite(v)) return '';
    if (v >= 10000) return (v / 1000).toFixed(1) + 'k';
    if (v >= 1000) return (v / 1000).toFixed(2) + 'k';
    if (v >= 100) return v.toFixed(0);
    return v.toFixed(1);
};
const fmtMtv = (v: number): string => {
    if (!Number.isFinite(v)) return '';
    if (v >= 100) return v.toFixed(0);
    if (v >= 10) return v.toFixed(1);
    return v.toFixed(2);
};

// 全病変の合計 (footer 表示用)
const lesionTotals = computed(() => {
    const rows = lesionRows.value;
    if (rows.length === 0) return null;
    let totalMtv = 0, totalTlg = 0, totalVox = 0, maxSuv = 0;
    for (const r of rows) {
        totalMtv += r.mtvCc;
        totalTlg += r.tlg;
        totalVox += r.voxelCount;
        if (r.suvMax > maxSuv) maxSuv = r.suvMax;
    }
    return { count: rows.length, totalMtv, totalTlg, totalVox, maxSuv };
});

// SUV 警告: PET volume の metadata に suvOk=false が立っているとき、
// 失敗理由を Inspector の上部に黄色バナーで通知する。
// suvFactor=1 (= raw 値表示) で fall-through していることを user に明示することが目的。
const suvWarning = computed<{ reason: string; source: string } | null>(() => {
    const md = store.petVolumeRef?.metadata;
    if (!md) return null;
    if (md.suvOk === false && md.suvReason) {
        return { reason: md.suvReason, source: md.suvSource ?? 'none' };
    }
    return null;
});

// SUV 採用パスを Inspector に表示するための短い説明文 (ok のときのみ)
const suvOkLabel = computed<string | null>(() => {
    const md = store.petVolumeRef?.metadata;
    if (!md || md.suvOk !== true) return null;
    switch (md.suvSource) {
        case 'BQML': return 'SUVbw (DICOM BQML)';
        case 'DecayFactor': return 'SUVbw (DecayFactor fallback)';
        case 'Philips': return 'SUVbw (Philips factor fallback)';
        case 'CNTS_Philips': return 'SUVbw (Philips CNTS factor)';
        case 'units_already_SUV': return 'pre-computed SUV';
        default: return null;
    }
});

// SUV メタデータの妥当性警告 (重み・線量・撮像時間など)
const suvSanityWarnings = computed(() => getSuvSanityWarnings(store.petVolumeRef));
const suvSanityHasError = computed(() => suvSanityWarnings.value.some(w => w.severity === 'error'));
const suvSanityHasWarn = computed(() => suvSanityWarnings.value.some(w => w.severity === 'warn'));

// "Details" 展開トグル (主要メタ値の表示)
const showSuvDetails = ref(false);
const suvMetaSummary = computed(() => getSuvMetadataSummary(store.petVolumeRef));
const fmtN = (v: number | null, dp: number = 1, suffix = ''): string => {
    if (v == null || !Number.isFinite(v)) return '—';
    return v.toFixed(dp) + suffix;
};
const fmtIso = (s: string | null): string => {
    if (!s) return '—';
    // YYYY-MM-DDTHH:MM:SS.sssZ → YYYY-MM-DD HH:MM:SS
    return s.replace('T', ' ').replace(/\.\d+Z?$/, '');
};

const polygonModeProxy = computed({
    get: () => store.polygon?.mode ?? store.defaultPolygonMode,
    set: (m: 'add' | 'erase') => {
        store.defaultPolygonMode = m;
        if (store.polygon) store.polygon.mode = m;
    },
});
</script>

<template>
    <div class="mv-seg-panel">
        <div v-if="!petAvailable" class="mv-empty">
            <v-icon icon="mdi-information-outline" size="small" class="mr-1" />
            Load a PET volume and switch to MPR / Fusion view
        </div>

        <template v-else>
            <!-- Linked PT info: ★4 -->
            <div v-if="store.petVolumeRef" class="mv-linked-pt">
                <v-icon icon="mdi-link-variant" size="x-small" class="mr-1" />
                <span class="mv-linked-pt-label">Linked PT:</span>
                <span class="mv-linked-pt-name" :title="store.petVolumeRef.metadata?.seriesUID ?? ''">
                    {{ store.petVolumeRef.metadata?.seriesDescription ?? '(no description)' }}
                </span>
            </div>

            <!-- SUV calc status -->
            <div v-if="suvWarning" class="mv-suv-warning" :title="`source: ${suvWarning.source}`">
                <v-icon icon="mdi-alert" size="x-small" class="mr-1" />
                <div class="mv-suv-warning-text">
                    <strong>SUV not computed.</strong>
                    Voxel values are displayed as-is.
                    <span class="mv-suv-reason">Reason: {{ suvWarning.reason }}</span>
                </div>
            </div>
            <div v-else-if="suvOkLabel" class="mv-suv-ok" :title="`source: ${store.petVolumeRef?.metadata?.suvSource}`">
                <v-icon icon="mdi-check-circle-outline" size="x-small" class="mr-1" />
                {{ suvOkLabel }}
            </div>

            <!-- SUV metadata sanity warnings -->
            <div
                v-if="suvSanityWarnings.length > 0"
                :class="[
                    'mv-suv-sanity',
                    suvSanityHasError ? 'is-error' : (suvSanityHasWarn ? 'is-warn' : 'is-info'),
                ]"
            >
                <div class="mv-suv-sanity-head" @click="showSuvDetails = !showSuvDetails">
                    <v-icon
                        :icon="suvSanityHasError ? 'mdi-alert-circle' : (suvSanityHasWarn ? 'mdi-alert' : 'mdi-information-outline')"
                        size="x-small"
                        class="mr-1"
                    />
                    <span class="mv-suv-sanity-title">
                        {{ suvSanityHasError
                            ? `${suvSanityWarnings.filter(w => w.severity === 'error').length} error(s)`
                            : suvSanityHasWarn
                                ? `${suvSanityWarnings.filter(w => w.severity === 'warn').length} warning(s)`
                                : `${suvSanityWarnings.length} note(s)` }}
                        in PET metadata
                    </span>
                    <v-icon
                        :icon="showSuvDetails ? 'mdi-chevron-up' : 'mdi-chevron-down'"
                        size="x-small"
                    />
                </div>
                <ul v-if="showSuvDetails" class="mv-suv-sanity-list">
                    <li
                        v-for="(w, i) in suvSanityWarnings"
                        :key="i"
                        :class="['mv-suv-sanity-item', `is-${w.severity}`]"
                    >
                        <span class="mv-suv-sanity-field">{{ w.field }}</span>
                        <span class="mv-suv-sanity-msg">{{ w.message }}</span>
                    </li>
                </ul>
            </div>

            <!-- SUV metadata details (always available, expanded with sanity panel) -->
            <div v-if="store.petVolumeRef?.metadata?.modality === 'PT' && showSuvDetails" class="mv-suv-details">
                <div class="mv-suv-details-row">
                    <span>BW</span>
                    <span class="mv-mono">{{ fmtN(suvMetaSummary.patientWeightKg, 1, ' kg') }}</span>
                </div>
                <div class="mv-suv-details-row">
                    <span>Dose</span>
                    <span class="mv-mono">{{ fmtN(suvMetaSummary.doseMBq, 0, ' MBq') }}</span>
                </div>
                <div class="mv-suv-details-row">
                    <span>Half-life</span>
                    <span class="mv-mono">{{ fmtN(suvMetaSummary.halfLifeMin, 1, ' min') }}</span>
                </div>
                <div class="mv-suv-details-row">
                    <span>Uptake</span>
                    <span class="mv-mono">{{ fmtN(suvMetaSummary.uptakeMin, 0, ' min') }}</span>
                </div>
                <div class="mv-suv-details-row">
                    <span>Inj. time</span>
                    <span class="mv-mono">{{ fmtIso(suvMetaSummary.injectionDateTime) }}</span>
                </div>
                <div class="mv-suv-details-row">
                    <span>Acq. time</span>
                    <span class="mv-mono">{{ fmtIso(suvMetaSummary.acquisitionDateTime) }}</span>
                </div>
                <div class="mv-suv-details-row">
                    <span>Decay corr.</span>
                    <span class="mv-mono">{{ suvMetaSummary.decayCorrection ?? '—' }}</span>
                </div>
                <div class="mv-suv-details-row">
                    <span>Units</span>
                    <span class="mv-mono">{{ suvMetaSummary.units ?? '—' }}</span>
                </div>
                <div class="mv-suv-details-row">
                    <span>SUV factor</span>
                    <span class="mv-mono">{{ fmtN(suvMetaSummary.suvFactor, 6) }}</span>
                </div>
            </div>

            <!-- Auto-save status -->
            <div v-if="store.lastAutoSavedAt" class="mv-autosave-line">
                <v-icon icon="mdi-cloud-check-outline" size="x-small" class="mr-1" />
                Auto-saved {{ autoSavedRel }}
            </div>

            <!-- MR-PET registration (auto, MI-based) — MR + PT 両方ロード時のみ -->
            <section v-if="store.mrVolumeRef && store.petVolumeRef" class="mv-section">
                <div class="mv-section-title">
                    <v-icon icon="mdi-vector-link" size="x-small" />
                    MR-PET Registration
                </div>
                <div class="mv-btn-row">
                    <v-btn
                        size="small"
                        variant="tonal"
                        color="primary"
                        :loading="store.mrRegistrationInProgress"
                        :disabled="store.mrRegistrationInProgress"
                        @click="onRegisterMrPt"
                    >
                        <v-icon icon="mdi-cog-sync" size="small" class="mr-1" />
                        Auto Register
                    </v-btn>
                    <v-btn
                        v-if="store.mrRegistrationParams"
                        size="small"
                        variant="text"
                        :disabled="store.mrRegistrationInProgress"
                        @click="onResetRegistration"
                    >Reset</v-btn>
                </div>
                <div v-if="store.mrRegistrationProgress" class="mv-reg-status">
                    Level {{ store.mrRegistrationProgress.level + 1 }}/{{ store.mrRegistrationProgress.nLevels }}
                    · iter {{ store.mrRegistrationProgress.iter }}
                    · MI = {{ (-store.mrRegistrationProgress.mi).toFixed(4) }}
                </div>
                <div v-if="store.mrRegistrationParams && !store.mrRegistrationInProgress" class="mv-reg-status mv-reg-params">
                    T = ({{ formatMm(store.mrRegistrationParams[0]) }},
                          {{ formatMm(store.mrRegistrationParams[1]) }},
                          {{ formatMm(store.mrRegistrationParams[2]) }}) mm
                    R = ({{ formatDeg(store.mrRegistrationParams[3]) }},
                          {{ formatDeg(store.mrRegistrationParams[4]) }},
                          {{ formatDeg(store.mrRegistrationParams[5]) }})°
                </div>
            </section>

            <!-- CT processing (寝台除去) — CT があるときだけ表示 -->
            <section v-if="store.ctVolumeRef" class="mv-section">
                <div class="mv-section-title">
                    <v-icon icon="mdi-bed-empty" size="x-small" />
                    CT processing
                </div>
                <div class="mv-btn-row">
                    <v-btn
                        v-if="!store.ctBodyMask"
                        size="small"
                        variant="tonal"
                        color="primary"
                        @click="onComputeBodyMask"
                    >
                        <v-icon icon="mdi-account" size="small" class="mr-1" />Remove CT bed
                    </v-btn>
                    <template v-else>
                        <v-btn
                            size="small"
                            variant="flat"
                            :color="store.ctBodyMaskEnabled ? 'primary' : undefined"
                            @click="onToggleBodyMask"
                        >
                            <v-icon
                                :icon="store.ctBodyMaskEnabled ? 'mdi-eye' : 'mdi-eye-off'"
                                size="small"
                                class="mr-1"
                            />
                            Bed removed: {{ store.ctBodyMaskEnabled ? 'ON' : 'OFF' }}
                        </v-btn>
                        <v-btn size="small" variant="text" @click="onClearBodyMask">
                            Reset
                        </v-btn>
                    </template>
                </div>
            </section>

            <!-- Threshold -->
            <section class="mv-section">
                <div class="mv-section-title">
                    <v-icon icon="mdi-tune-variant" size="x-small" />
                    Threshold ({{ store.thresholdUnit }})
                </div>
                <v-select
                    :model-value="thresholdSelection"
                    @update:model-value="onThresholdSelectionChange($event)"
                    :items="THRESHOLD_PRESETS"
                    density="compact"
                    hide-details
                    variant="outlined"
                />
                <v-text-field
                    v-if="thresholdSelection === 'manual'"
                    v-model.number="store.threshold"
                    type="number"
                    step="0.1"
                    density="compact"
                    hide-details
                    variant="outlined"
                    label="SUV value"
                    class="mt-1"
                />
                <div class="mv-btn-row mt-2">
                    <v-btn size="small" color="primary" variant="flat" @click="onApplyThreshold">
                        <v-icon icon="mdi-play" size="small" class="mr-1" />Apply
                    </v-btn>
                    <v-btn size="small" variant="outlined" @click="onClearThreshold">Clear</v-btn>
                </div>
            </section>

            <!-- Overlay -->
            <section class="mv-section">
                <div class="mv-section-title">
                    <v-icon icon="mdi-layers-outline" size="x-small" />
                    Overlay
                </div>
                <v-switch
                    :model-value="store.overlayEnabled"
                    @update:model-value="onToggleOverlay($event as boolean)"
                    label="Show mask"
                    density="compact"
                    hide-details
                    color="primary"
                />
                <div class="mv-row-label mt-1">
                    <span>Opacity</span>
                    <span class="mv-mono">{{ (store.overlayAlpha * 100).toFixed(0) }}%</span>
                </div>
                <v-slider
                    :model-value="store.overlayAlpha"
                    :min="0.05" :max="1" :step="0.05"
                    density="compact"
                    hide-details
                    color="primary"
                    track-color="surface-light"
                    @update:model-value="onAlphaChange($event as number)"
                />
            </section>

            <!-- Sphere ROI -->
            <section class="mv-section">
                <div class="mv-section-title">
                    <v-icon icon="mdi-circle-outline" size="x-small" />
                    Sphere ROI
                </div>
                <div v-if="store.sphere" class="mv-stats">
                    <div class="mv-stat-row">
                        <span class="mv-stat-label">radius</span>
                        <span class="mv-mono">{{ store.sphere.radiusMm.toFixed(1) }} mm</span>
                    </div>
                    <div class="mv-stat-row">
                        <span class="mv-stat-label">SUVmax</span>
                        <span class="mv-mono mv-accent">{{ store.sphere.suvMax.toFixed(2) }}</span>
                    </div>
                    <div class="mv-stat-row">
                        <span class="mv-stat-label">SUVmean</span>
                        <span class="mv-mono">
                            {{ store.sphere.suvMean.toFixed(2) }}
                            <span class="mv-stat-dim">± {{ store.sphere.suvStd.toFixed(2) }}</span>
                        </span>
                    </div>
                    <div class="mv-stat-row">
                        <span class="mv-stat-label">voxels</span>
                        <span class="mv-mono">{{ store.sphere.voxelCount }}</span>
                    </div>
                    <v-btn size="x-small" variant="text" class="mt-1" @click="store.clearSphere(); emit('redraw')">
                        <v-icon icon="mdi-close" size="x-small" class="mr-1" />Clear
                    </v-btn>
                </div>
                <div v-else class="mv-hint">
                    Click on the PET image with the Sphere ROI tool<br>
                    Wheel inside the sphere to change radius
                </div>
            </section>

            <!-- Polygon ROI -->
            <section class="mv-section">
                <div class="mv-section-title">
                    <v-icon icon="mdi-vector-polygon" size="x-small" />
                    Polygon ROI
                </div>
                <v-btn-toggle
                    v-model="polygonModeProxy"
                    density="compact"
                    mandatory
                    color="primary"
                    variant="outlined"
                    divided
                >
                    <v-btn value="add" size="small">
                        <v-icon icon="mdi-plus" size="small" class="mr-1" />Add
                    </v-btn>
                    <v-btn value="erase" size="small">
                        <v-icon icon="mdi-minus" size="small" class="mr-1" />Erase
                    </v-btn>
                </v-btn-toggle>
                <div class="mv-hint mt-1">
                    Left click = vertex / Right click or double click = finish<br>
                    Esc = cancel / Ctrl+Z = undo
                </div>
            </section>

            <!-- Labels -->
            <section class="mv-section">
                <div class="mv-section-title">
                    <v-icon icon="mdi-tag-multiple-outline" size="x-small" />
                    Labels
                </div>
                <div class="mv-label-list">
                    <div
                        v-for="row in labelRows"
                        :key="row.id"
                        class="mv-label-item"
                        :class="{ 'is-active': row.id === store.currentLabelId }"
                        @click="onSelectLabel(row.id)"
                    >
                        <span class="mv-color-swatch" :style="{ background: row.colorCss }" />
                        <span class="mv-label-name">{{ row.name }}</span>
                        <span class="mv-mono mv-label-vol">{{ row.volume_mm3.toFixed(0) }} mm³</span>
                        <v-btn
                            icon="mdi-close"
                            size="x-small"
                            variant="text"
                            density="compact"
                            class="ml-1"
                            @click.stop="onRemoveLabel(row.id)"
                        />
                    </div>
                </div>
                <div class="mv-add-label mt-2">
                    <v-text-field
                        v-model="newLabelName"
                        placeholder="Label name"
                        density="compact"
                        hide-details
                        variant="outlined"
                        @keyup.enter="onAddLabel"
                    />
                    <v-btn size="small" variant="tonal" @click="onAddLabel">
                        <v-icon icon="mdi-plus" size="small" />
                    </v-btn>
                </div>
            </section>

            <!-- Histogram (per label) -->
            <section class="mv-section">
                <div class="mv-section-title">
                    <v-icon icon="mdi-chart-bar" size="x-small" />
                    Histogram — PET ({{ store.thresholdUnit }})
                    <span v-if="currentLabel" class="mv-hist-label-name" :style="{ color: currentLabelColorCss }">
                        {{ currentLabel.name }}
                    </span>
                </div>

                <template v-if="labelHistogram && labelHistogram.count > 0">
                    <svg
                        class="mv-hist-svg"
                        :viewBox="`0 0 ${HIST_VB_W} ${HIST_VB_H}`"
                        preserveAspectRatio="none"
                    >
                        <!-- baseline -->
                        <line :x1="0" :y1="HIST_VB_H" :x2="HIST_VB_W" :y2="HIST_VB_H"
                              stroke="var(--mv-border)" stroke-width="0.5" />
                        <!-- mean line -->
                        <line v-if="labelHistogram.binWidth > 0"
                              :x1="((labelHistogram.mean - labelHistogram.lo) / (labelHistogram.hi - labelHistogram.lo)) * HIST_VB_W"
                              :y1="0"
                              :x2="((labelHistogram.mean - labelHistogram.lo) / (labelHistogram.hi - labelHistogram.lo)) * HIST_VB_W"
                              :y2="HIST_VB_H"
                              stroke="var(--mv-text-muted)" stroke-width="0.6" stroke-dasharray="2 2" />
                        <!-- bars -->
                        <rect
                            v-for="(c, i) in labelHistogram.counts"
                            :key="i"
                            :x="i * (HIST_VB_W / labelHistogram.counts.length) + 0.5"
                            :y="HIST_VB_H - (c / labelHistogram.peak) * HIST_VB_H"
                            :width="(HIST_VB_W / labelHistogram.counts.length) - 1"
                            :height="(c / labelHistogram.peak) * HIST_VB_H"
                            :fill="currentLabelColorCss"
                        />
                    </svg>
                    <div class="mv-hist-axis">
                        <span class="mv-mono">{{ labelHistogram.lo.toFixed(1) }}</span>
                        <span class="mv-mono">{{ labelHistogram.hi.toFixed(1) }}</span>
                    </div>
                    <div class="mv-stats mt-1">
                        <div class="mv-stat-row">
                            <span class="mv-stat-label">min / max</span>
                            <span class="mv-mono">{{ labelHistogram.min.toFixed(2) }} / {{ labelHistogram.max.toFixed(2) }}</span>
                        </div>
                        <div class="mv-stat-row">
                            <span class="mv-stat-label">mean</span>
                            <span class="mv-mono">
                                {{ labelHistogram.mean.toFixed(2) }}
                                <span class="mv-stat-dim">± {{ labelHistogram.std.toFixed(2) }}</span>
                            </span>
                        </div>
                        <div class="mv-stat-row">
                            <span class="mv-stat-label">voxels</span>
                            <span class="mv-mono">{{ labelHistogram.count }}</span>
                        </div>
                    </div>
                </template>
                <div v-else class="mv-hint">
                    No voxels assigned to the current label yet
                </div>
            </section>

            <!-- Islands -->
            <section class="mv-section">
                <div class="mv-section-title">
                    <v-icon icon="mdi-island" size="x-small" />
                    Islands
                </div>
                <div v-if="store.componentMapValid" class="mv-hint">
                    <span class="mv-accent">{{ store.componentCount }}</span> components detected —
                    click an island with the Assign Label tool
                </div>
                <div v-else-if="store.finalMask" class="mv-warn-text">
                    <v-icon icon="mdi-refresh" size="x-small" class="mr-1" />
                    Mask updated — re-run Find islands
                </div>
                <v-btn
                    size="small"
                    variant="tonal"
                    color="primary"
                    class="mt-1"
                    :disabled="!store.finalMask"
                    @click="onFindIslands"
                >
                    <v-icon icon="mdi-magnify" size="small" class="mr-1" />
                    {{ store.componentMapValid ? 'Re-find' : 'Find islands' }}
                </v-btn>
            </section>

            <!-- Lesion table -->
            <section v-if="store.finalMask" class="mv-section">
                <div class="mv-section-title mv-section-title-row">
                    <span>
                        <v-icon icon="mdi-format-list-bulleted-square" size="x-small" />
                        Lesions
                        <span v-if="lesionTotals" class="mv-lesion-count">{{ lesionTotals.count }}</span>
                    </span>
                    <v-btn
                        size="x-small"
                        variant="text"
                        :disabled="!lesionTotals"
                        density="compact"
                        @click="onExportLesionCsv"
                    >
                        <v-icon icon="mdi-download" size="x-small" class="mr-1" />CSV
                    </v-btn>
                </div>

                <div v-if="!lesionTotals" class="mv-hint">
                    No lesions yet — Apply threshold or paint a polygon
                </div>
                <template v-else>
                    <div class="mv-lesion-table-wrap">
                        <table class="mv-lesion-table">
                            <thead>
                                <tr>
                                    <th>#</th>
                                    <th>Label</th>
                                    <th class="num">SUVmax</th>
                                    <th class="num">SUVmean</th>
                                    <th class="num">MTV<br><span class="mv-th-unit">cc</span></th>
                                    <th class="num">TLG</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr
                                    v-for="(l, i) in lesionRows"
                                    :key="l.componentId"
                                    @click="onJumpToLesion(l)"
                                    title="Click to jump crosshair"
                                >
                                    <td class="mv-mono">{{ i + 1 }}</td>
                                    <td>
                                        <span class="mv-color-swatch" :style="{ background: l.colorCss }" />
                                        <span class="mv-lesion-label-name">{{ l.labelName }}</span>
                                    </td>
                                    <td class="num mv-mono mv-accent">{{ l.suvMax.toFixed(2) }}</td>
                                    <td class="num mv-mono">{{ l.suvMean.toFixed(2) }}</td>
                                    <td class="num mv-mono">{{ fmtMtv(l.mtvCc) }}</td>
                                    <td class="num mv-mono">{{ fmtTlg(l.tlg) }}</td>
                                </tr>
                            </tbody>
                            <tfoot>
                                <tr>
                                    <td colspan="2" class="mv-tfoot-label">Total</td>
                                    <td class="num mv-mono mv-accent">{{ lesionTotals.maxSuv.toFixed(2) }}</td>
                                    <td class="num mv-mono">—</td>
                                    <td class="num mv-mono">{{ fmtMtv(lesionTotals.totalMtv) }}</td>
                                    <td class="num mv-mono">{{ fmtTlg(lesionTotals.totalTlg) }}</td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </template>
            </section>

            <!-- Save / Load / Clean -->
            <section class="mv-section">
                <div class="mv-btn-row">
                    <v-btn size="small" color="primary" variant="flat" @click="onSave">
                        <v-icon icon="mdi-content-save" size="small" class="mr-1" />Save NIfTI
                    </v-btn>
                    <v-btn size="small" variant="tonal" @click="onLoadMaskClick">
                        <v-icon icon="mdi-folder-open" size="small" class="mr-1" />Load Mask
                    </v-btn>
                    <v-btn size="small" variant="outlined" @click="onClearManual">Clear edits</v-btn>
                </div>
                <input
                    ref="loadFileInput"
                    type="file"
                    accept=".nii,.nii.gz,.json,application/octet-stream,application/json"
                    multiple
                    style="display: none"
                    @change="onLoadMaskFiles"
                />
            </section>
        </template>
    </div>
</template>

<style scoped>
.mv-seg-panel {
    color: var(--mv-text);
}

.mv-empty {
    padding: 16px 12px;
    color: var(--mv-text-dim);
    font-size: 12px;
    line-height: 1.5;
    border-bottom: 1px solid var(--mv-border);
}

/* MR-PET registration progress / params */
.mv-reg-status {
    margin-top: 6px;
    font-size: 11px;
    color: var(--mv-text-dim);
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    font-feature-settings: 'tnum';
    line-height: 1.4;
}
.mv-reg-params {
    color: var(--mv-accent);
}

/* SUV calc status (warning + ok) */
.mv-suv-warning {
    display: flex;
    align-items: flex-start;
    gap: 4px;
    padding: 6px 12px;
    background: rgba(255, 175, 60, 0.10);
    border-bottom: 1px solid var(--mv-border);
    color: var(--mv-warning, #FFB454);
    font-size: 11px;
    line-height: 1.4;
}
.mv-suv-warning .v-icon {
    margin-top: 1px;
}
.mv-suv-warning-text {
    flex: 1;
    color: var(--mv-text);
}
.mv-suv-warning-text strong {
    color: var(--mv-warning, #FFB454);
    font-weight: 600;
}
.mv-suv-reason {
    display: block;
    color: var(--mv-text-muted);
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    font-size: 10px;
    margin-top: 2px;
}
.mv-suv-ok {
    display: flex;
    align-items: center;
    padding: 4px 12px;
    font-size: 11px;
    color: var(--mv-text-muted);
    border-bottom: 1px solid var(--mv-border);
}

/* Sanity warnings (collapsible) */
.mv-suv-sanity {
    border-bottom: 1px solid var(--mv-border);
    font-size: 11px;
}
.mv-suv-sanity.is-error { background: rgba(255, 92, 122, 0.10); }
.mv-suv-sanity.is-warn  { background: rgba(255, 175, 60, 0.10); }
.mv-suv-sanity.is-info  { background: rgba(95, 158, 235, 0.08); }

.mv-suv-sanity-head {
    display: flex;
    align-items: center;
    padding: 6px 12px;
    cursor: pointer;
    user-select: none;
}
.mv-suv-sanity.is-error .mv-suv-sanity-head { color: var(--mv-error, #FF5C7A); }
.mv-suv-sanity.is-warn  .mv-suv-sanity-head { color: var(--mv-warning, #FFB454); }
.mv-suv-sanity.is-info  .mv-suv-sanity-head { color: var(--mv-text-dim); }
.mv-suv-sanity-head:hover { filter: brightness(1.15); }
.mv-suv-sanity-title {
    flex: 1;
    font-weight: 500;
}
.mv-suv-sanity-list {
    list-style: none;
    padding: 0 12px 8px 28px;
    margin: 0;
}
.mv-suv-sanity-item {
    display: flex;
    gap: 6px;
    padding: 3px 0;
    line-height: 1.4;
}
.mv-suv-sanity-item.is-error { color: var(--mv-error, #FF5C7A); }
.mv-suv-sanity-item.is-warn  { color: var(--mv-warning, #FFB454); }
.mv-suv-sanity-item.is-info  { color: var(--mv-text-dim); }
.mv-suv-sanity-field {
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    font-size: 10px;
    flex-shrink: 0;
    opacity: 0.85;
    min-width: 78px;
}
.mv-suv-sanity-msg {
    flex: 1;
    color: var(--mv-text);
}

/* SUV metadata details panel */
.mv-suv-details {
    padding: 6px 12px;
    border-bottom: 1px solid var(--mv-border);
    font-size: 11px;
    color: var(--mv-text-dim);
    background: var(--mv-surface-2);
}
.mv-suv-details-row {
    display: flex;
    justify-content: space-between;
    padding: 1px 0;
}
.mv-suv-details-row .mv-mono {
    color: var(--mv-text);
    font-size: 10px;
}

/* Auto-save status row (just under Linked PT) */
.mv-autosave-line {
    display: flex;
    align-items: center;
    padding: 4px 12px;
    font-size: 11px;
    color: var(--mv-text-muted);
    border-bottom: 1px solid var(--mv-border);
    font-feature-settings: 'tnum';
}

/* ★4: Linked PT 表示 */
.mv-linked-pt {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 12px;
    background: rgba(0, 212, 170, 0.06);
    border-bottom: 1px solid var(--mv-border);
    font-size: 11px;
    color: var(--mv-text-dim);
}
.mv-linked-pt-label {
    color: var(--mv-text-muted);
}
.mv-linked-pt-name {
    color: var(--mv-accent);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1 1 auto;
    min-width: 0;
}

.mv-section {
    padding: 12px;
    border-bottom: 1px solid var(--mv-border);
}

.mv-section-title {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--mv-text-dim);
    margin-bottom: 8px;
}

.mv-row-label {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: var(--mv-text-dim);
}

.mv-stats {
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.mv-stat-row {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
}
.mv-stat-label {
    color: var(--mv-text-dim);
}
.mv-stat-dim {
    color: var(--mv-text-muted);
    margin-left: 4px;
}
.mv-mono {
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    font-size: 11px;
    color: var(--mv-text);
}
.mv-accent {
    color: var(--mv-accent) !important;
    font-weight: 600;
}

.mv-hint {
    font-size: 11px;
    color: var(--mv-text-muted);
    line-height: 1.5;
}

.mv-warn-text {
    font-size: 11px;
    color: var(--mv-warning);
    display: flex;
    align-items: center;
    line-height: 1.5;
}

.mv-btn-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}
.mv-btn-row .v-btn {
    text-transform: none;
    letter-spacing: 0;
}

.mv-label-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.mv-label-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    border-radius: 4px;
    cursor: pointer;
    border: 1px solid transparent;
    transition: background 0.1s, border-color 0.1s;
}
.mv-label-item:hover {
    background: var(--mv-surface-2);
}
.mv-label-item.is-active {
    background: rgba(0, 212, 170, 0.10);
    border-color: var(--mv-accent-dim);
}
.mv-color-swatch {
    width: 12px;
    height: 12px;
    border-radius: 2px;
    flex-shrink: 0;
}
.mv-label-name {
    flex: 1;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.mv-label-vol {
    color: var(--mv-text-dim);
}

.mv-add-label {
    display: flex;
    gap: 4px;
    align-items: stretch;
}
.mv-add-label .v-text-field {
    flex: 1;
}

.mv-hist-svg {
    width: 100%;
    height: 60px;
    background: var(--mv-bg);
    border: 1px solid var(--mv-border);
    border-radius: 3px;
    display: block;
}
.mv-hist-axis {
    display: flex;
    justify-content: space-between;
    margin-top: 2px;
    font-size: 10px;
    color: var(--mv-text-muted);
}
.mv-hist-label-name {
    font-weight: 600;
    text-transform: none;
    letter-spacing: 0;
    margin-left: 6px;
    font-size: 11px;
}

/* Lesion table */
.mv-section-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
}
.mv-lesion-count {
    display: inline-block;
    margin-left: 6px;
    padding: 0 6px;
    background: var(--mv-accent-dim, rgba(0,212,170,0.2));
    color: var(--mv-accent);
    border-radius: 8px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: none;
}
.mv-lesion-table-wrap {
    max-height: 240px;
    overflow: auto;
    border: 1px solid var(--mv-border);
    border-radius: 3px;
}
table.mv-lesion-table {
    border-collapse: collapse;
    font-size: 11px;
    width: 100%;
    table-layout: fixed;
}
/* Column widths: #(22) Label(flex) SUVmax(46) SUVmean(50) MTV(46) TLG(56) */
table.mv-lesion-table th:nth-child(1),
table.mv-lesion-table td:nth-child(1) { width: 22px; }
table.mv-lesion-table th:nth-child(3),
table.mv-lesion-table td:nth-child(3) { width: 46px; }
table.mv-lesion-table th:nth-child(4),
table.mv-lesion-table td:nth-child(4) { width: 50px; }
table.mv-lesion-table th:nth-child(5),
table.mv-lesion-table td:nth-child(5) { width: 46px; }
table.mv-lesion-table th:nth-child(6),
table.mv-lesion-table td:nth-child(6) { width: 56px; }
table.mv-lesion-table thead th {
    position: sticky;
    top: 0;
    background: var(--mv-surface-2);
    color: var(--mv-text-dim);
    text-align: left;
    font-weight: 600;
    padding: 4px 4px;
    border-bottom: 1px solid var(--mv-border);
    font-size: 10px;
    text-transform: none;
    letter-spacing: 0;
    line-height: 1.2;
    white-space: nowrap;
}
table.mv-lesion-table th.num,
table.mv-lesion-table td.num {
    text-align: right;
}
table.mv-lesion-table .mv-th-unit {
    color: var(--mv-text-muted);
    font-weight: 400;
    text-transform: none;
    font-size: 9px;
}
table.mv-lesion-table tbody tr {
    cursor: pointer;
    transition: background 0.1s;
}
table.mv-lesion-table tbody tr:hover {
    background: var(--mv-surface-2);
}
table.mv-lesion-table tbody tr:nth-child(even) {
    background: rgba(255,255,255,0.012);
}
table.mv-lesion-table tbody tr:nth-child(even):hover {
    background: var(--mv-surface-2);
}
table.mv-lesion-table td {
    padding: 3px 4px;
    border-bottom: 1px solid var(--mv-border);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
table.mv-lesion-table td.num,
table.mv-lesion-table th.num {
    font-feature-settings: 'tnum';
}
table.mv-lesion-table .mv-color-swatch {
    width: 8px;
    height: 8px;
    border-radius: 1px;
    display: inline-block;
    vertical-align: middle;
    margin-right: 4px;
}
table.mv-lesion-table .mv-lesion-label-name {
    color: var(--mv-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
table.mv-lesion-table tfoot td {
    background: var(--mv-surface-2);
    font-weight: 600;
    border-top: 1px solid var(--mv-border);
    border-bottom: none;
}
table.mv-lesion-table .mv-tfoot-label {
    color: var(--mv-text-dim);
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.04em;
}
</style>

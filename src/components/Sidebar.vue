<script setup lang="ts">
import { computed, ref } from 'vue';
import SeriesList from './SeriesList.vue';
import { useSegmentationStore } from '../stores/segmentation';

defineProps<{
  seriesSummaries?: Array<{
    index: number;
    description: string;
    modality: string;
    matrixSize: string;
    voxelSize: string;
    fileCount: number;
    hasVolume: boolean;
    thumbnail: string | null;
    seriesUID: string;
    transferSyntaxName: string;
    transferSyntaxSupported: boolean;
    transferSyntaxReason?: string;
    acquisitionTime?: string;
    studyDate?: string;
    studyUID?: string;
    attenuationCorrected?: boolean;
    isPrimary: boolean;
    isRgb: boolean;
  }>;
}>();

const emit = defineEmits([
  "fileLoaded",
  "dirLoaded",
  "leftButtonFunctionChanged",
  "openSample",
  "presetSelected",
  "changeSlice",
  "phantom1",
  "phantom2",
  "phantom3",
  "redraw",
  "setModality",
  "setActiveForSeg",
]);

// 最後にクリックした preset を track して active 表示。
// Reset または window tool で WC/WW を直接いじったら null に戻る (今は前者のみ実装)。
const activePreset = ref<string | null>(null);

const presetClicked = (e: string) => {
  if (e === 'Reset') activePreset.value = null;
  else activePreset.value = e;
  emit("presetSelected", e);
};
const onPresetToggle = (val: string | null | undefined) => {
  // v-btn-toggle で active が変わったとき: 同じ button をもう 1 度押すと null になる
  if (val == null) {
    activePreset.value = null;
    emit("presetSelected", "Reset");
  } else {
    presetClicked(val);
  }
};
const changeSlice = (e: number) => emit("changeSlice", e);

const showAdvanced = ref(false);
const showSummary = ref(false);
const showTag = ref(false);

// CT 用 (HU window)
const wPresets = [
  { id: 'Lung',  label: 'Lung'  },
  { id: 'Med',   label: 'Med'   },
  { id: 'Abd',   label: 'Abd'   },
  { id: 'Bone',  label: 'Bone'  },
  { id: 'Brain', label: 'Brain' },
  { id: 'Fat',   label: 'Fat'   },
];

// PET 用 (SUV window) -- WC = (lo+hi)/2, WW = hi-lo として DicomView 側で展開
const wPresetsPet = [
  { id: 'SUV-0-3',  label: '0-3'  },
  { id: 'SUV-0-6',  label: '0-6'  },
  { id: 'SUV-0-10', label: '0-10' },
  { id: 'SUV-0-15', label: '0-15' },
];

// PT 表示単位 (legend / 4-corner / 入力換算に影響。voxel と内部 WC/WW は SUV のまま)。
const segStore = useSegmentationStore();
const petUnit = computed<'SUV' | 'BqMl'>(() => segStore.petDisplayUnit);
const onPetUnitChange = (v: 'SUV' | 'BqMl' | null | undefined) => {
  if (v === 'SUV' || v === 'BqMl') {
    segStore.petDisplayUnit = v;
    emit('redraw');
  }
};
</script>

<template>
  <div class="mv-sidebar">

    <!-- Series -->
    <section class="mv-section">
      <div class="mv-section-title">
        <v-icon icon="mdi-folder-multiple-image" size="x-small" />
        Series
      </div>
      <SeriesList
        :series="seriesSummaries ?? []"
        @setModality="(p: { index: number; modality: 'PT' | 'CT' | 'MR' }) => emit('setModality', p)"
        @setActiveForSeg="(p: { index: number; modality: 'PT' | 'CT' }) => emit('setActiveForSeg', p)"
      />
    </section>

    <!-- Slice -->
    <section class="mv-section">
      <div class="mv-section-title">
        <v-icon icon="mdi-layers-triple" size="x-small" />
        Slice
      </div>
      <div class="mv-btn-row">
        <v-btn size="x-small" variant="tonal" @click="changeSlice(-100000)">
          <v-icon icon="mdi-arrow-collapse-left" size="small" />
        </v-btn>
        <v-btn size="x-small" variant="tonal" @click="changeSlice(-1)">
          <v-icon icon="mdi-arrow-left" size="small" />
        </v-btn>
        <v-btn size="x-small" variant="tonal" @click="changeSlice(1)">
          <v-icon icon="mdi-arrow-right" size="small" />
        </v-btn>
        <v-btn size="x-small" variant="tonal" @click="changeSlice(100000)">
          <v-icon icon="mdi-arrow-collapse-right" size="small" />
        </v-btn>
      </div>
    </section>

    <!-- Window preset -->
    <section class="mv-section">
      <div class="mv-section-title">
        <v-icon icon="mdi-contrast-circle" size="x-small" />
        Window preset (CT)
      </div>
      <v-btn-toggle
        :model-value="activePreset"
        @update:model-value="onPresetToggle"
        density="compact"
        variant="outlined"
        divided
        class="mv-preset-toggle"
      >
        <v-btn
          v-for="p in wPresets"
          :key="p.id"
          :value="p.id"
          size="x-small"
        >{{ p.label }}</v-btn>
      </v-btn-toggle>

      <div class="mv-section-title mt-3 mv-pt-header">
        <v-icon icon="mdi-radioactive" size="x-small" />
        <span>PT window</span>
        <v-btn-toggle
          :model-value="petUnit"
          @update:model-value="onPetUnitChange"
          density="compact"
          variant="outlined"
          divided
          mandatory
          class="mv-unit-toggle"
        >
          <v-btn value="SUV" size="x-small">SUV</v-btn>
          <v-btn value="BqMl" size="x-small">Bq/ml</v-btn>
        </v-btn-toggle>
      </div>
      <v-btn-toggle
        :model-value="activePreset"
        @update:model-value="onPresetToggle"
        density="compact"
        variant="outlined"
        divided
        class="mv-preset-toggle"
      >
        <v-btn
          v-for="p in wPresetsPet"
          :key="p.id"
          :value="p.id"
          size="x-small"
        >{{ p.label }}</v-btn>
      </v-btn-toggle>

      <div class="mv-btn-row mt-2">
        <v-btn size="x-small" variant="text" @click="presetClicked('Reset')">
          <v-icon icon="mdi-restart" size="x-small" class="mr-1" />Reset to DICOM tag
        </v-btn>
      </div>
    </section>

    <!-- Demo / Advanced -->
    <section class="mv-section">
      <div class="d-flex align-center">
        <v-btn
          size="x-small"
          variant="text"
          :prepend-icon="showAdvanced ? 'mdi-chevron-down' : 'mdi-chevron-right'"
          @click="showAdvanced = !showAdvanced"
        >
          Advanced
        </v-btn>
      </div>

      <div v-if="showAdvanced" class="mt-2">
        <div class="mv-section-title">Demo phantoms</div>
        <div class="mv-btn-row">
          <v-btn size="x-small" variant="tonal" @click="emit('phantom3')">Earth</v-btn>
          <v-btn size="x-small" variant="tonal" @click="emit('phantom1')">Humanoid</v-btn>
          <v-btn size="x-small" variant="tonal" @click="emit('phantom2')">Voronoi</v-btn>
        </div>
        <div class="mt-2">
          <v-switch label="Show summary" v-model="showSummary" hide-details density="compact" />
          <v-switch label="Show tag" v-model="showTag" hide-details density="compact" />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.mv-sidebar {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding-top: 4px;
}

/* Window preset segmented control: 横一杯に 6 等分、各 btn を細めに */
.mv-preset-toggle {
  width: 100%;
}

/* PT 単位トグル (SUV / Bq/ml) */
.mv-pt-header {
  display: flex;
  align-items: center;
  gap: 6px;
}
.mv-pt-header > span {
  flex: 0 0 auto;
}
.mv-unit-toggle {
  margin-left: auto;
  height: 18px;
}
.mv-unit-toggle :deep(.v-btn) {
  min-width: 0 !important;
  padding: 0 6px !important;
  font-size: 9px !important;
  height: 18px !important;
  text-transform: none;
  letter-spacing: 0;
}
.mv-unit-toggle :deep(.v-btn--active) {
  background: rgba(0, 212, 170, 0.16) !important;
  color: var(--mv-accent) !important;
  border-color: var(--mv-accent-dim) !important;
}
.mv-preset-toggle :deep(.v-btn) {
  flex: 1 1 0;
  min-width: 0 !important;
  padding: 0 4px !important;
  font-size: 11px !important;
  letter-spacing: 0;
  text-transform: none;
  height: 26px !important;
}
.mv-preset-toggle :deep(.v-btn--active) {
  background: rgba(0, 212, 170, 0.16) !important;
  color: var(--mv-accent) !important;
  border-color: var(--mv-accent-dim) !important;
}
</style>

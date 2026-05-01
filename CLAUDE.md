# CLAUDE.md

このファイルは Claude Code（および将来の自分自身）への引き継ぎノートです。
Vue 3 + Vuetify 3 + Vite + TypeScript ベースの DICOM viewer `metavol-web` の開発を進めるための要点をまとめます。

---

## UI 言語ポリシー（厳守）

**ユーザに見える文字列はすべて英語で書くこと。** 日本語 UI テキストは禁止。

対象（必ず英語）:
- `<template>` 内の表示テキスト、`v-tooltip` / `v-btn` / `v-text-field` の `label` / `placeholder` などの属性
- `prompt()` / `alert()` / `confirm()` などダイアログ引数
- canvas に描く文字（`ctx.fillText` など）
- エラーメッセージ、空状態のヒント、トースト等すべての UI 文字列

非対象（日本語可）:
- 開発者向けの `//`, `/* */`, `<!-- -->` コメント
- このファイル (CLAUDE.md)、README、コミットメッセージ等の開発者ドキュメント

新規に UI テキストを足すときは必ず英語で書く。既存箇所に日本語を見つけたら必ず英訳して直す。
レビュー時は `<template>` および `prompt|alert|confirm|fillText` を grep して日本語が混入していないか確認する。

---

## 起動

```bash
cd C:\Users\kenji\Desktop\metavol-web\metavol-web
npm install        # 初回のみ
npm run dev
```

`vite.config.mts` で `base: '/metavol-web-beta/'` を設定しているため URL は
**http://localhost:3000/metavol-web-beta/**（3000 が使用中なら 3001 等にフォールバック）。
公開版: https://metavol.github.io/metavol-web-beta/

その他:
- `npm run build` — 型チェック (`vue-tsc --noEmit`) + 本番ビルド
- `npm run preview` — `dist/` のプレビュー

---

## ハイレベル構成

```
src/
├── App.vue                   ツールバー（Window/Pan/Zoom/Page/SphereROI/PolygonROI/AssignLabel）
├── main.ts                   Pinia 登録、Vuetify 登録、App マウント
├── plugins/                  vuetify 設定
├── stores/
│   └── segmentation.ts       Pinia: PET/CT 参照、マスク、ラベル、球、polygon、CC、保存
├── types/
│   └── VolumeMetadata.ts     modality/SUV メタ情報の型
├── components/
│   ├── DicomView.vue         イベント中枢（マウス、ホイール、show()/showImage()、各ツール起点）
│   ├── ImageBox.vue          canvas 描画（drawNiftiSlice / drawNiftiSliceFusion / drawNiftiMip / overlay）
│   ├── Sidebar.vue           Window preset / 3D / Color / Phantom / Segmentation 開閉
│   ├── SegmentationPanel.vue 閾値スライダ、ラベル CRUD、球統計、polygon mode、Save NIfTI
│   ├── Volume.ts             Volume 型 + voxelToWorld / worldToVoxel + findVolumeBySeries
│   ├── DicomImageBoxInfo.ts  Box 情報の型（Dicom / Volume / Fused 系）
│   ├── dicom2volume.ts       DICOM → Volume（intercept/slope/SUV因子適用、modality検出、metadata付与）
│   ├── dicom2nifti.ts        NIfTI 出力（既存）
│   ├── Clut.ts               CLUT パレット（gray/rainbow/hot + labelClut カテゴリカル）
│   ├── linalg.ts             3x3 連立方程式 solve
│   └── segmentation/
│       ├── maskOps.ts        sphereStatsInPet / fillPolygonOnSlice / connectedComponents26 等
│       └── niftiWriter.ts    NIfTI-1 単一ファイル (Uint16) 書き出し（348B ヘッダ + 4B magic + voxel）
```

---

## 重要な設計上の前提

### Volume の幾何
- 物理座標（mm）の原点 = `imagePosition` (DICOM ImagePositionPatient)。
- `vectorX/Y/Z` は **「voxel index 1 進むと world で何 mm 進むか」** の3Dベクトル。
  したがって `vectorX.length()` などで voxel pitch (mm) が直接得られる。
- 表示時は `centerInWorld + vecx*(x-W/2) + vecy*(y-H/2)` で screen → world、
  `worldToVoxel` で world → voxel に逆変換して画素サンプリング。

### マスクは PET 格子で保持
- `Uint16Array(PET.nx * PET.ny * PET.nz)`、`segStore.finalMask`。
- マスク overlay は表示時に PET の affine で `worldToVoxel_(_, petIdx)` してサンプリング。
- 多ラベル（label id 1..N）。`labelClut` で色付け。
- 内部に層を分ける:
  - `thresholdMask` : 閾値由来。Apply で全再計算。
  - `manualEdits`   : polygon add / erase の差分。`ERASE_MARK = 0xFFFF` を sentinel として 0 と区別。
  - `finalMask`     : `recomputeFinalMask()` で `manualEdits` 優先で合成。

### PET/CT 自動検出
- DICOM タグ `(0008,0060) Modality` を見て `PT`/`PET` → PET、`CT` → CT。
- DicomView の `doSort()` 末尾で `detectPetCtFromDicom()` 実行。MPR 後は `refreshSegStoreVolumeRefs()` で volume 参照を最新化。

### Pinia Proxy トラップに注意（既知の落とし穴）
- Pinia state に格納されたオブジェクトは Vue が `reactive(Proxy)` でラップする。
- そのため `seriesList[i].volume === segStore.petVolumeRef` は **常に false** になりうる。
- `findPetSeriesIndex()` (DicomView.vue) は次の3段比較で照合:
  1. `voxel` TypedArray の参照同一（`Float32Array` は Proxy ラップされない）
  2. `seriesUID` 文字列一致（metadata 経由）
  3. modality === 'PT' によるフォールバック
- 新たに「store の Volume と外部の Volume が一致するか」を判定するコードを書く場合、必ずこの方針を踏襲すること。

### マスク overlay は Volume レンダ時のみ
- `ImageBox.vue` の `drawNiftiSlice` / `drawNiftiSliceFusion` のみが overlay 引数を受け取り描画する。
- 生 DICOM 表示（`drawImageCvZoom` 系）には overlay を乗せていない。
- セグメンテーション機能を使う前に **MPR or Fusion** に切り替えが必要。

### 描画パイプライン（各 Box）
1. CT base（gray CLUT、Fusion なら 50% 重み）
2. PET color overlay（hot/rainbow CLUT、Fusion なら 50% 重み）
3. mask label color（`finalMask` をサンプル、α=overlayAlpha でブレンド）
4. 球輪郭（スライス面と球の交差円、`ctx.arc()`）
5. 進行中 polygon（`ctx.stroke()` + 頂点ドット）

---

## ツール（leftButtonFunction）

| 値 | 動作 |
|---|---|
| `window` | ドラッグで WC/WW |
| `pan` | ドラッグで中心移動 |
| `zoom` | ドラッグでズーム（`vecx`/`vecy` 倍率） |
| `page` | ドラッグでスライス送り |
| `sphereROI` | クリックで球中心配置、球内ホイールで半径変更（外なら slice送り） |
| `polygonROI` | 左クリック=頂点 / 右クリック or ダブルクリック=確定 / Esc=取消 / Ctrl+Z=undo |
| `assignLabel` | クリックでその voxel が属する 26連結成分に現在ラベルID を付与 |

### ツール非依存の常時操作

| 操作 | 動作 | 実装位置 |
|---|---|---|
| **Ctrl + ホイール** | 即時ズーム（視野中心固定） | `wheel()` 先頭で `e.ctrlKey` 判定、`vecx/vecy.multiplyScalar(1/r)` |
| **中ボタンドラッグ** | 即時 Pan | `mouseMove()` 先頭で `(e.buttons & 4) !== 0` 判定 → `doPan()` |
| ホイール（通常） | スライス送り | 各 Box 個別 or Sync |

`doPan()` は `pan` ツールと共通。Volume / Fusion では `centerInWorld` を更新、DICOM では `centerX/Y` を更新。

Ctrl+wheel ズームは `isAnyVolumeBox(i) = isVolumeImageBoxInfo(i) || isFusedImageBoxInfo(i)` で
Volume 単独 / Fusion 両方をハンドル（`isVolumeImageBoxInfo` は `clut1` を持たないものに限定するため Fusion を除外する点に注意）。

---

## キーバインド

- **Ctrl+Z** : 直前 polygon 編集の undo（`undoStack` から pop してスライス全 voxel を巻き戻し）
- **Esc** : 進行中 polygon キャンセル
- **右クリック / ダブルクリック** : polygon 確定

---

## 保存形式

- `saveMaskAsNifti()` で 2 ファイル同時ダウンロード:
  - `{seriesUID}_{YYYYMMDD-HHMMSS}.nii` : Uint16 多ラベルマスク（PET 格子、PET と同一 affine）
  - 同名 `.json` : ラベル一覧、SUV閾値、PET metadata、voxel size、dims
- NIfTI ヘッダは自前実装（348B + 4B magic + raw voxel）。`niftiWriter.ts` を参照。

---

## デバッグ機能（一般ユーザ非露出）

- **有効化**: URL `?debug=1` で起動時 ON、または **Ctrl+Shift+D** トグル
- ON 時は画面右下に赤い `DEBUG` バッジ
- **voxel inspector** (`DebugInspector.vue`): マウスホバーで全シリーズの voxel 値テーブルを表示。ドラッグ中は抑止
- **voxel 編集**: Shift+左クリックで `prompt()` ダイアログ。`Volume.voxel[idx]` を直接書換 → `show()`
- 実装は `DicomView.vue` 内の `debugMode` ref、`updateDebugHover`、`handleDebugEditClick`

## テスト DICOM ロード（File System Access API）

- app-bar の **Test** ボタンで `window.showDirectoryPicker()` を呼びフォルダ選択
- 選択したディレクトリハンドルを `cachedTestDirHandle` にキャッシュ（**メモリのみ、リロードで消える**）
- 同セッション中は再選択不要、ボタン1クリックで再ロード
- Chrome/Edge のみ対応（Firefox/Safari は対応していない）

## 既知バグ / 注意点

### 0. UI レイアウト（モダン化済み）

- ダーク基調 (#0F1419) + teal アクセント (#00D4AA)
- 3カラム: Sidebar 280px / 画像 / Inspector 320px (`v-navigation-drawer` 左右)
- app-bar 高さ 48px、ツールアイコンは横並び、`.mv-tool-btn` クラスで統一
- Segmentation は **Inspector 側** に常駐（Sidebar からは切り離し済み）
- Sidebar は Series カード一覧 + Slice/Window/Color/View/Advanced セクション
- 画像エリアは CSS Grid + `overflow: auto`（タイル数が多くてもクリップしない）
- グローバル CSS は `src/styles/app.scss` で CSS 変数管理（`--mv-bg` `--mv-surface` `--mv-accent` 等）
- フォント: Inter / JetBrains Mono（unplugin-fonts 経由）

### 1. Polygon ROI が 1 スライス隣に反映される場合がある
- 原因仮説: `handlePolygonClick` で `sliceIndexInPet = Math.round(vc[sliceAxis])` としているが、`centerInWorld` がスライス境界ぴったりに乗ったとき floor/round の差で 1 ずれる。
- 修正方針: `sliceIndex` を確定する基準を「現在表示中の中心 voxel」ではなく「画面中央画素を screenToWorld → worldToVoxel した結果」にし、丸めも floor で統一して矛盾を防ぐ。
- 表示時 (`drawNiftiSliceFusion` の overlay サンプリング) も同じ基準で voxel index を決めるべき。

### 2. Polygon で不連続化したあとに片方の島だけラベル付けると、もう一方にも波及する場合がある（要設計）
- 現在の動作: `assignLabelAtVoxel` は `componentMap`（`finalMask` に対する 26連結 CC）の seed 成分を全部書き換える。
- ところが `findIslands` を **polygon erase 前に1度実行**していると、erase で分かれた後でも CC が古い → 元々 1 成分だった voxel すべてに伝播。
- → ラベル付け前に **必ず Find islands を再実行**する／erase / polygon 操作のたびに `componentMap = null` に invalidate する／`assignLabel` 時に成分が古ければ自動再計算する、のいずれか。仕様化が必要。

### 3. `setPetVolume(v)` が呼ばれるたびに mask が破棄される
- `setPetVolume` は `thresholdMask`/`manualEdits`/`finalMask`/`undoStack`/`sphere`/`polygon` を全 null 化する。
- `refreshSegStoreVolumeRefs()` は `===` で違いを検出し volume が「変わった」と判定すると毎回呼ぶ → **MPR を再度押すたびにマスクが消える**。
- 緩和策: `setPetVolume` で「同じ seriesUID なら state を保持」する。あるいは `refreshSegStoreVolumeRefs()` 側で seriesUID 比較する。

### 4. NIfTI のみロード時は modality 不明
- `nifti-reader-js` の affine からは Volume は作れるが modality は不明 → PET/CT 検出が動かない。
- 回避: ユーザに「PET として登録」「CT として登録」ボタンを提供する（未実装）。

---

## デザイン

- 既存はブラウンベース (`color: brown-darken-4` `#4E342E` 系)。`App.vue` の `myBtn` クラスがツールバーの基準。
- Vuetify テーマは `plugins/vuetify.ts` で設定（dark default 可）。
- モダン化を進める場合は dark + アクセント1色（cyan/orange）+ サイドバー幅再設計を推奨（`UI-design` 計画は別ファイル）。

---

## 開発時の小ワザ

- 型チェックだけ走らせたい: `npx vue-tsc --noEmit`
- ビルド確認: `npx vite build`
- HMR で Pinia の **アクション定義は更新されないことがある**（state は `__hmrId` 経由で patch されるが、closure は古いまま）。挙動が古いと感じたら **Ctrl+Shift+R**（ハードリロード）。
- Volume の voxel pitch を確認したい: `vectorX.length()` `vectorY.length()` `vectorZ.length()`。
- Console で store を覗くには `app.config.globalProperties.$pinia` 経由が必要だが、開発中は SegmentationPanel に一時的にデバッグ表示を埋めるのが速い。

---

## TODO（中期）

- ~~PET 標準ビュー（CT axial / PET axial / Fusion axial / PET MIP の 2×2）ワンクリック~~ ✅ 実装済
- ~~MIP にもマスク overlay~~ ✅ 実装済
- ~~閾値 UI を combobox 化（2.5 / 3.0 / 3.5 / 4.0 / manual）~~ ✅ 実装済
- ~~ラベル波及の仕様再定義（バグ #2 関連）~~ ✅ componentMapValid invalidate で対応済
- ~~UI デザイン全体刷新（モダン化）~~ ✅ 3カラム + ダークテーマで実施済
- NIfTI ロード時の modality 手動指定（未実装）
- マスクロード（書いたものを読み戻す）対応で round-trip 検証（未実装）
- composable 切り出し（`useSphereROI`, `usePolygonROI`）で `DicomView.vue` を縮小（未実装）
- バンドルが 500KB 超え → manual chunk 分割の検討（未対応、`vite build` 時に warning）

### 2026-05-01 追加タスク（次セッションで着手）

優先順位は未確定。実装時に整理する。

- **NIfTI ロード対応**: `.nii` と `.nii.gz` 両方を読めるようにする（gzip は `pako` などで解凍）。modality は当面手動指定 UI とセットで考える
- **「全体化」ボタン**: tile 数（例: 6 枚）に応じて画像エリア全体を隙間なく埋めるレイアウト。`autoFitMode` の発展で `imageBoxW/H` を画像エリアサイズから逆算
- **Fusion の操作改善**: 現状の Fusion ボタンはどの 2 つを fuse するのか不明瞭。各 ImageBox に表示中シリーズの **modality アイコンをドラッグハンドル**として置き、別の ImageBox にドロップするとその 2 つで Fusion になる UX を検討
- **Sidebar 上部 SERIES ラベル直下の矢印ボタン 2 個を削除**（用途不明 / 不要）
- **断面支持線（cross-reference lines）**: 各 ImageBox に他の直交断面の現在位置を線で表示。MPR 3 面を見ながらの位置同定を改善
- **サムネイル画像の挙動変更**:
  - サムネからのドラッグスタートを可能にするため、現在サムネに割当てている **paging（ドラッグでスライス送り）を削除**
  - 代わりにサムネ上で **マウスホイールによる paging** を有効化
- **ImageBox 名称の整理**: VolumeBox ではない「DICOM 1 枚を表示する素のボックス」を何と呼ぶか命名する。そのボックスに以下を追加:
  - **カラースケール表示**（現状未表示）
  - **患者情報・撮影情報を 4 隅に表示**、グローバルトグルで ON/OFF
  - **Ctrl+wheel ズーム対応**（Volume / Fusion はすでに対応済み、DICOM 単票はまだ）
  - **補間を nearest → bilinear に変更**（既定）
- **DICOM tag ボタンの配置変更**: アイコン単独ではわかりにくいので、`...` メニューもしくは左上ハンバーガーメニュー内に移す
- **タイトル変更**: 「metavol」を「metavol-web」に
- **Polygon ROI のアイコンを五角形に**変更
- **VolumeBox では DICOM tag view を非対応に**（タグは生 DICOM 画面でのみ意味があるため）

---

## セッション引き継ぎサマリー（2026-04-27 時点）

### この期間で完了した作業

**機能追加**
1. SUV/segmentation 機能一式 (Step 1〜4): Pinia store、Volume metadata、SegmentationPanel、マスク overlay、PET/CT 自動検出
2. Sphere ROI（クリック中心配置 + 球内ホイール半径変更 + SUVmax/mean 即時表示）
3. Polygon ROI（slice 単位 add/erase、Esc/Ctrl+Z）
4. アイランド検出 (26連結 CC) + Assign Label ツール
5. NIfTI-1 マスク保存（Uint16 多ラベル + JSON サイドカー）
6. PET 標準ビュー（CT axi / PET axi / Fusion axi / PET MIP の 2x2 ワンクリック）
7. MIP にもマスク overlay
8. 閾値 UI コンボボックス化 (2.5/3.0/3.5/4.0/Manual)
9. Volume card リスト（サムネ + Modality バッジ + matrix size、クリックで Box に反映）
10. Ctrl+ホイール 即時ズーム（視野中心固定、Volume/Fusion 両対応）
11. 中ボタンドラッグ 即時 Pan
12. Test ボタン（File System Access API でフォルダ選択 → 自動 PET Standard）
13. デバッグモード（?debug=1 / Ctrl+Shift+D で voxel inspector + Shift+Click voxel 編集）
14. autoFitMode（ウィンドウ/drawer/tileN 変化に追従）+ Fit to window ボタン
15. Synchronize 初期 OFF、CLUT クリック即時反映、PET voxel 表記削除など細かい修正

**UI 全面刷新**
- ダークメディカルテーマ (#0F1419 / teal #00D4AA)
- 3カラムレイアウト (Sidebar 280px / 画像 / Inspector 320px)
- app-bar 48px スリム化、全ツールアイコン化
- Inter / JetBrains Mono フォント
- グローバル CSS 変数 (`src/styles/app.scss`)

**バグ修正**
- Polygon ROI 1スライスずれ（Math.round → Math.floor、画面中央 voxel 基準で算出）
- Pinia Proxy で `===` 比較が破綻 → voxel TypedArray + seriesUID + modality の3段照合
- 同一 PET の MPR 再実行でマスクが消える → seriesUID 同一なら state 保持
- Ctrl+wheel ズームが Fusion で効かない → `isAnyVolumeBox` で対応

### このセッションで踏んだ重要な落とし穴（再発防止）

1. **Pinia state は Proxy ラップされる** — DicomView 内 `let seriesList: SeriesList[]` のような plain な変数と store の値を `===` で比較してはいけない。voxel TypedArray の参照同一 / seriesUID 文字列一致 / modality を順に試す。`findPetSeriesIndex()` がこのパターンの実装例。
2. **Pinia アクションの HMR は不完全** — store のアクション定義を変えてもブラウザ側で古い closure が使われ続けることがある。挙動が変わらないと感じたら **Ctrl+Shift+R** ハードリロード。
3. **`isVolumeImageBoxInfo` は Fusion を含まない** — `clut1` を持つものは除外する判定。Fusion を含めたいときは `isAnyVolumeBox = isVolumeImageBoxInfo || isFusedImageBoxInfo` を使う。
4. **マスク overlay は Volume レンダのみ** — 生 DICOM 表示モード (`drawImageCvZoom`) には overlay コードパスが無い。MPR/Fusion/PET Standard を経由させる UX にしてある。
5. **ImageBox の re-init が必要なタイミング** — tileN 変更後、imageBoxW/H 変更後は `imb.value[i].init()` を呼んでから `show()` しないと canvas が壊れる。`watch(tileN)` と `watch([imageBoxW, imageBoxH])` で対応済み。

### 次セッション再開時のチェックポイント

1. **動作確認の最短手順**
   - `npm run dev` → ブラウザで http://localhost:3000/metavol-web-beta/
   - **Test** ボタン → PET/CT フォルダ選択 → 自動で PET Standard が出る
   - Inspector で **Apply** → 赤マスク → polygon erase → Find islands → Assign label → Save NIfTI

2. **既知の未解決事項**
   - `DicomView.vue` が約 1700 行。composable (`useSphereROI`, `usePolygonROI`, `useDebug`) に切り出す価値あり
   - bundle size 500KB超: code splitting 未着手
   - NIfTI のみロード時 modality 手動指定 UI 未実装
   - マスクをロードして再編集する round-trip 機能なし
   - 球輪郭描画は等方 voxel 前提の概算
   - Test ボタンの directory handle は IndexedDB に永続化していないため、ページリロードで再選択が必要

3. **着手中だった案件**
   - なし（Step 5 微調整まで完了）

4. **触っていないので次の改善候補（推奨順）**
   - composable 切り出し（DicomView.vue の保守性）
   - NIfTI ロード時の modality 手動指定
   - マスクロード round-trip
   - Sidebar の閉じ機能 (現状は app-bar の ☰ のみ)
   - PET Standard 後の各 Box のラベル表示（"CT" / "PET" / "Fusion" / "MIP" を画像左上に）

### ファイル状態（git）

- 新規追加: CLAUDE.md, USAGE.md, src/stores/segmentation.ts, src/types/VolumeMetadata.ts,
  src/styles/app.scss, src/components/SegmentationPanel.vue, src/components/SeriesList.vue,
  src/components/DebugInspector.vue, src/components/segmentation/{maskOps,niftiWriter}.ts
- 変更: README.md, components.d.ts, package.json, package-lock.json, vite.config.mts,
  src/main.ts, src/App.vue, src/plugins/vuetify.ts,
  src/components/{DicomView,ImageBox,Sidebar,Volume,Clut,dicom2volume}.{vue,ts}
- 削除: なし
- ブランチ: main
- 未コミット（このセッションでは commit していない）

### 動作確認済み環境

- Windows 11 Pro、Chrome/Edge（File System Access API 必要）
- npm run build / vue-tsc --noEmit いずれも exit=0
- 開発サーバ: ポート 3000 が使用中だったため 3001 で起動していた

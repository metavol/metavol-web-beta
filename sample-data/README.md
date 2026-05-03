# sample-data/ — テスト用 PET/CT 症例

開発・動作検証用のローカル症例データを置くディレクトリ。`.gitignore` 済 (各
開発者ローカル管理。リポジトリには含まれない)。

`vite dev` 起動中は `vite.config.mts` の `devSampleDataPlugin` 経由で
HTTP 配信されるので、ブラウザから `?dev=<caseId>` または
`?url=/samples/<caseId>/<file>` で直接ロードできる。

## 起動 URL

```bash
npm run dev    # http://localhost:3000/metavol-web-beta/ (3000 占有時 3001 等)
```

- `?dev=<caseId>` … `sample-data/<caseId>/` 配下を全て自動ロード (vite middleware + parallel fetch)
- `?url=/samples/<caseId>/<file>` … 個別ファイルを fetch + load (ext-url 経路、複数 `?url=` も可)

## 同梱症例一覧

### nii003 — PSMA PET/CT (whole body, AC 含む)
**用途**: 軽量な NIfTI ロード回帰テスト、blend slider / fusion drag-and-drop / threshold 検証

| ファイル | size | 内容 |
|---|---|---|
| `003PT00.nii` | 36 MB | PSMA Super WB transaxial (CTAC 補正済み)、Float32、144×144×444 |
| `003CT00.nii` | 372 MB | Fusion CT 5mm WB、Float32、512×512×355 |

起動: `?dev=nii003` (両ファイル auto load)

特徴:
- ファイル名に `PT` / `CT` 含むので modality 自動推定が効く
- description に `PSMA` 含むので tracer auto-detect (PSMA preset 適用)
- AC 補正済 PT なので SUV 表示有効

### multiplebonemets — 多発骨転移 (CT/PT/lesion mask)
**用途**: nnU-Net auto-segmentation 後の workflow 検証 (mask round-trip、lesion table、TMTV 計算、Deauville)

| ファイル | size | 内容 |
|---|---|---|
| `pet_suv.nii.gz` | 47 MB (展開 195 MB) | PT volume、SUV 単位、Float32、512×512×195 |
| `ct.nii.gz` | 50 MB (展開 390 MB) | CT volume、Float64、512×512×195 |
| `lesions.nii.gz` | 56 KB | 多発骨転移 mask、Uint16 or Uint8 |
| `STATUS.json` | — | nnU-Net inference status (`phase: done`) |
| `report.json` | — | nnU-Net inference report (folds, device, duration) |

起動 (recommended):
```
?url=/samples/multiplebonemets/pet_suv.nii.gz&url=/samples/multiplebonemets/ct.nii.gz
```
ロード後 Inspector の **Load Mask** で `lesions.nii.gz` を読み込む。

特徴:
- 多発性骨転移 (lesion mask 178 cc) → TMTV cutoff 警告動作確認に最適
- pet_suv.nii.gz は **既に SUV 化済**のため、loadNii の SUV factor 計算を経由しない (suvOk: false で Bq/ml 表示にならず raw SUV 表示)
- ct.nii.gz は **Float64** (典型的な CT は Int16)、datatype expansion 対応の検証
- mask 読込で lesion table の Tumor 行が更新される
- PET MIP に多数の bone metastases が dark spot として可視化

### cartesionprime / cartesianprime-subset — 多 series DICOM (2 PT × 2 CT)
**用途**: 多 series DICOM の PET Standard picker、Fusion D&D、Make MPR 検証

| ファイル | size | 内容 |
|---|---|---|
| `cartesionprime/` | 555 MB (2131 files) | フル case (2 PT 系列 + 2 CT 系列) |
| `cartesianprime-subset/` | ~20 MB (400 files) | 軽量 subset (毎 5 番目を抽出)、テスト高速化用 |

起動: `?dev=cartesianprime-subset` (数十秒でロード完了、subset で十分)

特徴:
- 同 modality 複数 series → PET Standard ピッカーダイアログ発火
- `WB PT,TOF-AC` (ATTN 補正済) と `WB PT,TOF-NonAC` (NAC) → SUV 切替 / Bq/ml フォールバック検証
- Lung window (`Lung` preset) と Make MPR の window 保持検証
- Fusion drag-and-drop で modality chip → 複数 box の独立性確認

### 003 — DICOM (legacy, 詳細不明)
**用途**: 不明 (古い workflow テスト用らしい)。可能なら削除候補。

---

## 命名 / 配置ルール

新しい症例を追加するときは:
- `sample-data/<lowercase-shortname>/` ディレクトリを作る
- DICOM フォルダなら直接 `.dcm` ファイルを置く (拡張子なしも OK)
- NIfTI なら `*.nii` / `*.nii.gz` を置く
- 関連 mask は `lesions.nii.gz` / `mask.nii.gz` 等わかりやすい名前で
- README に 1 entry 追加 (用途・size・特徴・起動 URL)
- `.gitignore` で除外されているので git にはコミットされない

## サイズ削減 tip

巨大 DICOM フォルダは subset で十分なテストが可能:
```bash
# 5 ファイルに 1 つを抽出 (~20% size、layout テスト目的なら十分)
mkdir -p sample-data/<case>-subset
ls sample-data/<case>/ | awk 'NR % 5 == 0' | head -400 | xargs -I {} cp "sample-data/<case>/{}" "sample-data/<case>-subset/"
```

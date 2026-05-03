// LiteMedSAM browser inference (ONNX Runtime Web, WebGPU backend)
//
// Phase 1 (本ファイル): UI scaffolding + preprocess pipeline + inference call structure。
//   実モデルを差し替え可能な形にしておく。Phase 2 で LiteMedSAM ONNX を入手・配置して有効化。
//
// LiteMedSAM 仕様 (公式 bowang-lab/MedSAM Lite checkpoint より):
//   - encoder input  : 1 × 3 × 256 × 256 (RGB normalize + resize)
//   - prompt input   : point coords (xy) + label (1=foreground, 0=background, -1=padding)
//   - decoder output : 256 × 256 logits → threshold 0 → binary mask
// Image embedding は重い (encoder forward 1 回で 1-3s WebGPU)、prompt-only refine は軽い (10-50ms)
// → 1 image につき encoder 1 回、点を加える毎に decoder のみ走らせる pattern が pyradiomics 的
//
// 参考実装:
//   https://github.com/bowang-lab/MedSAM (公式)
//   https://github.com/NeuroDesk/cvpr-sam-on-laptop-2024 (CVPR 2024 submission, ONNX export 例)
//   https://github.com/automl/CVPR24-MedSAM-on-Laptop (ONNX 量子化版あり)

// 動的 import: ORT-Web は ~2 MB あるので、AI ROI ツール初回起動まで遅延 load する
let ortMod: typeof import('onnxruntime-web') | null = null;

const loadOrt = async () => {
    if (ortMod) return ortMod;
    ortMod = await import('onnxruntime-web');
    // Wasm path 設定: vite が node_modules/onnxruntime-web/dist/*.wasm を /assets に bundle するため
    // 明示的な wasmPaths 設定は不要だが、CDN fallback を入れたい場合はここで指定可能
    return ortMod;
};

// WebGPU が使えるか確認 (ブラウザ機能 detect)。非対応 → 明確な alert を出して abort。
export const isWebGpuAvailable = (): boolean => {
    return typeof navigator !== 'undefined'
        && 'gpu' in navigator
        && !!(navigator as any).gpu;
};

// ====== Model URL config ======
// Phase 2 で実 ONNX を配置するパス。GitHub Releases 等にホストする想定。
// ローカル開発なら public/medsam/ に置いて /medsam/<file> でアクセス。
const MODEL_URL_ENCODER = '/medsam/litemedsam_encoder.onnx';
const MODEL_URL_DECODER = '/medsam/litemedsam_decoder.onnx';

// ====== Model session lazy load ======
let encoderSession: any | null = null;
let decoderSession: any | null = null;
let modelLoadPromise: Promise<void> | null = null;

const ensureModelsLoaded = async (): Promise<void> => {
    if (encoderSession && decoderSession) return;
    if (modelLoadPromise) return modelLoadPromise;
    modelLoadPromise = (async () => {
        const ort = await loadOrt();
        if (!isWebGpuAvailable()) {
            throw new Error(
                'WebGPU is not available in this browser. AI ROI requires Chrome 113+, Edge, or Safari 17.4+.'
            );
        }
        const sessionOptions = {
            executionProviders: ['webgpu'],
            graphOptimizationLevel: 'all' as const,
        };
        try {
            encoderSession = await ort.InferenceSession.create(MODEL_URL_ENCODER, sessionOptions);
            decoderSession = await ort.InferenceSession.create(MODEL_URL_DECODER, sessionOptions);
        } catch (err: any) {
            modelLoadPromise = null;  // retry 可能にする
            throw new Error(
                `Failed to load LiteMedSAM model. Place ONNX files at public${MODEL_URL_ENCODER} and public${MODEL_URL_DECODER}. Reason: ${err?.message ?? err}`
            );
        }
    })();
    return modelLoadPromise;
};

// ====== Image preprocess ======
// LiteMedSAM input: 1 × 3 × 256 × 256, normalize to [0, 1] (or pixel mean/std subtract per repo).
// metavol の canvas は WC/WW 適用済 RGB なのでそのまま使える。
// 入力 ImageData (canvas size 任意) を 256 × 256 にリサイズ + RGB 正規化。
export interface PreprocessedImage {
    tensor: Float32Array;             // 1×3×256×256 = 196608 entries
    origW: number;
    origH: number;
}

export const preprocessImage = (
    canvas: HTMLCanvasElement,
): PreprocessedImage | null => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const origW = canvas.width;
    const origH = canvas.height;

    // 256x256 にリサイズ (簡易 nearest)。LiteMedSAM は letterbox なしでも動くが、
    // 厳密には longest_side=256 + padding が公式実装。MVP はリサイズのみ。
    const tmp = document.createElement('canvas');
    tmp.width = 256; tmp.height = 256;
    const tctx = tmp.getContext('2d');
    if (!tctx) return null;
    tctx.drawImage(canvas, 0, 0, 256, 256);
    const img = tctx.getImageData(0, 0, 256, 256);
    const px = img.data;

    // CHW Float32 [0,1] に変換 (R, G, B チャネル分離)
    const tensor = new Float32Array(3 * 256 * 256);
    for (let i = 0; i < 256 * 256; i++) {
        tensor[i]               = px[i * 4]     / 255;  // R
        tensor[i + 256 * 256]   = px[i * 4 + 1] / 255;  // G
        tensor[i + 2 * 256 * 256] = px[i * 4 + 2] / 255;  // B
    }
    return { tensor, origW, origH };
};

// ====== Encoder forward ======
// 1 image 1 回。embedding を返す (decoder への入力)。重い処理 (1-3s WebGPU)。
export const runEncoder = async (img: PreprocessedImage): Promise<any> => {
    await ensureModelsLoaded();
    const ort = await loadOrt();
    const inputTensor = new ort.Tensor('float32', img.tensor, [1, 3, 256, 256]);
    const t0 = performance.now();
    const out = await encoderSession!.run({ image: inputTensor });
    console.log(`[medsam] encoder forward: ${(performance.now() - t0).toFixed(0)}ms`);
    // Output key は ONNX export 時の名前依存 (典型: 'image_embeddings')
    return out['image_embeddings'] ?? out[Object.keys(out)[0]];
};

// ====== Decoder forward (prompt-only) ======
// Encoder embedding + click point から mask を生成。軽い (10-50ms)。
// Click points は image space (origW × origH) → 256×256 にスケール変換。
export interface ClickPoint {
    x: number;             // canvas pixel x
    y: number;             // canvas pixel y
    label: 0 | 1;          // 1 = foreground, 0 = background
}

export const runDecoder = async (
    embedding: any,
    clicks: ClickPoint[],
    origW: number,
    origH: number,
): Promise<Uint8Array | null> => {
    if (clicks.length === 0) return null;
    await ensureModelsLoaded();
    const ort = await loadOrt();

    // points (1, N, 2) と labels (1, N) — 256x256 input space に scale
    const sx = 256 / origW;
    const sy = 256 / origH;
    const N = clicks.length;
    const pointCoords = new Float32Array(N * 2);
    const pointLabels = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        pointCoords[i * 2] = clicks[i].x * sx;
        pointCoords[i * 2 + 1] = clicks[i].y * sy;
        pointLabels[i] = clicks[i].label;
    }
    const ptCoordsTensor = new ort.Tensor('float32', pointCoords, [1, N, 2]);
    const ptLabelsTensor = new ort.Tensor('float32', pointLabels, [1, N]);

    // LiteMedSAM decoder の入力名は ONNX export 依存。一般的な SAM 互換は:
    //   image_embeddings, point_coords, point_labels, mask_input, has_mask_input, orig_im_size
    // mask_input / has_mask_input は省略 (zeros + 0 で OK)
    const maskInput = new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]);
    const hasMask = new ort.Tensor('float32', new Float32Array([0]), [1]);
    const origSize = new ort.Tensor('float32', new Float32Array([origH, origW]), [2]);

    const feeds: Record<string, any> = {
        image_embeddings: embedding,
        point_coords: ptCoordsTensor,
        point_labels: ptLabelsTensor,
        mask_input: maskInput,
        has_mask_input: hasMask,
        orig_im_size: origSize,
    };
    const t0 = performance.now();
    const out = await decoderSession!.run(feeds);
    console.log(`[medsam] decoder forward: ${(performance.now() - t0).toFixed(0)}ms`);

    // 出力 mask (1 × 1 × H × W) → threshold > 0 で binary
    const maskTensor = out['masks'] ?? out[Object.keys(out)[0]];
    const data = maskTensor.data as Float32Array;
    const dims = maskTensor.dims as number[];
    const H = dims[dims.length - 2];
    const W = dims[dims.length - 1];
    const binary = new Uint8Array(H * W);
    for (let i = 0; i < H * W; i++) binary[i] = data[i] > 0 ? 1 : 0;
    return binary;
};

// 1-shot 簡易 API: image + click → binary mask。MVP 用の wrap。
export const segmentSingleClick = async (
    canvas: HTMLCanvasElement,
    clickX: number,
    clickY: number,
): Promise<Uint8Array | null> => {
    const pre = preprocessImage(canvas);
    if (!pre) return null;
    const emb = await runEncoder(pre);
    return runDecoder(emb, [{ x: clickX, y: clickY, label: 1 }], pre.origW, pre.origH);
};

// VR compute pipeline + 1-call render API。MIP pipeline と同じ構成。
// CLUT buffer / OffscreenCanvas / bind layout は gpuShared 経由で MIP と共有する。

import { getGpuDevice } from './gpuContext';
import { getVolumeTexture } from './volumeCache';
import { VR_SHADER_WGSL } from './vrShader';
import { getClutBuffer, ensureOffscreen, getVrBindGroupLayout } from './gpuShared';
import { usePerfStore } from '../../stores/perf';

interface PipelineCache {
    device: any;
    pipeline: any;
    bindLayout: any;
    uniformBuf: any;        // 128 byte uniform (8 vec4)
}

let pipelineCache: PipelineCache | null = null;
const VR_UNIFORM_SIZE = 128;

const ensurePipeline = async (): Promise<PipelineCache | null> => {
    const device = await getGpuDevice();
    if (!device) return null;
    if (pipelineCache && pipelineCache.device === device) return pipelineCache;

    const module = device.createShaderModule({ code: VR_SHADER_WGSL });
    const bindLayout = getVrBindGroupLayout(device);
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] });
    const pipeline = device.createComputePipeline({
        layout: pipelineLayout,
        compute: { module, entryPoint: 'main' },
    });
    const uniformBuf = device.createBuffer({
        size: VR_UNIFORM_SIZE,
        usage: 0x40 | 0x8,
    });
    pipelineCache = { device, pipeline, bindLayout, uniformBuf };
    return pipelineCache;
};

export interface GpuVrParams {
    voxel: Float32Array | Int16Array;
    nx: number;
    ny: number;
    nz: number;
    outW: number;
    outH: number;
    p00: { x: number; y: number; z: number };
    v01: { x: number; y: number; z: number };
    v10: { x: number; y: number; z: number };
    // through-plane voxel-step vector (camera forward × step size)。自由回転対応:
    // この vector があれば任意の方向に ray-cast 可能。MIP の単純 z-rotation とは別系統。
    vForward: { x: number; y: number; z: number };
    maxSteps: number;       // ray sample 回数 (通常 ≈ volume の最長対角)
    wc: number;
    ww: number;
    clut: number[][];
    alphaScale?: number;    // default 0.06 (CPU 実装と同じ)
    targetCanvas: HTMLCanvasElement;
}

export const gpuRenderVr = async (
    p: GpuVrParams,
): Promise<OffscreenCanvas | null> => {
    if (p.outW <= 0 || p.outH <= 0) return null;
    if (!usePerfStore().gpuAllowed) return null;
    const cache = await ensurePipeline();
    if (!cache) return null;
    const { device, pipeline, bindLayout, uniformBuf } = cache;

    const volTex = await getVolumeTexture(device, p.voxel, p.nx, p.ny, p.nz);
    const clutBuf = getClutBuffer(device, p.clut);
    const off = ensureOffscreen(device, p.targetCanvas, p.outW, p.outH);
    if (!off) return null;

    const ubuf = new ArrayBuffer(VR_UNIFORM_SIZE);
    const i32 = new Int32Array(ubuf);
    const f32 = new Float32Array(ubuf);
    // dims: nx, ny, nz, maxSteps
    i32[0] = p.nx; i32[1] = p.ny; i32[2] = p.nz; i32[3] = p.maxSteps;
    // outAndMode: outW, outH, _, _
    i32[4] = p.outW; i32[5] = p.outH; i32[6] = 0; i32[7] = 0;
    // p00 / v01 / v10
    f32[8] = p.p00.x; f32[9] = p.p00.y; f32[10] = p.p00.z; f32[11] = 0;
    f32[12] = p.v01.x; f32[13] = p.v01.y; f32[14] = p.v01.z; f32[15] = 0;
    f32[16] = p.v10.x; f32[17] = p.v10.y; f32[18] = p.v10.z; f32[19] = 0;
    // vForward
    f32[20] = p.vForward.x; f32[21] = p.vForward.y; f32[22] = p.vForward.z; f32[23] = 0;
    // rotWC: _, _, wc, ww
    f32[24] = 0; f32[25] = 0; f32[26] = p.wc; f32[27] = p.ww;
    // vrParams: alphaScale, _, _, _
    f32[28] = p.alphaScale ?? 0.06;
    f32[29] = 0; f32[30] = 0; f32[31] = 0;
    device.queue.writeBuffer(uniformBuf, 0, ubuf);

    const swapTex = off.ctx.getCurrentTexture();
    const swapView = swapTex.createView();
    const volView = volTex.createView({ dimension: '3d' });
    const bindGroup = device.createBindGroup({
        layout: bindLayout,
        entries: [
            { binding: 0, resource: { buffer: uniformBuf } },
            { binding: 1, resource: volView },
            { binding: 2, resource: { buffer: clutBuf } },
            { binding: 3, resource: swapView },
        ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(p.outW / 8), Math.ceil(p.outH / 8), 1);
    pass.end();
    device.queue.submit([encoder.finish()]);

    return off.canvas;
};

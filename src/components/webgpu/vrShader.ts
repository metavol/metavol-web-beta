// WGSL compute shader for Volume Rendering (front-to-back composite)。
//
// CPU 実装 (ImageBox.vue:618-) を 1 shader に潰した形:
//   1. screen → slab voxel coord
//   2. (j=v0.x, k=v0.z) の slab で「rotation 後の x' 軸」前方から ray march
//   3. 各 sample で WC/WW 正規化 → opacity = p * alphaScale, color = clut[p*255]
//   4. front-to-back composite (Porter-Duff over): dst += transmit * α * src
//   5. early exit (da > 0.99)
//
// CPU 版と同様 ALPHA_SCALE = 0.06 固定。閾値 (alpha < 0.002) も同じ。

export const VR_SHADER_WGSL = /* wgsl */ `
struct Params {
  dims: vec4<i32>,         // nx, ny, nz, _
  outAndMode: vec4<i32>,   // outW, outH, _, _
  p00: vec4<f32>,
  v01: vec4<f32>,
  v10: vec4<f32>,
  rotWC: vec4<f32>,        // cosA, sinA, wc, ww
  vrParams: vec4<f32>,     // alphaScale, _, _, _
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var volumeTex: texture_3d<f32>;
@group(0) @binding(2) var<storage, read> clut: array<vec4<f32>>;
@group(0) @binding(3) var outTex: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let cx = i32(gid.x);
  let cy = i32(gid.y);
  let outW = P.outAndMode.x;
  let outH = P.outAndMode.y;
  if (cx >= outW || cy >= outH) { return; }

  let nx = P.dims.x;
  let ny = P.dims.y;
  let nz = P.dims.z;

  let cyf = f32(cy);
  let cxf = f32(cx);
  let vx = P.p00.x + cyf * P.v01.x + cxf * P.v10.x;
  let vy = P.p00.y + cyf * P.v01.y + cxf * P.v10.y;
  let vz = P.p00.z + cyf * P.v01.z + cxf * P.v10.z;
  let ix = i32(floor(vx));
  let iy = i32(floor(vy));
  let iz = i32(floor(vz));

  if (ix < 0 || ix >= nx || iy < 0 || iy >= ny || iz < 0 || iz >= nz) {
    textureStore(outTex, vec2<i32>(cx, cy), vec4<f32>(0.0, 0.0, 0.0, 1.0));
    return;
  }

  let j0 = f32(ix) - f32(ny) * 0.5;
  let cosA = P.rotWC.x;
  let sinA = P.rotWC.y;
  let wc = P.rotWC.z;
  let ww = P.rotWC.w;
  let lo = wc - ww * 0.5;
  let alphaScale = P.vrParams.x;

  var dr: f32 = 0.0;
  var dg: f32 = 0.0;
  var db: f32 = 0.0;
  var da: f32 = 0.0;

  for (var i: i32 = 0; i < nx; i = i + 1) {
    if (da > 0.99) { break; }
    let i0 = f32(i) - f32(nx) * 0.5;
    let xf = floor(i0 * cosA - j0 * sinA + f32(nx) * 0.5);
    let yf = floor(i0 * sinA + j0 * cosA + f32(ny) * 0.5);
    let x = i32(xf);
    let y = i32(yf);
    if (x < 0 || x >= nx || y < 0 || y >= ny) { continue; }
    let v = textureLoad(volumeTex, vec3<i32>(x, y, iz), 0).r;
    var p = (v - lo) / ww;
    if (p < 0.0) { continue; }
    if (p > 1.0) { p = 1.0; }
    let alpha = p * alphaScale;
    if (alpha < 0.002) { continue; }
    let cidx = i32(min(255.0, floor(p * 255.0)));
    let c = clut[cidx];
    let transmit = 1.0 - da;
    dr = dr + transmit * alpha * c.r;
    dg = dg + transmit * alpha * c.g;
    db = db + transmit * alpha * c.b;
    da = da + transmit * alpha;
  }

  textureStore(outTex, vec2<i32>(cx, cy), vec4<f32>(dr, dg, db, 1.0));
}
`;

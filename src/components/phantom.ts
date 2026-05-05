import { Volume } from "./Volume.ts";
import * as THREE from 'three';

// NEMA IEC Body Phantom — 6 hot spheres of decreasing diameter inside a warm
// elliptical body cylinder, with a cold central lung insert. The standard PET
// QC phantom for testing recovery coefficients, partial-volume effects, and
// MTV/SUVpeak workflows.
//
// Activity ratios (SUV-like): background = 1, spheres = 8, lung = 0.
// Sphere diameters (mm): 10, 13, 17, 22, 28, 37 (per NEMA NU 2 spec).
// 2 mm voxel pitch → 240 × 180 × 160 mm volume.
export const generatePhantomNema = (): Volume => {
  const [nx, ny, nz] = [120, 90, 80];
  const pitch = 2;  // mm/voxel
  const voxel = new Float32Array(nx * ny * nz);

  const cxMm = (nx * pitch) / 2;
  const cyMm = (ny * pitch) / 2;
  const czMm = (nz * pitch) / 2;
  const bodyRxMm = 110;     // body ellipse semi-axis (lateral)
  const bodyRyMm = 75;      // body ellipse semi-axis (anterior-posterior)
  const lungRMm  = 24;      // central cold cylinder radius
  const sphereRingMm = 57;  // ring radius of sphere centers
  const sphereCzMm   = czMm + 6;  // shift spheres a bit cranial of mid-axial
  const diameters = [37, 28, 22, 17, 13, 10];   // largest first, going clockwise

  const spheres = diameters.map((d, i) => {
    const ang = (i / diameters.length) * Math.PI * 2 - Math.PI / 2;
    return {
      cx: cxMm + sphereRingMm * Math.cos(ang),
      cy: cyMm + sphereRingMm * Math.sin(ang) * 0.7,  // squashed to fit elliptical body
      cz: sphereCzMm,
      r: d / 2,
    };
  });

  const sphereR2 = spheres.map(s => s.r * s.r);

  for (let z = 0; z < nz; z++) {
    const zMm = z * pitch;
    const dz = zMm - czMm;
    // Cap top/bottom to leave a few empty slices (so the box isn't filled to the edges)
    if (Math.abs(dz) > nz * pitch / 2 - 6) continue;
    for (let y = 0; y < ny; y++) {
      const yMm = y * pitch;
      const dy = yMm - cyMm;
      for (let x = 0; x < nx; x++) {
        const xMm = x * pitch;
        const dx = xMm - cxMm;
        // Outside body ellipse → background air (left as 0)
        const ellipseTest = (dx * dx) / (bodyRxMm * bodyRxMm) + (dy * dy) / (bodyRyMm * bodyRyMm);
        if (ellipseTest > 1) continue;
        // Cold lung cylinder (axis = z)
        const r2_axial = dx * dx + dy * dy;
        if (r2_axial < lungRMm * lungRMm) continue;
        let value = 1.0;
        for (let i = 0; i < spheres.length; i++) {
          const s = spheres[i];
          const sdx = xMm - s.cx, sdy = yMm - s.cy, sdz = zMm - s.cz;
          if (sdx * sdx + sdy * sdy + sdz * sdz <= sphereR2[i]) {
            value = 8.0;
            break;
          }
        }
        voxel[z * nx * ny + y * nx + x] = value;
      }
    }
  }

  return {
    voxel,
    nx, ny, nz,
    imagePosition: new THREE.Vector3(0, 0, 0),
    vectorX: new THREE.Vector3(pitch, 0, 0),
    vectorY: new THREE.Vector3(0, pitch, 0),
    vectorZ: new THREE.Vector3(0, 0, pitch),
    metadata: {
      modality: 'PT',
      seriesDescription: 'NEMA IEC Body Phantom (demo)',
      suvOk: true,
      suvFactor: 1,
      suvSource: 'units_already_SUV',
    },
  };
};

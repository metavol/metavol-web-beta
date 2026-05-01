// 2024/5/4
// modified 2024/5/19
//
// homework 6/9: which is better, type vs. interface?
//
//

import * as THREE from 'three';
import * as Volume from './Volume';

export type ImageBoxInfoBase = {
    currentSeriesNumber: number,
    myWC: number | null,
    myWW: number | null,
    description: string,
}

// Raw 1-frame DICOM viewer box (no MPR, no Volume reconstruction).
// Counterpart of VolumeImageBoxInfo (3D 再構成スライス) / FusedVolumeImageBoxInfo (CT+PET 重畳)。
export type DicomSliceImageBoxInfo = ImageBoxInfoBase &  {
    currentSliceNumber: number,
    imageNumberOfDicomTag: number | null,
    centerX:number,
    centerY:number
    zoom: number | null,
}

export type VolumeImageBoxInfo = ImageBoxInfoBase & {
    centerInWorld:THREE.Vector3,
    vecx: THREE.Vector3,
    vecy: THREE.Vector3,
    vecz: THREE.Vector3,
    clut: number,
    isMip: boolean,
    mip: {
        mipAngle: number,
        isSurface: boolean,
        thresholdSurfaceMip: number,
        depthSurfaceMip: number
    } | null,
    // Volume Rendering (front-to-back composite)。MIP/sMIP と排他: isVr=true のとき isMip=false
    isVr?: boolean,
}

export type FusedVolumeImageBoxInfo = VolumeImageBoxInfo & {
    currentSeriesNumber1: number,
    clut1: number,
    myWC1: number | null,
    myWW1: number | null,
}

export const defaultInfo = (i: number) => {
    return {
        currentSeriesNumber: i,
        currentSliceNumber:0,
        imageNumberOfDicomTag: null,
        description: "",
        myWC:null,
        myWW:null,
        centerX:0,
        centerY:0,
        zoom:null,
        clut:0,
    };
    // centerの意味は、画面上のcanvasの中心（canvasが800x800なら(400,400)）が、DICOMファイル上に対応する画素の座標（一般的には256,256）からのオフセットである。
}

export const pushVolume = (seriesList: any, volume: any) => {

    seriesList.push({
        volume,
        myDicom: null,
    });

    const n = seriesList.length-1;
    const d = seriesList[n].volume!;

    const p0 = Volume.voxelToWorld(new THREE.Vector3(0,0,0),volume);
    const p1 = Volume.voxelToWorld(new THREE.Vector3(volume.nx, volume.ny, volume.nz),volume);
    p0.add(p1).divideScalar(2); // 中点

    const c = {
        clut: 0,
        myWC: 3,
        myWW: 6,
        description: "phantom",
        currentSeriesNumber: n,
        centerInWorld: p0,
        vecx: d.vectorX.clone().multiplyScalar(1),
        vecy: d.vectorY.clone().multiplyScalar(1),
        vecz: d.vectorZ.clone().multiplyScalar(1),
        isMip: false,
        mip: null,
    };

    return c;
}


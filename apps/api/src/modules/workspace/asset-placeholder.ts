import { Buffer } from 'node:buffer'

/**
 * 自有占位图：24×24 RGBA，背景 (240,240,240)，灰色 (128,128,128) 叉号。
 * 5≤x,y≤18 且 |x−y|≤1 或 |x+y−23|≤1 的像素构成叉号，alpha 均为 255。
 * 每行 PNG filter=0，zlib 压缩，只有 IHDR/IDAT/IEND，无外部素材或元数据。
 * 所有逻辑失败共用同一字节，不编码资源是否存在或故障细节。
 */
export const ASSET_PLACEHOLDER = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAXklEQVR42mP48OHDf1pihlELBqcFDQ0NYEysIfjU47WAGEsIqWUgVyOxahjIdR2xvmQgJwhICUIGUiIRHVM1mZJj+OCxgKZBRNNIpmkypWlGo3lRQfPCbrTCGV4WAAD6hi55YATgUQAAAABJRU5ErkJggg==', 'base64')

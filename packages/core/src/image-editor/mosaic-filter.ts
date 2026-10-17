/**
 * Region-based mosaic (pixelation) and box-blur filters for redacting or anonymizing
 * rectangular bounding boxes on an ImageData-like buffer.
 */

export interface MosaicRegion {
	x: number;
	y: number;
	width: number;
	height: number;
	/**
	 * When true, coordinates are interpreted as normalized values:
	 * - [0..1] when all values are <= 1
	 * - [0..1000] when any value is > 1 (e.g. Gemini 0..1000 bounding boxes)
	 */
	normalized?: boolean;
}

export interface MosaicImageDataLike {
	data: Uint8ClampedArray;
	width: number;
	height: number;
}

/**
 * Resolves a MosaicRegion to clamped integer pixel bounds [x0, y0, x1, y1] within the image dimensions.
 */
export function resolveMosaicRegionBounds(
	region: MosaicRegion,
	imgWidth: number,
	imgHeight: number
): { x0: number; y0: number; x1: number; y1: number } | null {
	if (imgWidth <= 0 || imgHeight <= 0 || region.width <= 0 || region.height <= 0) {
		return null;
	}

	let rx = region.x;
	let ry = region.y;
	let rw = region.width;
	let rh = region.height;

	const isZeroToOne =
		rx >= 0 &&
		ry >= 0 &&
		rw > 0 &&
		rh > 0 &&
		rx <= 1 &&
		ry <= 1 &&
		rw <= 1 &&
		rh <= 1 &&
		(region.normalized === true ||
			(region.normalized === undefined &&
				(imgWidth > 1 || imgHeight > 1) &&
				(!Number.isInteger(rx) || !Number.isInteger(ry) || !Number.isInteger(rw) || !Number.isInteger(rh))));

	if (isZeroToOne) {
		rx = rx * imgWidth;
		ry = ry * imgHeight;
		rw = rw * imgWidth;
		rh = rh * imgHeight;
	} else if (region.normalized === true) {
		// 0..1000 normalized coordinates
		rx = (rx / 1000) * imgWidth;
		ry = (ry / 1000) * imgHeight;
		rw = (rw / 1000) * imgWidth;
		rh = (rh / 1000) * imgHeight;
	}

	const x0 = Math.max(0, Math.min(imgWidth, Math.floor(rx)));
	const y0 = Math.max(0, Math.min(imgHeight, Math.floor(ry)));
	const x1 = Math.max(0, Math.min(imgWidth, Math.ceil(rx + rw)));
	const y1 = Math.max(0, Math.min(imgHeight, Math.ceil(ry + rh)));

	if (x1 <= x0 || y1 <= y0) return null;
	return { x0, y0, x1, y1 };
}

/**
 * Pixelates each rectangular region by averaging `blockSize x blockSize` blocks.
 * Mutates `imageData.data` in-place and returns `imageData`.
 */
export function applyRegionMosaic<T extends MosaicImageDataLike>(
	imageData: T,
	regions: MosaicRegion[],
	blockSize: number = 12
): T {
	const { data, width, height } = imageData;
	const step = Math.max(2, Math.round(blockSize));

	for (const region of regions) {
		const bounds = resolveMosaicRegionBounds(region, width, height);
		if (!bounds) continue;

		const { x0, y0, x1, y1 } = bounds;

		for (let by = y0; by < y1; by += step) {
			const bh = Math.min(step, y1 - by);
			for (let bx = x0; bx < x1; bx += step) {
				const bw = Math.min(step, x1 - bx);
				let rSum = 0;
				let gSum = 0;
				let bSum = 0;
				let aSum = 0;
				const count = bw * bh;

				for (let py = by; py < by + bh; py++) {
					const rowOffset = py * width;
					for (let px = bx; px < bx + bw; px++) {
						const idx = (rowOffset + px) * 4;
						rSum += data[idx];
						gSum += data[idx + 1];
						bSum += data[idx + 2];
						aSum += data[idx + 3];
					}
				}

				const rAvg = Math.round(rSum / count);
				const gAvg = Math.round(gSum / count);
				const bAvg = Math.round(bSum / count);
				const aAvg = Math.round(aSum / count);

				for (let py = by; py < by + bh; py++) {
					const rowOffset = py * width;
					for (let px = bx; px < bx + bw; px++) {
						const idx = (rowOffset + px) * 4;
						data[idx] = rAvg;
						data[idx + 1] = gAvg;
						data[idx + 2] = bAvg;
						data[idx + 3] = aAvg;
					}
				}
			}
		}
	}

	return imageData;
}

/**
 * Applies a separable 2-pass box blur to each rectangular region.
 * Mutates `imageData.data` in-place and returns `imageData`.
 */
export function applyRegionBlur<T extends MosaicImageDataLike>(
	imageData: T,
	regions: MosaicRegion[],
	radius: number = 10
): T {
	const { data, width, height } = imageData;
	const rad = Math.max(1, Math.min(64, Math.round(radius)));

	for (const region of regions) {
		const bounds = resolveMosaicRegionBounds(region, width, height);
		if (!bounds) continue;

		const { x0, y0, x1, y1 } = bounds;
		const rw = x1 - x0;
		const rh = y1 - y0;
		const temp = new Uint8ClampedArray(rw * rh * 4);

		// Horizontal pass into temp
		for (let y = 0; y < rh; y++) {
			const srcY = y0 + y;
			for (let x = 0; x < rw; x++) {
				let rSum = 0;
				let gSum = 0;
				let bSum = 0;
				let aSum = 0;
				let count = 0;

				const kStart = Math.max(0, x - rad);
				const kEnd = Math.min(rw - 1, x + rad);
				for (let kx = kStart; kx <= kEnd; kx++) {
					const srcIdx = (srcY * width + (x0 + kx)) * 4;
					rSum += data[srcIdx];
					gSum += data[srcIdx + 1];
					bSum += data[srcIdx + 2];
					aSum += data[srcIdx + 3];
					count++;
				}

				const dstIdx = (y * rw + x) * 4;
				temp[dstIdx] = Math.round(rSum / count);
				temp[dstIdx + 1] = Math.round(gSum / count);
				temp[dstIdx + 2] = Math.round(bSum / count);
				temp[dstIdx + 3] = Math.round(aSum / count);
			}
		}

		// Vertical pass from temp back into imageData.data
		for (let y = 0; y < rh; y++) {
			const dstY = y0 + y;
			for (let x = 0; x < rw; x++) {
				let rSum = 0;
				let gSum = 0;
				let bSum = 0;
				let aSum = 0;
				let count = 0;

				const kStart = Math.max(0, y - rad);
				const kEnd = Math.min(rh - 1, y + rad);
				for (let ky = kStart; ky <= kEnd; ky++) {
					const srcIdx = (ky * rw + x) * 4;
					rSum += temp[srcIdx];
					gSum += temp[srcIdx + 1];
					bSum += temp[srcIdx + 2];
					aSum += temp[srcIdx + 3];
					count++;
				}

				const dstIdx = (dstY * width + (x0 + x)) * 4;
				data[dstIdx] = Math.round(rSum / count);
				data[dstIdx + 1] = Math.round(gSum / count);
				data[dstIdx + 2] = Math.round(bSum / count);
				data[dstIdx + 3] = Math.round(aSum / count);
			}
		}
	}

	return imageData;
}

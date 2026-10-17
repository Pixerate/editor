import { describe, it, expect } from 'vitest';
import {
	applyRegionMosaic,
	applyRegionBlur,
	resolveMosaicRegionBounds
} from '../src/image-editor';

function createTestImage(width: number, height: number): {
	data: Uint8ClampedArray;
	width: number;
	height: number;
} {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const idx = (y * width + x) * 4;
			data[idx] = (x * 25) % 256;
			data[idx + 1] = (y * 25) % 256;
			data[idx + 2] = ((x + y) * 15) % 256;
			data[idx + 3] = 255;
		}
	}
	return { data, width, height };
}

describe('image-editor mosaic & blur filters (core)', () => {
	it('resolves pixel, 0..1 normalized, and 0..1000 normalized bounding boxes', () => {
		const pxBounds = resolveMosaicRegionBounds({ x: 10, y: 20, width: 30, height: 40 }, 100, 100);
		expect(pxBounds).toEqual({ x0: 10, y0: 20, x1: 40, y1: 60 });

		const norm01 = resolveMosaicRegionBounds(
			{ x: 0.1, y: 0.2, width: 0.5, height: 0.3, normalized: true },
			200,
			100
		);
		expect(norm01).toEqual({ x0: 20, y0: 20, x1: 120, y1: 50 });

		const norm1000 = resolveMosaicRegionBounds(
			{ x: 100, y: 250, width: 500, height: 500, normalized: true },
			200,
			100
		);
		expect(norm1000).toEqual({ x0: 20, y0: 25, x1: 120, y1: 75 });
	});

	it('pixelates target regions into uniform blocks while preserving outside pixels', () => {
		const img = createTestImage(10, 10);
		const origOutsideR = img.data[0]; // (0,0) is outside region [2,2,4,4]

		applyRegionMosaic(img, [{ x: 2, y: 2, width: 4, height: 4 }], 4);

		// Outside pixel untouched
		expect(img.data[0]).toBe(origOutsideR);

		// Inside 4x4 block [2..5, 2..5] should all share the exact averaged RGB values
		const baseIdx = (2 * 10 + 2) * 4;
		const blockR = img.data[baseIdx];
		const blockG = img.data[baseIdx + 1];
		const blockB = img.data[baseIdx + 2];

		for (let y = 2; y < 6; y++) {
			for (let x = 2; x < 6; x++) {
				const idx = (y * 10 + x) * 4;
				expect(img.data[idx]).toBe(blockR);
				expect(img.data[idx + 1]).toBe(blockG);
				expect(img.data[idx + 2]).toBe(blockB);
			}
		}
	});

	it('blurs target regions smoothly while leaving outside pixels untouched', () => {
		const img = createTestImage(12, 12);
		// Put a sharp spike at (6, 6)
		const spikeIdx = (6 * 12 + 6) * 4;
		img.data.fill(0);
		img.data[spikeIdx] = 255;
		img.data[spikeIdx + 3] = 255;
		img.data[0] = 123; // outside marker at (0,0)

		applyRegionBlur(img, [{ x: 4, y: 4, width: 5, height: 5 }], 1);

		// Outside marker untouched
		expect(img.data[0]).toBe(123);
		// Spike at (6,6) diffused to neighbors
		expect(img.data[spikeIdx]).toBeLessThan(255);
		expect(img.data[spikeIdx]).toBeGreaterThan(0);
		const neighborIdx = (6 * 12 + 5) * 4;
		expect(img.data[neighborIdx]).toBeGreaterThan(0);
	});
});

/** Slices of our native encoder's SIXEL (sixel_codec.rs), without decoding or requantizing pixels. */
const HEADER = /^(\x1bP9;1;0q"1;1;)(\d+);(\d+)((?:#\d+;2;\d+;\d+;\d+)*)/;

export interface SixelBands {
	readonly header: string;
	readonly width: number;
	readonly height: number;
	readonly palette: string;
	readonly bands: readonly string[];
}

/** Each band starts with its own palette selections and each color pass ends with `$` (carriage return). */
export function sixelBands(sequence: string): SixelBands | undefined {
	const header = HEADER.exec(sequence);
	if (!header || !sequence.endsWith("-\x1b\\")) return undefined;
	const height = Number(header[3]);
	const bands = sequence.slice(header[0].length, -3).split("-");
	if (bands.length !== Math.ceil(height / 6)) return undefined;
	return { header: header[1]!, width: Number(header[2]), height, palette: header[4]!, bands };
}

/** Truncate each color pass, including a repeat that straddles the right edge. */
function clipBand(band: string, width: number): string {
	let left = width;
	return band.replace(/\$|#\d+|!(\d+)([?-~])|[?-~]/g, (token, repeat?: string, pixel?: string) => {
		if (token === "$") {
			left = width;
			return token;
		}
		if (token.startsWith("#")) return token;
		if (left === 0) return "";
		if (repeat === undefined) {
			left--;
			return token;
		}
		const count = Math.min(left, Number(repeat));
		left -= count;
		return `!${count}${pixel}`;
	});
}

/**
 * SIXEL packs six vertical pixels into each data character. At an unaligned top, the low part of one
 * source band and the high part of the next are two transparent color passes over the same row. The
 * color selectors, repeat counts and `$` are all ASCII below `?` and survive unchanged. Drop a final
 * band that exceeds the room: some terminals allocate all six pixels despite a shorter declaration.
 */
export function sliceSixel(image: SixelBands, top: number, room: number, width = image.width): string {
	const height = Math.min(Math.floor(room / 6) * 6, image.height - top);
	if (width <= 0 || height <= 0) return "";
	const count = Math.ceil(height / 6);
	const shift = top % 6;
	const first = Math.floor(top / 6);
	const parts = [image.header, `${width};${height}`, image.palette];
	// Zellij infers the width of a transparent raster from its first pixel row, not its declaration.
	parts.push(`!${width}?$`);
	for (let i = first; i < first + count; i++) {
		const source = image.bands[i]!;
		const band = width < image.width ? clipBand(source, width) : source;
		if (shift === 0) parts.push(band);
		else {
			parts.push(band.replace(/[?-~]/g, c => String.fromCharCode(63 + ((c.charCodeAt(0) - 63) >> shift))));
			const next = image.bands[i + 1];
			const lower = next && width < image.width ? clipBand(next, width) : next;
			if (lower)
				parts.push(
					lower.replace(/[?-~]/g, c => String.fromCharCode(63 + (((c.charCodeAt(0) - 63) << (6 - shift)) & 63))),
				);
		}
		parts.push("-");
	}
	parts.push("\x1b\\");
	return parts.join("");
}

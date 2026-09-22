import * as os from "node:os";
import * as path from "node:path";

const MEDIA_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"audio/mpeg": "mp3",
	"audio/mp3": "mp3",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"video/mp4": "mp4",
	"video/quicktime": "mov",
	"video/x-matroska": "mkv",
	"video/webm": "webm",
	"video/x-m4v": "m4v",
	"video/x-msvideo": "avi",
	"video/x-ms-wmv": "wmv",
};

/** Writes each attachment under the OS temp dir and returns the absolute paths in order. */
export async function saveMediaToTemp(media: readonly { data: string; mimeType: string }[]): Promise<string[]> {
	const paths: string[] = [];
	for (const item of media) {
		const bytes = Buffer.from(item.data, "base64");
		const mime = item.mimeType.toLowerCase();
		const image = mime.startsWith("image/");
		const extension = Object.hasOwn(MEDIA_EXTENSIONS, mime) ? MEDIA_EXTENSIONS[mime] : image ? "png" : "bin";
		const filepath = path.join(os.tmpdir(), `omp-${image ? "image" : "media"}-${Bun.hash(bytes).toString(16)}.${extension}`);
		await Bun.write(filepath, bytes);
		paths.push(filepath);
	}
	return paths;
}

/** Model-facing link lines for saved images, one `Image saved: <path>` per line. */
export function imageLinkLines(paths: readonly string[]): string {
	return paths.map(filepath => `Image saved: ${filepath}`).join("\n");
}

/** Saves `images` and appends their link lines to `text`, separated from it by a newline when needed. */
export async function appendImageLinks(
	text: string,
	images: readonly { data: string; mimeType: string }[],
): Promise<string> {
	if (images.length === 0) return text;
	const lines = imageLinkLines(await saveMediaToTemp(images));
	if (text.length === 0) return lines;
	return text.endsWith("\n") ? `${text}${lines}` : `${text}\n${lines}`;
}

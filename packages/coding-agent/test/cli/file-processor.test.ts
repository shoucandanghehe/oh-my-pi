/**
 * CLI `@file` MP4 attachments retain native video bytes. Other video formats
 * keep the compact PNG preview path, including containers larger than the
 * normal text-file limit.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { processFileArguments } from "@oh-my-pi/pi-coding-agent/cli/file-processor";
import { $which, removeWithRetries } from "@oh-my-pi/pi-utils";

const hasFfmpeg = Boolean($which("ffmpeg") && $which("ffprobe"));

describe.skipIf(!hasFfmpeg)("processFileArguments video attachments", () => {
	let testDir: string;
	let videoPath: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-processor-video-"));
		videoPath = path.join(testDir, "clip.mp4");
		const process = Bun.spawn([
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc=duration=1:size=320x240:rate=30",
			"-pix_fmt",
			"yuv420p",
			"-c:v",
			"libx264",
			videoPath,
		]);
		expect(await process.exited).toBe(0);
		await fs.truncate(videoPath, 6 * 1024 * 1024);
	});

	afterEach(async () => {
		await removeWithRetries(testDir);
	});

	it("attaches native MP4 bytes rather than silently substituting a contact sheet", async () => {
		const processed = await processFileArguments([videoPath], { autoResizeImages: false });

		expect(processed.images).toHaveLength(1);
		const attachment = processed.images[0];
		expect(attachment?.type).toBe("video");
		expect(attachment?.mimeType).toBe("video/mp4");
		expect(Buffer.from(attachment.data, "base64")).toEqual(await fs.readFile(videoPath));
		expect(processed.text).not.toContain("Preview grid:");
	});

	it("attaches a preview for non-native video formats larger than the text-file limit", async () => {
		const previewPath = path.join(testDir, "clip.mov");
		await fs.copyFile(videoPath, previewPath);
		const processed = await processFileArguments([previewPath], { autoResizeImages: false });

		expect(processed.images).toHaveLength(1);
		expect(processed.images[0]?.mimeType).toBe("image/png");
		expect(processed.text).toContain("Video:");
		expect(processed.text).toContain("Preview grid: 6 frames (3x2)");
	});
});

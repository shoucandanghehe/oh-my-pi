import { expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { encodeArchive } from "@oh-my-pi/pi-utils/ar";
import * as utils from "@oh-my-pi/pi-utils";

it("reads distinct XLSX text IDs verbatim without changing numeric and boolean cells", async () => {
	const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
	const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
	const shared = ["value", "12345678901234567890", "12345678901234567891", "00123"];
	const cells = [
		'<c t="s"><v>0</v></c>',
		'<c t="s"><v>1</v></c>',
		'<c t="s"><v>2</v></c>',
		'<c t="s"><v>3</v></c>',
		'<c t="inlineStr"><is><t>0x1A</t></is></c>',
		"<c><v>42.5</v></c>",
		"<c><f>1+2</f><v>3</v></c>",
		'<c t="b"><v>1</v></c>',
		'<c t="b"><v>0</v></c>',
	];
	const bytes = await encodeArchive("zip", [
		[
			"xl/workbook.xml",
			`<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
		],
		[
			"xl/_rels/workbook.xml.rels",
			`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
		],
		["xl/sharedStrings.xml", `<sst xmlns="${ns}">${shared.map(text => `<si><t>${text}</t></si>`).join("")}</sst>`],
		[
			"xl/worksheets/sheet1.xml",
			`<worksheet xmlns="${ns}"><sheetData>${cells.map((cell, i) => `<row r="${i + 1}">${cell}</row>`).join("")}</sheetData></worksheet>`,
		],
	]);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "read-xlsx-"));
	const cacheDir = vi.spyOn(utils, "getDocumentConversionCacheDir").mockReturnValue(path.join(cwd, "cache"));
	try {
		await Bun.write(path.join(cwd, "identifiers.xlsx"), bytes);
		const result = await new ReadTool({
			cwd,
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		}).execute("read-xlsx", { path: "identifiers.xlsx:raw" });
		const text = result.content
			.filter(part => part.type === "text")
			.map(part => part.text)
			.join("\n");
		for (const value of [
			"12345678901234567890",
			"12345678901234567891",
			"00123",
			"0x1A",
			"42.5",
			"3",
			"TRUE",
			"FALSE",
		]) {
			expect(text).toContain(`| ${value} |`);
		}
	} finally {
		cacheDir.mockRestore();
		await utils.removeWithRetries(cwd);
	}
});

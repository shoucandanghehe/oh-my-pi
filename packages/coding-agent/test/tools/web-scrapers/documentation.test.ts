import { afterEach, describe, expect, it, vi } from "bun:test";
import { handleMDN } from "@oh-my-pi/pi-coding-agent/web/scrapers/mdn";
import { handleReadTheDocs } from "@oh-my-pi/pi-coding-agent/web/scrapers/readthedocs";
import * as scraperTypes from "@oh-my-pi/pi-coding-agent/web/scrapers/types";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

describe("handleReadTheDocs source provenance", () => {
	afterEach(() => vi.restoreAllMocks());

	it("renders the requested version instead of the development-branch Edit source", async () => {
		const url = "https://niquests.readthedocs.io/en/v3.18.5/user/quickstart.html";
		const sourceUrl = "https://github.com/jawah/niquests/raw/main/docs/user/quickstart.rst";
		vi.spyOn(scraperTypes, "loadPage").mockImplementation(async requestedUrl => {
			if (requestedUrl === url) {
				return {
					ok: true,
					finalUrl: url,
					contentType: "text/html",
					content: `<!doctype html><html><head>
						<meta name="readthedocs-version-slug" content="v3.18.5">
						</head><body>
						<a href="https://github.com/jawah/niquests/edit/main/docs/user/quickstart.rst">Edit on GitHub</a>
						<main><h1>Quickstart</h1><p>Use the API shipped in v3.18.5.</p></main>
						</body></html>`,
				};
			}
			if (requestedUrl === sourceUrl) {
				return {
					ok: true,
					finalUrl: sourceUrl,
					contentType: "text/plain",
					content: "Quickstart\n==========\n\nUse the unreleased development API.",
				};
			}
			throw new Error(`Unexpected URL: ${requestedUrl}`);
		});

		const result = await handleReadTheDocs(url, 20);
		expect(result?.content).toContain("# Quickstart");
		expect(result?.content).toContain("Use the API shipped in v3.18.5.");
		expect(result?.content).not.toContain("unreleased development API");
		expect(result?.finalUrl).toBe(url);
		expect(result?.contentType).toBe("text/html");
	});
});

describe.skipIf(SKIP)("handleMDN", () => {
	it("returns null for non-MDN URLs", async () => {
		const result = await handleMDN("https://example.com", 20);
		expect(result).toBeNull();
	});

	it("returns null for non-docs MDN URLs", async () => {
		const result = await handleMDN("https://developer.mozilla.org/en-US/", 20);
		expect(result).toBeNull();
	});

	it("fetches Array.map documentation", async () => {
		const result = await handleMDN(
			"https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map",
			20,
		);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("mdn");
		expect(result?.content).toContain("map");
		expect(result?.contentType).toBe("text/markdown");
	});
});

describe.skipIf(SKIP)("handleReadTheDocs", () => {
	it("fetches requests docs", async () => {
		const result = await handleReadTheDocs("https://requests.readthedocs.io/en/latest/", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("readthedocs");
	});

	it("returns null for non-readthedocs sites", async () => {
		// These sites use Sphinx/RTD theme but aren't hosted on readthedocs.io
		expect(await handleReadTheDocs("https://www.sphinx-doc.org/en/master/", 20)).toBeNull();
		expect(await handleReadTheDocs("https://docs.pytest.org/en/stable/", 20)).toBeNull();
		expect(await handleReadTheDocs("https://pip.pypa.io/en/stable/", 20)).toBeNull();
	});
});

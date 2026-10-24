/**
 * Read the Docs handler for web-fetch
 */
import { type Element, parseHTML } from "@oh-my-pi/pi-utils/dom";
import { buildResult, htmlToBasicMarkdown, loadPage, type RenderResult, type SpecialHandler } from "./types";

export const handleReadTheDocs: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	// Check if URL matches Read the Docs patterns
	const urlObj = new URL(url);
	const isReadTheDocs =
		urlObj.hostname.endsWith(".readthedocs.io") ||
		urlObj.hostname === "readthedocs.org" ||
		urlObj.hostname === "www.readthedocs.org";

	if (!isReadTheDocs) {
		return null;
	}

	const notes: string[] = [];
	const fetchedAt = new Date().toISOString();

	// Fetch the page
	const result = await loadPage(url, { timeout, signal });
	if (!result.ok) {
		return {
			url,
			finalUrl: result.finalUrl,
			contentType: result.contentType,
			method: "readthedocs",
			content: `Failed to fetch Read the Docs page (status: ${result.status ?? "unknown"})`,
			fetchedAt,
			truncated: false,
			notes,
		};
	}

	// Parse HTML
	const root = parseHTML(result.content).document;

	// Extract main content from common Read the Docs selectors
	let mainContent =
		root.querySelector(".document") ||
		root.querySelector('[role="main"]') ||
		root.querySelector("main") ||
		root.querySelector(".rst-content") ||
		root.querySelector(".body");

	if (!mainContent) {
		// Fallback to body if no main content found
		mainContent = root.querySelector("body");
		notes.push("Using full body content (no main content div found)");
	}

	// Remove navigation, sidebar, footer elements
	mainContent
		?.querySelectorAll(
			".headerlink, .viewcode-link, nav, .sidebar, footer, .related, .sphinxsidebar, .toctree-wrapper",
		)
		.forEach((el: Element) => {
			el.remove();
		});

	let content = mainContent ? await htmlToBasicMarkdown(mainContent.innerHTML) : "";

	if (!content) {
		content = "No content extracted from Read the Docs page";
		notes.push("Failed to extract content");
	}

	return buildResult(content, {
		url,
		finalUrl: result.finalUrl,
		method: "readthedocs",
		fetchedAt,
		notes,
		contentType: result.contentType,
	});
};

/**
 * Shared helpers for the tools: the image-content schema for tool `structuredContent` outputs and
 * PDF → markdown extraction. Pi exports no runtime schema of its own (the built-in read tool
 * hand-rolls an equivalent, module-private union), so this is the one shared definition.
 */
import { extractPagesMarkdown } from '@firecrawl/pdf-inspector';
import { Type } from 'typebox';
import type { Buffer } from 'node:buffer';

/** Image content object: base64 data with its MIME type, tagged `type: 'image'`. */
export const imageObject = Type.Object(
	{
		data: Type.String({ description: 'Base64-encoded image data' }),
		mimeType: Type.String({ description: 'Image MIME type' }),
		type: Type.Literal('image'),
	},
	{ description: 'Image content object: base64 data with its MIME type' },
);

/** Extract a PDF buffer to markdown (all pages). */
export function pdfToMarkdown(buffer: Buffer): string {
	return extractPagesMarkdown(buffer)
		.pages.map((page) => page.markdown)
		.join('\n\n');
}

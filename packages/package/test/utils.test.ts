import { makePdf } from './utils';
import { pdfToMarkdown } from '@/tools/utils.ts';
import { test, expect } from 'bun:test';

test('pdfToMarkdown extracts text from a PDF buffer', () => {
	const md = pdfToMarkdown(makePdf('Extracted Text'));
	expect(md.toLowerCase()).toContain('extracted');
});

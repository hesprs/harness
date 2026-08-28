/**
 * Built-in tool activations: reuse Pi's own tools instead of replacing them.
 */
import type { Extension } from '@repo/shared/contract';
import { activate } from './common.ts';

export const toolWrite: Extension = (pi) => {
	activate(pi, 'write');
};

export const toolBash: Extension = (pi) => {
	activate(pi, 'bash');
};

export const toolFind: Extension = (pi) => {
	activate(pi, 'find');
};

export const toolGrep: Extension = (pi) => {
	activate(pi, 'grep');
};

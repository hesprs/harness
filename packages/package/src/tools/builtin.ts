/* Built-in tool activations: reuse Pi's own tools instead of replacing them. */
import type { CodemodeExtensionOptions } from '@earendil-works/pi-coding-agent';
import type { Extension } from '@repo/shared/contract';
import { createCodemodeExtension, isToolCallEventType } from '@earendil-works/pi-coding-agent';
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

const PYTHON_INLINE_RE = /\bpython3?\s+-c\b/u;

export function toolCodemode(config?: CodemodeExtensionOptions): Extension {
	return (pi) => {
		void createCodemodeExtension(config)(pi);
		activate(pi, 'codemode');
		pi.on('tool_call', (event) => {
			if (!isToolCallEventType('bash', event)) return;
			if (PYTHON_INLINE_RE.test(event.input.command))
				return {
					block: true,
					reason: 'Python inline script is inefficient. Use the `codemode` tool instead.',
				};
		});
	};
}

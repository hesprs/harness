import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Extension } from '@repo/shared/contract';

function activate(pi: ExtensionAPI, name: string): void {
	pi.setActiveTools([...pi.getActiveTools(), name]);
}

export const toolWrite: Extension = (pi) => activate(pi, 'write');
export const toolBash: Extension = (pi) => activate(pi, 'bash');
export const toolFind: Extension = (pi) => activate(pi, 'find');
export const toolGrep: Extension = (pi) => activate(pi, 'grep');
export const toolCodemode: Extension = (pi) => activate(pi, 'codemode');

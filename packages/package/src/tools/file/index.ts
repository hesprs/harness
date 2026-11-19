import { applyPatchTool } from './apply-patch.ts';
import { deleteTool, editTool } from './edit-write-delete.ts';
/**
 * ToolFile: the one file-editing extension. Registers Pi's built-in `write` (switched on by name),
 * the fuzzy `edit` (which overrides Pi's built-in editor), `delete`, and `apply_patch`, then keeps
 * exactly one editing toolset active per model, like upstream pi-apply-patch: GPT models on the
 * OpenAI Responses APIs get apply_patch only; every other model gets write, edit, and delete.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Extension } from '@repo/shared/contract';

/** The model fields the GPT check reads; every pi Model satisfies this structurally. */
export type FileToolModel = { api?: string; id: string; provider: string };

const GPT_FILE_TOOL_PROVIDERS = new Set([
	'openai',
	'openai-codex',
	'azure-openai-responses',
	'github-copilot',
]);
const GPT_FILE_TOOL_APIS = new Set(['openai-responses', 'openai-codex-responses']);
const APPLY_PATCH_TOOL_NAME = 'apply_patch';
const EDIT_TOOL_NAMES = ['write', 'edit', 'delete'];

export function isOpenAIGptModel(model: FileToolModel | undefined): boolean {
	if (!model?.id.startsWith('gpt-')) return false;

	return (
		GPT_FILE_TOOL_PROVIDERS.has(model.provider) ||
		(model.api !== undefined && GPT_FILE_TOOL_APIS.has(model.api))
	);
}

function withoutManagedTools(toolNames: Array<string>): Array<string> {
	return toolNames.filter(
		(toolName) => toolName !== APPLY_PATCH_TOOL_NAME && !EDIT_TOOL_NAMES.includes(toolName),
	);
}

function replaceEditToolsWithApplyPatch(toolNames: Array<string>): Array<string> {
	return [...withoutManagedTools(toolNames), APPLY_PATCH_TOOL_NAME];
}

function replaceApplyPatchWithEditTools(toolNames: Array<string>): Array<string> {
	return [...withoutManagedTools(toolNames), ...EDIT_TOOL_NAMES];
}

function syncToolset(
	pi: Pick<ExtensionAPI, 'getActiveTools' | 'setActiveTools'>,
	model: FileToolModel | undefined,
): void {
	const currentToolNames = pi.getActiveTools();
	if (isOpenAIGptModel(model))
		pi.setActiveTools(replaceEditToolsWithApplyPatch(currentToolNames));
	else pi.setActiveTools(replaceApplyPatchWithEditTools(currentToolNames));
}

// Extension that registers the four tools and swaps the active toolset per model.
export const toolFile: Extension = (pi) => {
	pi.registerTool(applyPatchTool);
	pi.registerTool(editTool);
	pi.registerTool(deleteTool);

	pi.on('session_start', (_event, ctx) => {
		syncToolset(pi, ctx.model);
	});

	pi.on('model_select', (event) => {
		syncToolset(pi, event.model);
	});

	pi.on('before_agent_start', (_event, ctx) => {
		syncToolset(pi, ctx.model);
	});
};

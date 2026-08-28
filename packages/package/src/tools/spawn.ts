import type { Extension } from '@repo/shared/contract';
/**
 * Spawn tool: creates colleague/child agent sessions through the in-process
 * controller operations. The spawning agent must supply the new session's
 * starting prompt — delivered as the spawner's first talk to the new agent,
 * kicking off its first turn the way a human user's opening prompt starts a
 * session. A catalog of the allowed spawnable agents (descriptions resolved
 * from the global agent registry) is appended to the agent's system
 * instruction so it knows what it can spawn.
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { kernel, LEADER_ID } from '@repo/shared/contract';
import { errText, text } from '@repo/shared/text';
import { Type } from 'typebox';
import registry from '@/registry.ts';
import { registerActive } from './common.ts';

/** Catalog of the allowed agents. Descriptions come from the global registry. */
function spawnCatalog(agents: Array<string>): string {
	const entries = agents
		.map((name) => ({ description: registry.get(name)?.description, name }))
		.filter((entry) => entry.description !== undefined);
	if (entries.length === 0) return '';
	return `## Spawnable Agents\n\n${entries
		.map((entry) => `- \`${entry.name}\`: ${entry.description}`)
		.join('\n')}`;
}

// Extension factory to give the agent spawn tool: spawn a new colleague or child among the allowed agent names, each started from a required prompt.
export default function toolSpawn(agents: Array<string>): Extension {
	return (pi) => {
		// Appended every turn: the base system prompt is rebuilt per turn, so this never duplicates.
		pi.on('before_agent_start', (event) => {
			const catalog = spawnCatalog(agents);
			if (catalog === '') return;
			return { systemPrompt: `${event.systemPrompt}\n\n${catalog}` };
		});
		registerActive(
			pi,
			defineTool({
				description:
					'Spawn a new agent session and start it with a prompt, like a human user prompting an agent to start a session. Returns the session ID and record file path. Optionally choose a markdown topic context file.',
				// oxlint-disable-next-line eslint/max-params : fixed five-parameter execute signature from pi's ToolDefinition
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					if (!agents.includes(params.agent))
						return text(
							`unknown agent: ${params.agent}; allowed: ${agents.join(', ')}`,
							true,
						);

					const k = kernel();
					try {
						const from =
							k.bindingOf(ctx.sessionManager.getSessionId())?.sessionId ?? LEADER_ID;
						const result = await k.spawn(from, params.agent, params.topic);
						// The starting prompt: the spawner's talk starts the new agent's first turn.
						await k.deliverTalk(from, result.sessionId, params.prompt);
						return text(JSON.stringify(result));
					} catch (error) {
						return text(errText(error), true);
					}
				},
				label: 'Spawn',
				name: 'spawn',
				parameters: Type.Object({
					agent: Type.String({ description: 'Agent name to spawn' }),
					prompt: Type.String({
						description: 'Starting prompt for the new agent session',
					}),
					topic: Type.Optional(
						Type.String({ description: 'Markdown topic context file path' }),
					),
				}),
			}),
		);
	};
}

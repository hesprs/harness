import { defineTool } from '@earendil-works/pi-coding-agent';
import { kernel, LEADER_ID } from '@repo/shared/contract';
import { errText, text } from '@repo/shared/text';
import { Type } from 'typebox';
/**
 * Spawn tool: creates colleague/child agent sessions through the in-process controller operations.
 * The spawning agent must supply the new session's starting prompt — delivered as the spawner's
 * first talk to the new agent, kicking off its first turn the way a human user's opening prompt
 * starts a session. A catalog of the allowed spawnable agents (descriptions resolved from the
 * global agent registry) is appended to the agent's system instruction so it knows what it can
 * spawn.
 */
import type { Extension } from '@repo/shared/contract';

/** Catalog of the allowed agents. Descriptions come from the kernel registry. */
function spawnCatalog(agents: Array<string>): string {
	const entries = agents
		.map((name) => ({ description: kernel().get(name)?.description, name }))
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
		pi.registerTool(
			defineTool({
				description:
					'Spawn a new agent session and start it with a prompt, like a human user prompting an agent to start a session. Returns the session ID and record file path. Optionally choose a markdown topic context file.',
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
						return { ...text(JSON.stringify(result)), structuredContent: result };
					} catch (error) {
						return text(errText(error), true);
					}
				},
				label: 'Spawn',
				name: 'spawn',
				outputSchema: Type.Object({
					recordPath: Type.String({ description: 'Session record file path' }),
					sessionId: Type.String({ description: 'The new session ID' }),
				}),
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

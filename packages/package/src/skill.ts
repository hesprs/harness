/**
 * Skill extension: expose a SKILL.md file to the agent.
 */
import type { Extension } from '@repo/shared/contract';

export default function skill(path: string | Array<string>): Extension {
	return (pi) => {
		pi.on('resources_discover', () => ({
			skillPaths: typeof path === 'string' ? [path] : path,
		}));
	};
}

/**
 * Parse Task tool output to recover a session/task ID for resumption.
 */

export default function parseTaskIdFromTaskOutput(output: string): string | undefined {
	const lines = output.split(/\r?\n/);

	for (const line of lines) {
		const trimmed = line.trim();
		const match = /^<task\b[^>]*\bid="(?<taskId>[^"]+)"[^>]*>$/i.exec(trimmed);

		if (!match) continue;

		return match.groups?.taskId;
	}

	for (const line of lines) {
		const trimmed = line.trim();
		const match = /^task_id:\s*(?<taskId>[^\s()]+)(?:\s*\(.*)?$/.exec(trimmed);

		if (!match) continue;

		return match.groups?.taskId;
	}

	return undefined;
}

export { parseTaskIdFromTaskOutput };

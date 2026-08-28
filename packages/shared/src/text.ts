export function text(body: string, isError = false) {
	return {
		content: [{ text: body, type: 'text' } as const],
		details: undefined,
		...(isError ? { isError } : {}),
	};
}

/** Message of a caught value. */
export function errText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

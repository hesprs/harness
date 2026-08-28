import { LEADER_ID } from '@repo/shared/contract';
import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Agents, { registry } from '@/Agents';
import Prompt from '@/Prompt';
import Sessions from '@/Sessions';

const baseCtx = {
	agent: 'coder',
	appFolder: '/app/123',
	canEditNote: false,
	cwd: '/w',
	now: new Date('2025-01-02T03:04:05Z'),
	sessionId: 's-1',
	systemPrompt: '',
};

test('render orders sections by priority, renders titles, skips empty ones', async () => {
	const prompt = new Prompt();
	prompt.root.registerSection({ priority: 300, render: async () => {} });
	prompt.root.registerSection({
		priority: 200,
		render: (ctx) => `second sees ${ctx.sessionId}`,
		title: 'Second',
	});
	prompt.root.registerSection({ priority: 100, render: () => 'first' });
	expect(await prompt.root.render(baseCtx)).toBe('first\n\n## Second\n\nsecond sees s-1');
});

test('sections with equal priority keep registration order; bodies may be multi-line', async () => {
	const prompt = new Prompt();
	prompt.root.registerSection({
		priority: 100,
		render: () => 'line one\nline two',
		title: 'Body',
	});
	prompt.root.registerSection({ priority: 100, render: () => 'tail' });
	expect(await prompt.root.render(baseCtx)).toBe('## Body\n\nline one\nline two\n\ntail');
});

test('composition: Sessions and Agents sections render a full agent prompt', async () => {
	const root = mkdtempSync(join(tmpdir(), 'harness-prompt-'));
	try {
		registry.setScope('user');
		registry.defineAgent({
			description: 'writes code',
			name: 'coder',
			prompt: 'Be terse.',
		});
		const prompt = new Prompt();
		const sessions = new Sessions({ registerSection: prompt.root.registerSection });
		const agents = new Agents({ registerSection: prompt.root.registerSection });
		void agents;
		await sessions.root.beginAppSession(root);
		const binding = await sessions.root.registerViewing({
			agent: 'coder',
			piSessionId: 'pi-1',
		});
		await Bun.write(join(binding.appFolder, `${binding.sessionId}.md`), 'my todo');

		const out = await prompt.root.render({
			...baseCtx,
			appFolder: binding.appFolder,
			canEditNote: true,
			lastInvocation: new Date('2025-01-02T03:02:45Z'),
			sessionId: binding.sessionId,
		});
		expect(out).toContain('2025-01-02T03:04:05'); // Identity: current date
		expect(out).toContain('80 seconds'); // Identity: time since last invocation
		expect(out).toContain(binding.appFolder);
		expect(out).toContain(binding.sessionId);
		expect(out).toContain('## Personal Note');
		expect(out).toContain('my todo');
		expect(out).toContain('edit'); // Note-editing instruction when canEditNote
		expect(out).toContain('## Instructions');
		expect(out).toContain('Be terse.');
		expect(out).toContain('## Other Agents (Talkable)');
		expect(out).toContain(LEADER_ID);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('topic section renders path and content when the session belongs to a topic', async () => {
	const root = mkdtempSync(join(tmpdir(), 'harness-prompt-topic-'));
	try {
		const prompt = new Prompt();
		const sessions = new Sessions({ registerSection: prompt.root.registerSection });
		const topic = join(root, 'topic.md');
		await Bun.write(topic, '# The Plan');
		await sessions.root.beginAppSession(root);
		const binding = await sessions.root.registerViewing({
			agent: 'coder',
			piSessionId: 'pi-1',
			topic,
		});
		const out = await prompt.root.render({
			...baseCtx,
			appFolder: binding.appFolder,
			sessionId: binding.sessionId,
			topicPath: topic,
		});
		expect(out).toContain(`Topic: \`${topic}\``);
		expect(out).toContain('## Topic Context');
		expect(out).toContain('# The Plan');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('the skills section lifts the available_skills block from the pi system prompt', async () => {
	const block = `<available_skills>
  <skill>
    <name>my-skill</name>
    <description>does things</description>
    <location>/skills/my-skill/SKILL.md</location>
  </skill>
</available_skills>`;
	const prompt = new Prompt();
	const out = await prompt.root.render({
		...baseCtx,
		systemPrompt: `irrelevant
${block}
irrelevant`,
	});
	expect(out).toBe(`## Skills\n\n${block}`);

	const without = await prompt.root.render({ ...baseCtx, systemPrompt: 'no skills here' });
	expect(without).toBe('');
});

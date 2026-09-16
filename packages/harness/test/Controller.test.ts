import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionManager,
} from '@earendil-works/pi-coding-agent';
import { Markdown } from '@earendil-works/pi-tui';
import { LEADER_ID } from '@repo/shared/contract';
import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppMeta, SessionRecord } from '@/model';
import type { TuiInternals } from '@/patch';
import type Session from '@/Session';
import Controller, { decodeTalk, encodeTalk, formatTalkNotice, relationship } from '@/Controller';
import { createAppSession, registerSession } from '@/model';
import { announceAdoption, ensureStreamingComponent } from '@/patch';
import Sessions from '@/Sessions';

const agentDir = join(homedir(), '.pi', 'agent');

function makePi() {
	const appended: Array<{ customType: string; data: unknown }> = [];
	const commands = new Map<string, (args: string | undefined, ctx: unknown) => Promise<void>>();
	const renderers = new Map<string, (message: { content: string }) => unknown>();
	const entryRenderers = new Map<string, (entry: { data?: unknown }) => unknown>();
	const pi = {
		appendEntry: (customType: string, data?: unknown) => {
			appended.push({ customType, data });
		},
		registerCommand: (
			name: string,
			options: { handler: (args: string | undefined, ctx: unknown) => Promise<void> },
		) => {
			commands.set(name, options.handler);
		},
		registerEntryRenderer: (type: string, render: (entry: { data?: unknown }) => unknown) => {
			entryRenderers.set(type, render);
		},
		registerMessageRenderer: (
			type: string,
			render: (message: { content: string }) => unknown,
		) => {
			renderers.set(type, render);
		},
	};
	return {
		appended,
		commands,
		entryRenderers,
		pi: pi as unknown as ExtensionAPI,
		renderers,
	};
}

/** A session stand-in recording deliveries and info. */
function fakeSession(description = 'session description') {
	const delivered: Array<{ from: string; rel: string; message: string }> = [];
	const session = {
		deliver: (from: string, rel: string, message: string) => {
			delivered.push({ from, message, rel });
		},
		detachLive: () => {},
		info: (base: string) => `${base}\n${description}`,
	};
	return { delivered, session: session as unknown as Session };
}

type AddOpts = { parent?: string; topic?: string; leader?: string };

async function setup() {
	const root = mkdtempSync(join(tmpdir(), 'harness-controller-'));
	const app = await createAppSession(root);
	const sessions = new Sessions();
	sessions.root.activate(app);
	const bound = new Map<string, Session>();
	const { appended, commands, entryRenderers, pi, renderers } = makePi();
	const { delivered, session: fake } = fakeSession();
	bound.set('A', fake);
	const controller = new Controller({
		...sessions.root,
		defaultAgent: () => Promise.resolve('coder'),
		ensureLive: (id: string) => {
			const session = bound.get(id);
			if (session === undefined) return Promise.reject(new Error(`unknown session: ${id}`));
			return Promise.resolve(session);
		},
		get: (name: string) => (name === 'coder' ? { description: 'writes code' } : undefined),
		names: () => ['coder'],
		rememberDefault: () => Promise.resolve(),
		sessionOf: (id: string) => bound.get(id),
	});
	const notified: Array<string> = [];
	controller.root.registerSurface(pi);
	controller.root.attachSession(pi, { ui: { notify: (m) => notified.push(m) } });
	function addSession(id: string, opts?: AddOpts): SessionRecord {
		let record: SessionRecord | undefined;
		sessions.root.mutateMeta((meta: AppMeta) => {
			record = registerSession(meta, {
				agent: 'coder',
				recordPath: join(app.appFolder, `${id}.jsonl`),
				sessionId: id,
				spawnerId: opts?.parent ?? LEADER_ID,
				...(opts?.topic === undefined ? {} : { topic: opts.topic }),
			});
			if (opts?.leader !== undefined) {
				const r = meta.sessions[id];
				if (r !== undefined) r.leaderSessionId = opts.leader;
			}
		});
		return record as SessionRecord;
	}
	return {
		addSession,
		appFolder: app.appFolder,
		appended,
		bound,
		commands,
		controller,
		delivered,
		entryRenderers,
		notified,
		renderers,
		root,
		sessions,
	};
}

test('registerSurface registers commands and the talk renderer at factory time', async () => {
	const { commands, renderers, entryRenderers } = await setup();
	expect([...commands.keys()].sort()).toEqual(['apps', 'shift', 'talks']);
	const render = renderers.get('talk');
	expect(render).toBeDefined();
	const component = render?.({
		content: JSON.stringify({ from: 'A', message: 'hi', relationship: 'child' }),
	});
	expect(component).toBeInstanceOf(Markdown);
	const renderEntry = entryRenderers.get('talk');
	expect(renderEntry).toBeDefined();
	const entryComponent = renderEntry?.({
		data: { at: '', from: 'A', message: 'hi', relationship: 'child' },
	});
	expect(entryComponent).toBeInstanceOf(Markdown);
});

test('talk to the leader records a leader talk and notifies', async () => {
	const { addSession, controller, notified, root, sessions } = await setup();
	try {
		addSession('A');
		await controller.root.deliverTalk('A', LEADER_ID, 'hello');
		const talks = sessions.root.meta().leaderTalks;
		expect(talks?.[0]?.from).toBe('A');
		expect(talks?.[0]?.message).toBe('hello');
		expect(talks?.[0]?.relationship).toBe('child');
		expect(notified[0]).toBe('`A`: hello');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('talk to a session routes through ensureLive into the session', async () => {
	const { addSession, bound, controller, root } = await setup();
	try {
		addSession('B');
		const { delivered: targetDelivered, session: target } = fakeSession('b');
		bound.set('B', target);
		await controller.root.deliverTalk(LEADER_ID, 'B', 'do it');
		expect(targetDelivered).toEqual([{ from: LEADER_ID, message: 'do it', rel: 'leader' }]);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('talk to an unknown session throws', async () => {
	const { controller, root } = await setup();
	try {
		// oxlint-disable-next-line typescript/await-thenable
		await expect(controller.root.deliverTalk(LEADER_ID, 'ghost', 'hi')).rejects.toThrow(
			'unknown session',
		);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('formatLeaderTalk addresses the viewed session from the leader', async () => {
	const { addSession, controller, root } = await setup();
	try {
		addSession('A');
		const text = controller.root.formatLeaderTalk('A', 'hello');
		expect(text).toBe('[talk from `commander-00001` (leader)] hello');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('talkableFor renders roster entries as agent-wrapped text with live info dispatched', async () => {
	const { addSession, bound, controller, root } = await setup();
	try {
		addSession('A', { parent: LEADER_ID });
		addSession('B', { parent: LEADER_ID });
		const { session } = fakeSession('live description');
		bound.set('B', session);
		const entries = controller.root.talkableFor('A');
		expect(entries.every((e) => e.startsWith('<agent>\n') && e.endsWith('\n</agent>'))).toBe(
			true,
		);
		// B is live: its content passed through session.info and was extended.
		const b = entries.find((e) => e.includes('<id>B</id>'));
		expect(b).toContain('<relation>colleague</relation>');
		expect(b).toContain('live description');
		// No <type> element anymore.
		expect(entries.join('\n')).not.toContain('<type>');
		// The leader entry is fixed.
		const leader = entries.find((e) => e.includes(`<id>${LEADER_ID}</id>`));
		expect(leader).toContain('<relation>leader</relation>');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('/shift new arms the picked agent, remembers it and swaps to a fresh session', async () => {
	const root = mkdtempSync(join(tmpdir(), 'harness-controller-shift-'));
	try {
		const app = await createAppSession(root);
		const sessions = new Sessions();
		sessions.root.activate(app);
		const remembered: Array<string> = [];
		const armed: Array<string> = [];
		const calls: Array<string> = [];
		const { commands, pi } = makePi();
		const controller = new Controller({
			...sessions.root,
			armPending: (agent: string) => {
				armed.push(agent);
			},
			defaultAgent: () => Promise.resolve('coder'),
			get: () => {},
			names: () => ['coder', 'writer'],
			rememberDefault: (agent: string) => {
				remembered.push(agent);
				return Promise.resolve();
			},
		});
		controller.root.registerSurface(pi);
		controller.root.attachSession(pi, { ui: { notify: () => {} } });
		await commands.get('shift')?.(undefined, {
			cwd: root,
			newSession: () => {
				calls.push('newSession');
				return Promise.resolve();
			},
			// First select: session list (only 'new'); second: the agent names.
			ui: {
				select: (_title: string, options: Array<string>) => Promise.resolve(options.at(-1)),
			},
		});
		expect(armed).toEqual(['writer']);
		expect(remembered).toEqual(['writer']);
		expect(calls).toEqual(['newSession']);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('/talks replays stored leader talks into the waterfall as UI-only entries', async () => {
	const { appended, commands, root, sessions } = await setup();
	try {
		sessions.root.mutateMeta((m) => {
			(m.leaderTalks ??= []).push({
				at: new Date().toISOString(),
				from: 'A',
				message: 'ping',
				relationship: 'child',
			});
		});
		await commands.get('talks')?.(undefined, {});
		expect(appended).toEqual([
			{
				customType: 'talk',
				data: {
					at: expect.any(String) as string,
					from: 'A',
					message: 'ping',
					relationship: 'child',
				},
			},
		]);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

function metaWith(...records: Array<Partial<SessionRecord> & { id: string }>): AppMeta {
	const base = { agent: 'default', createdAt: '', recordPath: '', status: 'running' } as const;
	return {
		appFolder: '/app',
		appSessionId: 'app',
		sessions: Object.fromEntries(records.map((r) => [r.id, { ...base, ...r }])),
	};
}

test('relationship: topic members, leader and children', () => {
	const meta = metaWith(
		{ id: 'A', leaderSessionId: LEADER_ID, topic: '/t.md' },
		{ id: 'B', leaderSessionId: LEADER_ID, topic: '/t.md' },
		{ id: 'C', parentSessionId: LEADER_ID },
		{ id: 'D', parentSessionId: LEADER_ID },
	);
	expect(relationship(meta, 'A', LEADER_ID)).toBe('leader');
	expect(relationship(meta, LEADER_ID, 'A')).toBe('child');
	expect(relationship(meta, 'A', 'B')).toBe('colleague');
	expect(relationship(meta, 'C', 'D')).toBe('colleague');
	expect(relationship(meta, 'A', 'C')).toBeUndefined();
});

test('formatTalkNotice and encode/decodeTalk round-trip', () => {
	expect(formatTalkNotice('A', 'colleague', 'hello')).toBe('[talk from `A` (colleague)] hello');
	const encoded = encodeTalk('A', 'child', 'hi');
	expect(encoded.customType).toBe('talk');
	expect(decodeTalk(encoded.content)).toEqual({
		from: 'A',
		message: 'hi',
		relationship: 'child',
	});
});

/** Sessions/Agents root stub for tests that only exercise the handoff patches. */
const unusedRoot = {
	activate: () => {},
	appFolder: () => {},
	armPending: () => {},
	beginAppSession: () => Promise.resolve(),
	defaultAgent: () => Promise.resolve(),
	ensureLive: () => Promise.reject(new Error('unused')),
	get: () => {},
	meta: () => Promise.reject(new Error('unused')),
	mutateMeta: () => Promise.reject(new Error('unused')),
	names: () => [] as Array<string>,
	putLive: () => {},
	rememberDefault: () => Promise.resolve(),
	reset: () => {},
	sessionOf: () => {},
	takeLive: () => {},
	viewing: () => {},
} as unknown as ConstructorParameters<typeof Controller>[0];

test('a shielded session survives dispose and is captured once', async () => {
	const root = mkdtempSync(join(tmpdir(), 'harness-handoff-'));
	try {
		const { session } = await createAgentSession({
			sessionManager: SessionManager.create(process.cwd(), root),
		});
		const controller = new Controller(unusedRoot);
		controller.root.shield(session.sessionManager.getSessionFile() as string);
		session.dispose();
		expect(controller.root.takeShielded()).toBe(session);
		expect(controller.root.takeShielded()).toBeUndefined();
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('switchSession hosts a live session offered for adoption', async () => {
	const root = mkdtempSync(join(tmpdir(), 'harness-handoff-'));
	try {
		// The live "background agent" on a record file.
		const { session: live } = await createAgentSession({
			sessionManager: SessionManager.create(process.cwd(), root),
		});
		const recordPath = live.sessionManager.getSessionFile() as string;

		// A runtime host with its own initial session.
		let factoryRuns = 0;
		const runtime = await createAgentSessionRuntime(
			async ({ sessionManager }) => {
				factoryRuns++;
				const services = await createAgentSessionServices({
					agentDir,
					cwd: process.cwd(),
				});
				return {
					...(await createAgentSessionFromServices({ services, sessionManager })),
					diagnostics: [],
					services,
				};
			},
			{
				agentDir,
				cwd: process.cwd(),
				sessionManager: SessionManager.create(process.cwd(), join(root, 'host')),
			},
		);
		const controller = new Controller(unusedRoot);
		controller.root.offerAdoption(recordPath, live);
		const events: Array<string> = [];
		live.subscribe((event) => events.push(event.type));
		Object.defineProperty(live, 'isStreaming', { value: true });
		await runtime.switchSession(recordPath);
		expect(runtime.session).toBe(live);
		expect(factoryRuns).toBe(1); // Initial only: the switch adopted, no rebuild
		expect(events).toContain('agent_start'); // The indicator trigger replays
		await runtime.dispose();
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('displacing a shielded session settles its pending prompt', async () => {
	const controller = new Controller(unusedRoot); // Installs the patches
	const root = mkdtempSync(join(tmpdir(), 'harness-displace-'));
	try {
		const { session } = await createAgentSession({
			sessionManager: SessionManager.create(process.cwd(), root),
		});
		// Hold the turn at the model boundary: no real model call.
		const host = session as unknown as {
			// oxlint-disable-next-line eslint/no-underscore-dangle : pi's private field names
			_modelRuntime: { hasConfiguredAuth: (provider: string) => boolean };
			// oxlint-disable-next-line eslint/no-underscore-dangle : pi's private field name
			_runAgentPrompt: (messages: unknown) => Promise<void>;
			agent: { state: { model: { provider: string; id: string } } };
		};
		// oxlint-disable-next-line eslint/no-underscore-dangle : pi's private field name
		host._modelRuntime = { hasConfiguredAuth: () => true };
		host.agent.state.model = { id: 'stub', provider: 'stub' };
		let turnStarted = false;
		// oxlint-disable-next-line eslint/no-underscore-dangle : pi's private field name
		host._runAgentPrompt = () => {
			turnStarted = true;
			return new Promise<void>(() => {}); // Holds the turn forever
		};

		const pending = session.prompt('hold');
		await new Promise((resume) => {
			setTimeout(resume, 20);
		});
		expect(turnStarted).toBe(true); // The turn is genuinely in flight
		controller.root.shield(session.sessionManager.getSessionFile() as string);
		await session.abort(); // Shielded: the no-op abort displaces the session
		await pending; // The TUI main loop's gate releases before the turn ends
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('announceAdoption replays agent_start only for streaming sessions', () => {
	const emitted: Array<unknown> = [];
	const make = (isStreaming: boolean) =>
		({ _emit: (event: unknown) => emitted.push(event), isStreaming }) as never;
	announceAdoption(make(false));
	expect(emitted).toHaveLength(0);
	announceAdoption(make(true));
	expect(emitted).toEqual([{ type: 'agent_start' }]);
});

test('ensureStreamingComponent rebuilds the streaming view once', () => {
	const added: Array<unknown> = [];
	const tui = {
		chatContainer: { addChild: (child: unknown) => added.push(child) },
		getMarkdownThemeWithSettings: () => {},
		getMarkdownTransformers: () => [],
		hiddenThinkingLabel: 'Thinking',
		hideThinkingBlock: false,
		outputPad: 1,
		streamingComponent: undefined,
		streamingMessage: undefined,
	} as TuiInternals;
	const message: Parameters<typeof ensureStreamingComponent>[1] = { content: [] } as never;
	ensureStreamingComponent(tui, message);
	expect(tui.streamingComponent).toBeDefined();
	expect(tui.streamingMessage).toBe(message);
	expect(added).toHaveLength(1);
	ensureStreamingComponent(tui, { content: [] } as never);
	expect(added).toHaveLength(1); // Already present: no second component
});

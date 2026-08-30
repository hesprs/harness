/**
 * Framework entry (Pi extension): the kernel loader plus the host adapter.
 * One SynthKernel context per controller process, stashed on globalThis so
 * every module instance — the controller extension, background SDK session
 * extensions — shares one kernel.
 *
 * Module order matters: Prompt first (owns prompt construction and the
 * skills section), Controller last (consumes all roots).
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { KernelContract } from '@repo/shared/contract';
import type { Context as KernelContext } from 'synthkernel';
import { createContext } from 'synthkernel';
import Agents from '@/Agents';
import bootstrap from '@/bootstrap';
import Controller from '@/Controller';
import Prompt from '@/Prompt';
import Sessions from '@/Sessions';

const allModules = [Prompt, Agents, Sessions, Controller] as const;
export type Kernel = KernelContext<typeof allModules, 'root'>;

// oxlint-disable-next-line no-unused-vars : Compile-time guarantee: the kernel satisfies the published tools' contract.
type CompileGuard = Matcher<KernelContract>;
type Matcher<T extends KernelContract> = T;

/** One bootstrap for every live session: the controller's interactive session
 * (where the viewed agent runs natively) plus every background SDK session. */
export default function harness(pi: ExtensionAPI): void {
	const shared = globalThis as { harnessKernel?: Kernel };
	shared.harnessKernel ??= createContext(allModules, { mergeKeys: ['root'], preMerge: { pi } });
	bootstrap(pi, shared.harnessKernel);
}

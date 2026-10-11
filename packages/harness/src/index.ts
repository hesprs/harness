/** Framework entry (Pi extension). One SynthKernel context per controller process, stashed on globalThis so every module instance — the controller extension, background SDK session extensions — shares one kernel.
 * Module order matters: Agents first (definitions), Sessions second (the session world), Controller last (consumes both). Each session's glue — identity, prompt, tools — belongs to its own Session instance, one per Pi session runner. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { KernelContract } from '@repo/shared/contract';
import type { Context as KernelContext } from 'synthkernel';
import { createContext } from 'synthkernel';
import Agents from '@/Agents';
import Controller from '@/Controller';
import Session from '@/Session';
import Sessions from '@/Sessions';

const allModules = [Agents, Sessions, Controller] as const;
export type Kernel = KernelContext<typeof allModules, 'root'>;

// Compile-time guarantee: the kernel satisfies the published tools' contract.
type CompileGuard<T extends KernelContract> = T;
// oxlint-disable-next-line no-unused-vars
type Guard = CompileGuard<Kernel>;

export default function harness(pi: ExtensionAPI): void {
	const shared = globalThis as { harnessKernel?: Kernel };
	shared.harnessKernel ??= createContext(allModules, { mergeKeys: ['root'] });
	new Session(pi, shared.harnessKernel);
}

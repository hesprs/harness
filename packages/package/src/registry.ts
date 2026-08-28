import type { Registry } from '@repo/shared/contract';

/**
 * Shared across module instances: the controller extension and user configs
 * may resolve different copies of this module (dual-package hazard), so the
 * registry lives on globalThis to stay a single singleton.
 */
const registry = (globalThis as unknown as { harnessRegistry: Registry }).harnessRegistry;

export default registry;

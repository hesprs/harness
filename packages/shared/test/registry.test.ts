import { test, expect } from 'bun:test';
import { Registry } from '@/contract';

test('defineAgent returns the name and resolves the definition', () => {
	const reg = new Registry();
	const name = reg.defineAgent({ description: 'writes code', name: 'coder', prompt: 'P' });
	expect(name).toBe('coder');
	const def = reg.get('coder');
	expect(def?.description).toBe('writes code');
	expect(def?.prompts).toEqual(['P']);
});

test('base prompts and extensions accumulate into every agent', () => {
	const reg = new Registry();
	reg.setScope('user');
	reg.defineBaseAgent({ extensions: [() => {}], prompt: 'B1' });
	reg.setScope('cwd');
	reg.defineBaseAgent({ extensions: [() => {}], prompt: 'B2' });
	reg.defineAgent({ description: 'd', extensions: [() => {}], name: 'a', prompt: 'P' });
	reg.defineAgent({ description: 'd', name: 'b' });
	expect(reg.get('a')?.prompts).toEqual(['B1', 'B2', 'P']);
	expect(reg.get('a')?.extensions).toHaveLength(3);
	expect(reg.get('b')?.prompts).toEqual(['B1', 'B2']);
});

test('model and thinking override follows cwd named > user named > cwd base > user base', () => {
	const reg = new Registry();
	reg.setScope('user');
	reg.defineBaseAgent({ model: 'user-base', thinking: 'medium' });
	reg.defineAgent({ description: 'd', model: 'user-named', name: 'a' });
	reg.defineAgent({ description: 'd', name: 'b' });
	reg.setScope('cwd');
	reg.defineBaseAgent({ model: 'cwd-base' });
	reg.defineAgent({ description: 'd', name: 'a' }); // No model: user named still wins over cwd base
	reg.defineAgent({ description: 'd', name: 'b' }); // Only cwd base vs user base
	reg.defineAgent({ description: 'd', model: 'cwd-named', name: 'c' });
	expect(reg.get('a')?.model).toBe('user-named');
	expect(reg.get('b')?.model).toBe('cwd-base');
	expect(reg.get('c')?.model).toBe('cwd-named');
	expect(reg.get('c')?.thinking).toBe('medium');
});

test('names preserves first-definition order across scopes', () => {
	const reg = new Registry();
	reg.setScope('user');
	reg.defineAgent({ description: 'd', name: 'a' });
	reg.defineAgent({ description: 'd', name: 'b' });
	reg.setScope('cwd');
	reg.defineAgent({ description: 'overridden', name: 'a' });
	reg.defineAgent({ description: 'd', name: 'c' });
	expect(reg.names()).toEqual(['a', 'b', 'c']);
	expect(reg.get('a')?.description).toBe('overridden');
});

test('get of an undefined agent is undefined', () => {
	const reg = new Registry();
	expect(reg.get('nope')).toBeUndefined();
});

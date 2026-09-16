import deps from '@repo/shared/build';
import { defineConfig } from 'tsdown';

export default defineConfig({
	deps,
	dts: { eager: true },
	entry: 'src/index.ts',
	minify: true,
	outExtensions: () => ({ js: '.js' }),
});

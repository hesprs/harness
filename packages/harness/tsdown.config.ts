import deps from '@repo/shared/build';
import { defineConfig } from 'tsdown';

export default defineConfig({
	clean: false,
	deps,
	entry: { harness: 'src/index.ts' },
	minify: true,
	outExtensions: () => ({ js: '.js' }),
});

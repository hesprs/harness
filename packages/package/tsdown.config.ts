import deps from '@repo/shared/build';
import { defineConfig } from 'tsdown';
import raw from 'unplugin-raw/rolldown';

export default defineConfig({
	deps,
	dts: { eager: true },
	entry: 'src/index.ts',
	minify: true,
	outExtensions: () => ({ js: '.js' }),
	plugins: [raw()],
	unbundle: true,
});

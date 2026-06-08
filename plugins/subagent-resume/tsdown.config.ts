import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: 'src/index.ts',
	minify: true,
	outputOptions: {
		codeSplitting: false,
		dir: 'dist',
		entryFileNames: 'subagent-resume.js',
	},
});

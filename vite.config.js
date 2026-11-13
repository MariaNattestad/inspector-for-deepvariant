import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import fs from "node:fs";
import path from "node:path";

// The worker (wasm/web/*.mjs) is served next to the rest of DeepVariant for the browser
// (public/deepvariant/<version>/), from its source, so it needn't be copied there after each edit
const DEEPVARIANT = "deepvariant/1.10.0";
const WORKER_FILES = ["worker.mjs", "pipeline.mjs"];
const worker = () => ({
	name: "deepvariant-worker",
	configureServer(server) {
		server.middlewares.use((req, res, next) => {
			const file = WORKER_FILES.find((f) => req.url?.split("?")[0].endsWith(`/${DEEPVARIANT}/${f}`));
			if (!file) return next();
			res.setHeader("Content-Type", "text/javascript");
			res.end(fs.readFileSync(path.resolve("wasm/web", file)));
		});
	},
	writeBundle({ dir }) {
		for (const f of WORKER_FILES) fs.copyFileSync(path.resolve("wasm/web", f), path.join(dir, DEEPVARIANT, f));
	}
});

// Relative base, so the built site works from any path (e.g. GitHub Pages' /inspector-for-deepvariant/)
export default defineConfig({
	base: "./",
	plugins: [svelte(), worker()]
});

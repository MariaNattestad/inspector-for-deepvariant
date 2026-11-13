import prettier from "eslint-config-prettier";
import js from "@eslint/js";
import svelte from "eslint-plugin-svelte";
import globals from "globals";

export default [
	{ ignores: ["dist/**", "public/deepvariant/**", "work/**", "wasm/build/**"] },
	js.configs.recommended,
	...svelte.configs["flat/recommended"],
	prettier,
	...svelte.configs["flat/prettier"],
	{ languageOptions: { globals: { ...globals.browser, ...globals.node } } },
	{ files: ["wasm/web/**"], languageOptions: { globals: { ...globals.worker } } }
];

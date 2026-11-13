<script>
import Inspector from "./Inspector.svelte";

let inspector = $state();
let source = $state("example"); // the examples (home page), or "upload": your own data
</script>

<header>
	<div class="bar">
		<span class="name">🔬 Inspector for DeepVariant</span>
		<span class="tagline">Rerun DeepVariant 1.10 on one locus, in your browser, and see what it saw.</span>
		<nav>
			<a href="https://github.com/google/deepvariant">DeepVariant</a>
			<a href="https://github.com/MariaNattestad/inspector-for-deepvariant">Source</a>
			{#if source === "example"}
				<button class="cta" onclick={() => inspector.pickSource("upload")}>Inspect your own data</button>
			{:else}
				<button class="back" onclick={() => inspector.pickSource("example")}>Examples</button>
			{/if}
		</nav>
	</div>
</header>

<main>
	<Inspector bind:this={inspector} bind:source />
</main>

<footer>
	An independent tool, not made by or affiliated with the DeepVariant team at Google. It runs
	<a href="https://github.com/google/deepvariant/releases/tag/v1.10.0">DeepVariant 1.10.0</a> (BSD-3-Clause) compiled to
	WebAssembly, in your browser. Built by <a href="https://omgenomics.com">OMGenomics</a>.
</footer>

<style>
header {
	border-bottom: 1px solid var(--border);
}
.bar {
	max-width: 1360px;
	margin: 0 auto;
	padding: 10px 16px;
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px 24px;
	font:
		14px system-ui,
		-apple-system,
		sans-serif;
}
.name {
	font-weight: 600;
}
.tagline {
	flex: 1 1 300px;
	color: var(--fg-muted);
}
nav {
	display: flex;
	align-items: center;
	gap: 18px;
}
button {
	font: inherit;
	font-weight: 600;
	padding: 9px 16px;
	border-radius: 9px;
	cursor: pointer;
}
.cta {
	border: 0;
	background: var(--cta);
	color: var(--cta-fg);
	box-shadow: 0 1px 2px rgb(0 0 0 / 0.2);
}
.cta:hover {
	filter: brightness(1.08);
}
.back {
	border: 1px solid var(--border);
	background: var(--bg);
	color: var(--fg);
}
button:focus-visible {
	outline: 2px solid var(--accent);
	outline-offset: 2px;
}
footer {
	max-width: 1360px;
	margin: 0 auto;
	padding: 0 16px 32px;
	color: var(--fg-muted);
	font:
		12px/1.5 system-ui,
		-apple-system,
		sans-serif;
}
</style>

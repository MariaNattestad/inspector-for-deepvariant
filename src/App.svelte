<script>
import Inspector from "./Inspector.svelte";
</script>

<header>
	<div class="bar">
		<span class="name">🔬 Inspector for DeepVariant</span>
		<nav>
			<a href="https://github.com/google/deepvariant">DeepVariant</a>
			<a href="https://github.com/MariaNattestad/inspector-for-deepvariant">Source</a>
		</nav>
	</div>
</header>

<main>
	<Inspector />
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
	max-width: 1100px;
	margin: 0 auto;
	padding: 12px 16px;
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 12px;
	font:
		14px system-ui,
		-apple-system,
		sans-serif;
}
.name {
	font-weight: 600;
}
nav {
	display: flex;
	gap: 16px;
}
footer {
	max-width: 1100px;
	margin: 0 auto;
	padding: 0 16px 32px;
	color: var(--fg-muted);
	font:
		12px/1.5 system-ui,
		-apple-system,
		sans-serif;
}
</style>

// R-033 — demo-app: build smoke, proxy server, pure UI logic
// (docs/specs/demo-app.md §5/§8).
// [itest->R-033]
import { expect, test } from "bun:test";

test("the webapp bundles for the browser with zero unresolved imports", async () => {
	const result = await Bun.build({
		entrypoints: ["demo-app/src/main.tsx"],
		target: "browser",
	});
	expect(result.logs.filter((l) => l.level === "error")).toEqual([]);
	expect(result.success).toBe(true);
	expect(result.outputs.length).toBeGreaterThan(0);
}, 30_000);

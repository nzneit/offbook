// Tripwire for the stryker.conf.json tsconfigFile no-op (D-027).
//
// Stryker core's TSConfigPreprocessor loads the `typescript` module and calls
// ts.parseConfigFileTextToJson on the configured tsconfigFile whenever that
// path exists in the sandbox's file set — independent of any `checkers`
// config. TypeScript 7 ships tsc only (D-022), so that call crashes every
// mutation run. The conf therefore points tsconfigFile at a deliberately
// nonexistent path, which makes the preprocessor a no-op (files.get(...)
// returns undefined and the vulnerable call is skipped).
//
// That no-op holds only while (1) the sentinel path stays nonexistent and
// (2) the conf keeps declaring it. If this test fails: either someone
// created the sentinel file (delete or rename it), or the conf dropped the
// knob. A Stryker bump may also start validating the path — see D-027's
// residual-risk note; after any Stryker/runner bump, re-verify with a
// focused `stryker run` before trusting the gate.

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

test("stryker.conf.json pins the TSConfigPreprocessor no-op: sentinel declared and absent", () => {
	const conf = JSON.parse(readFileSync("stryker.conf.json", "utf8"));
	expect(conf.tsconfigFile).toBe("tsconfig.stryker-unused.json");
	expect(conf.checkers ?? []).toEqual([]);
	expect(existsSync("tsconfig.stryker-unused.json")).toBe(false);
});

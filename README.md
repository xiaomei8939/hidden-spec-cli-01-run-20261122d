# mend

[![Bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/xiaomei8939/hidden-spec-cli-01-run-20261122d/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/xiaomei8939/hidden-spec-cli-01-run-20261122d/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format. AI models write edits as unified
diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and
text-editor tool calls as JSON. mend reads all four formats to the single written
contract in `SPEC.md`, finds the lines each edit names at the first of three
matching tiers (exact, trailing-whitespace-insensitive, indentation-insensitive),
and then changes every file or none at all, printing what it changed or why each
edit failed.

## Run it

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- Node 22 and its standard library only; nothing to install.
- `PATCH` is a patch file relative to the working directory, or standard input
  when it is absent or `-`.
- `--format` is one of `unified`, `search-replace`, `v4a`, `json`, or `auto`
  (the default) to detect the format.
- `--check` reports exactly what would change without writing anything.
- `--strict` matches lines exactly (tier 0 only).

## Check it against the practice set

    node check.ts <practice.json>

`check.ts` runs `main.ts` on the public practice checks (the kit carries them at
`program/generator/practice.json`) and prints any check that differs, with the
practice score. This build passes 100 of 100 practice checks.

## Files

- `main.ts` — the CLI itself.
- `runner.ts` — the kit's trial runner, kept as handed out; `main.ts` hands a
  trial over to it when `MAKEFUN_ENV_URL` is set.
- `check.ts` — the local practice checker.
- `SPEC.md` — the full specification mend implements.
- `LICENSE` — MIT.

Built for the make.fun bounty [Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

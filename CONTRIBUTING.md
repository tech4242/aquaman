# Contributing to aquaman

Bug reports, questions and pull requests are welcome.

## Reporting

- **A bug or a request:** open an [issue](https://github.com/tech4242/aquaman/issues). Say what you ran, what you expected and what happened, with the aquaman version (`aquaman --version`), the agent host and its version, and the vault backend.
- **A security problem:** do not open an issue. Follow [SECURITY.md](SECURITY.md), which uses GitHub's private vulnerability reporting.

## Pull requests

1. Fork the repository and branch from `main`. `main` is protected: every change arrives as a pull request.
2. `npm ci --legacy-peer-deps`, then `npm run build`.
3. Make the change, with its tests (see below).
4. Run `npm run lint`, `npm run typecheck` and `npm test`. CI runs the same on Linux and macOS, plus CodeQL and the end-to-end jobs against real agent hosts.
5. Open the pull request and describe what changed and how you checked it.

By contributing you agree that your contribution is licensed under the project's [Apache-2.0 licence](LICENSE).

## What a change needs

- **Tests come with the change.** New behaviour has a test that fails without it, and a fix has a test that reproduces the bug. CI holds line coverage at 95% overall and for each package (`scripts/coverage-floors.json`).
- **A security control is tested by attacking it.** Tests under `test/compliance/` are tables with one row per attack. An attack the code does not stop stays in the table as an `it.fails` row whose name states the limit; never weaken an assertion to make a row pass.
- **Tests stay off the real machine.** A test that stores a credential uses the `encrypted-file` backend with its own `HOME` and `AQUAMAN_CONFIG_DIR`, never the real keychain or `~/.aquaman`, and never shows a real dialog.
- **Style:** TypeScript in strict mode, checked by `oxlint` and `tsc`. A comment states the current rule and why, not the history of the code.
- **Documentation says what was run.** A page states only what a test or a live run showed.

[AGENTS.md](AGENTS.md) describes the architecture and the rules for each part of the code in detail; read the section for the area you change.

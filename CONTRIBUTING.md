# Contributing

Thanks for looking at Wallet Radar. It is a small, focused project, so we keep
the contribution bar simple.

## Development setup

```bash
git clone https://github.com/daniilmilintieiev-ux/wallet-radar.git
cd wallet-radar
npm install
npm run build
npm test            # node:test, no framework
```

Requirements: **Node 22.13+** (uses the built-in `node:sqlite`). Live checks
need `HELIUS_API_KEY`; the offline `selftest` and the test suite do not.

## Conventions

- **TypeScript** (strict). Keep the `tsc` build clean — no type errors.
- **No new runtime dependencies** unless there is a strong reason. The runtime
  footprint is intentionally minimal (built-in `node:sqlite`, the MCP server
  SDK, and `zod` for schema validation).
- **Deterministic where it matters.** The verdict / risk-score path should stay
  deterministic and free of LLM or network calls that can silently change the
  result. Keep any new logic unit-testable.
- **Tests are required** for new behavior. Add cases under `test/` using
  `node:test` and assert on the concrete evidence, not just happy paths.

## Opening a pull request

1. Fork and create a feature branch.
2. Keep the change focused; one concern per PR.
3. Run `npm run build && npm test` and make sure both are green.
4. Update the docs (`README.md`, and `CHANGELOG.md` for user-facing changes).
5. Open the PR with a short description of what changed and why.

For **security** issues, please do not open a public PR or issue first — see
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).

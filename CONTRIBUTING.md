# Contributing to TASS Community Edition

Thank you for considering a contribution. TASS is a research instrument: the bar
for changes is correctness you can cite and reproducibility you can prove.

## Ground rules

1. **Determinism is a product guarantee.** Same inputs must produce byte-identical
   outputs. No timestamps, no randomness, no locale-dependent formatting, no
   unstable sorts. CI runs a determinism-hash gate across three operating systems;
   a change that moves the hash needs a documented, versioned reason.
2. **Zero runtime dependencies.** The engine packages depend on Node builtins only.
   Pull requests that add a runtime dependency will be declined; build-time and
   test-time tooling is negotiable.
3. **Statistics and scoring changes need receipts.** Cite the published method and
   include a benchmark against a reference implementation (R or a published worked
   example) in the test suite.
4. **Every capability is CLI-first.** New features land as a core function, then a
   CLI command, then the MCP tool derives from the same spec table. A feature that
   cannot be expressed as a CLI command needs redesign before code.
5. **Errors are part of the interface.** User-facing failures go through the
   TassError taxonomy with a stable code and an actionable hint.

## Developer Certificate of Origin

Contributions are accepted under the
[Developer Certificate of Origin 1.1](https://developercertificate.org/).
Sign off each commit (`git commit -s`), which adds:

    Signed-off-by: Your Name <your@email.example>

The sign-off certifies you wrote the change or have the right to submit it under
the Apache-2.0 license. No CLA, no paperwork beyond the sign-off.

## Dictionaries

Dictionary contributions belong in the public registry
([SIM-DAD/tass-lexicons](https://github.com/SIM-DAD/tass-lexicons)), not this
repo. Every TASS-native dictionary is open (CC-BY-4.0 or ODC-BY, citation
required, commercial use welcome) and the registry's CONTRIBUTING covers
authorship credit.

## Practical notes

- `npm install`, `npm run build`, `npm test` from the repo root; Node 18 or newer.
- Tests are `node:test` suites under each package's `test/` directory and run
  against the compiled `lib/` output.
- Match the file's existing style; there is no linter to argue with, only the
  surrounding code.
- Windows, macOS, and Linux are all first-class: mind path handling and line
  endings, and never shell out for things Node builtins can do.

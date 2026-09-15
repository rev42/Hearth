# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## This is a fork

`origin` is `rev42/Hearth`; upstream is `ondreu/Hearth` (add it as a remote — it is
not configured by default). The fork carries no divergence: it is upstream plus a
small number of local commits on top. Keep it that way — move up by resetting to
the upstream point (the newest release tag, or `upstream/main` when the tip has
moved past it) and replaying the local commits, not by merging.

Local-only work, as of `upstream/main` past 3.1.0 — the stable manifest still
says 3.1.0 and the beta one 3.1.1-beta.1, so the base is a tip, not a tag:

- A GitLab merge-request card (`src/gitlab.ts`, `src/cards/gitlab.ts`), modelled
  line for line on the Jira card. When upstream reworks the Jira card, the GitLab
  card follows the same rework.
- A named empty state for a card kind this build has no code for
  (`UNKNOWN_CARD_DEFINITION` in `src/cards/index.ts`).

The CHANGELOG entries for both sit under `## [Unreleased]`, because neither is in
any upstream release. Cherry-picking a local commit lands its CHANGELOG hunk in
whatever release section the context matched — check and move it.

## Installing a local build over the store version

Obsidian's community-plugin updater replaces a locally built plugin wholesale, so
a card type no upstream release carries disappears on update. The install is
`main.js`, `styles.css` and `manifest.json` in the vault's
`.obsidian/plugins/hearth/`. Back up before overwriting.

## npm on a machine with a private registry

`npm ci` fails here when the user's global `~/.npmrc` points at a private registry.
This is a public project: install against the public registry
with a throwaway user config rather than editing `~/.npmrc` or adding a project
`.npmrc`:

    printf 'registry=https://registry.npmjs.org/\nengine-strict=false\n' > /tmp/npmrc
    NPM_CONFIG_USERCONFIG=/tmp/npmrc npm ci

`engine-strict=false` is needed when the local Node is outside `jsdom`'s range.

## Adding a card kind: every place that must know

`tsc -noEmit` catches most of it, but not all. The registry in `src/cards/index.ts`
is an exhaustive mapped type over `CardKind`, and `Translations = typeof en`, so a
new English string makes every other locale in `src/locales/` fail to compile —
translate there too. Beyond what the compiler sees:

- `src/portable/refs.ts` classifies each outside reference a shared board carries.
  A self-hosted host belongs under `privateHost`, beside `jira.host`.
- `scrubCard()` in `src/layout.ts` is the single credential strip every export path
  runs. A new field holding a token goes there and nowhere else.
- `src/gallery/snapshot.ts` blanks every card body except a tiny allowlist, so a new
  kind is redacted by default — nothing to register.
- `src/integrations.ts` for the Integrations catalogue, and the README's card and
  external-service tables.

## Verify

`npm run typecheck`, `npm test`, `npm run lint`, `npm run build`.
`npm run verify:manifests` fails at a stable release tag (beta behind stable) —
that is upstream's release-train state, not a local break. See `RELEASING.md`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

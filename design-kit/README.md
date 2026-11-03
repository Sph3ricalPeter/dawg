# Design kit

The dawg design system in Claude Design is built from the app itself, so
the design and the app can't drift apart.

- `src/design-kit/` is the kit: the app's real components (`src/ui`,
  `src/components`) with plain props, and a demo song they render from.
  It is type-checked and linted with the app, so a change that breaks a
  component's props breaks here too.
- `design-kit/vite.config.ts` bundles it into one classic script,
  `window.Dawg`, over the design canvas's React.
- `design-kit/build.mjs` writes the design system's files to
  `design-kit/out/project/`: `tokens.json` from `src/tokens.css` (every
  token needs a note in `usage.mjs`), the Manrope font, `bundle.css` from
  `src/ui/ui.css` and `src/styles.css`, the bundle, and each component's
  preview and guidelines from `components.mjs`.

`npm run design:build` runs both. Then publish `design-kit/out/project/`
to the design system (ask Claude to "sync the design system").

To change how something looks, change the app, rebuild, and publish. A
token edited on the design system's page is copied back into
`src/tokens.css` by hand (ask Claude).

A new component: add an adapter to `src/design-kit/kit.tsx` that renders
the real one, and its card to `design-kit/components.mjs`.

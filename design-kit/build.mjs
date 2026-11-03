// Assembles the Claude Design system for dawg from the app's own sources:
// src/tokens.css → tokens.json, the Manrope font, src/ui/ui.css +
// src/styles.css → bundle.css, the kit build → bundle.js, plus each
// component's preview and guidelines from design-kit/components.mjs.
// Run `npm run design:build`; the result is design-kit/out/project/.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { COMPONENTS, README } from "./components.mjs";
import { USAGE } from "./usage.mjs";

/** A line of text per size, as the app uses it. */
const SAMPLE = {
  "fs-3xs": "C1 · 1.3",
  "fs-2xs": "WAV · 48 kHz",
  "fs-xs": "−18.0 dB Threshold",
  "fs-sm": "PINNED FOLDERS",
  "fs-md": "Drop WAV or MP3 files here for new tracks",
  "fs-lg": "Night Drive",
  "fs-xl": "Export mixdown",
  "fs-2xl": "+",
};

const here = import.meta.dirname;
const root = path.resolve(here, "..");
const out = path.join(here, "out", "project");
const TITLE = "dawg";
const NS = "Dawg";

rmSync(path.join(here, "out"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const write = (p, text) => {
  mkdirSync(path.dirname(path.join(out, p)), { recursive: true });
  writeFileSync(path.join(out, p), text);
};

/* ------------------------------------------------------------------ */
/* Tokens, from src/tokens.css, in file order                          */
/* ------------------------------------------------------------------ */

const css = readFileSync(path.join(root, "src/tokens.css"), "utf8");
const vars = [...css.matchAll(/^\s*--([\w-]+):\s*([^;]+);/gm)].map((m) => ({ name: m[1], value: m[2].trim() }));
const usage = (n) => {
  const u = USAGE[n];
  if (!u) throw new Error(`No usage note for --${n} in design-kit/usage.mjs`);
  return u;
};
const isColour = (v) => /^(#|rgba?\()/.test(v);
const family = (re) => vars.filter((v) => re.test(v.name)).map((v) => ({ name: v.name, value: v.value, usage: usage(v.name) }));

const colours = vars.filter((v) => isColour(v.value)).map((v) => ({ name: v.name, value: { dark: v.value.toLowerCase() }, usage: usage(v.name) }));
const sizes = vars.filter((v) => v.name.startsWith("fs-"));
const fontStack = vars.find((v) => v.name === "font").value;
const used = new Set([...colours.map((c) => c.name), "font", "mono"]);

const tokens = {
  name: TITLE,
  version: 1,
  color: { themes: [{ id: "dark", name: "Dark" }], tokens: colours },
  type: {
    fonts: [{ family: "Manrope Variable", file: "fonts/manrope-latin-wght-normal.woff2", weight: "200 800", style: "normal" }],
    families: { sans: fontStack },
    groups: [
      {
        name: "Manrope",
        family: "sans",
        styles: sizes.map((s) => ({
          name: s.name.replace("fs-", "text-"),
          fontSize: s.value,
          lineHeight: 1.4,
          fontWeight: s.name === "fs-xl" ? 600 : 400,
          sample: SAMPLE[s.name],
          usage: usage(s.name),
        })),
      },
    ],
  },
  fontSize: { note: "The type scale as variables (--fs-*): what styles.css sets sizes with.", tokens: family(/^fs-/) },
  fontWeight: { note: "Weights (--fw-*), and a value's weight (--nw) and an emphasised value's (--nw2).", tokens: family(/^(fw-|nw)/) },
  radius: { tokens: family(/^r-/) },
  spacing: { tokens: family(/^sp-/) },
  shadow: { tokens: family(/^shadow-/) },
  layout: { note: "Fixed sizes of the window's parts.", tokens: family(/^hdr-w$/) },
  meta: {
    source: "github",
    repo: "Sph3ricalPeter/dawg",
    ref: process.env.DAWG_REF ?? "dev",
    paths: { tokens: ["src/tokens.css"], fonts: ["node_modules/@fontsource-variable/manrope"], components: ["src/ui", "src/components", "src/design-kit"] },
    synced: new Date().toISOString().slice(0, 10),
  },
};
for (const f of ["fontSize", "fontWeight", "radius", "spacing", "shadow", "layout"]) for (const t of tokens[f].tokens) used.add(t.name);
const missed = vars.filter((v) => !used.has(v.name)).map((v) => v.name);
if (missed.length) throw new Error(`tokens.css has variables the build doesn't place: ${missed.join(", ")}`);
write("tokens.json", JSON.stringify(tokens, null, 2) + "\n");

// The first tokens.css, laid out as the page compiles it, so previews
// render before anyone saves on the page.
const decl = (n, v) => `  --${n}: ${v};`;
const tokensCss = [
  `/* ${TITLE} — generated from tokens.json */`,
  `:root, [data-theme="dark"] {`,
  ...colours.map((c) => decl(c.name, c.value.dark)),
  ...tokens.shadow.tokens.map((t) => decl(t.name, t.value)),
  `}`,
  `:root {`,
  ...[...tokens.spacing.tokens, ...tokens.radius.tokens, ...tokens.fontSize.tokens, ...tokens.fontWeight.tokens, ...tokens.layout.tokens].map((t) =>
    decl(t.name, t.value),
  ),
  decl("font-sans", fontStack),
  `}`,
  ...tokens.type.groups[0].styles.map(
    (s) => `.${s.name} { font-family: var(--font-sans); font-size: ${s.fontSize}; line-height: ${s.lineHeight}; font-weight: ${s.fontWeight}; }`,
  ),
  `@font-face { font-family: "Manrope Variable"; src: url("fonts/manrope-latin-wght-normal.woff2") format("woff2-variations"); font-weight: 200 800; font-style: normal; font-display: swap; }`,
  "",
].join("\n");
write("tokens.css", tokensCss);

/* ------------------------------------------------------------------ */
/* Font, stylesheet, bundle                                            */
/* ------------------------------------------------------------------ */

mkdirSync(path.join(out, "fonts"), { recursive: true });
copyFileSync(
  path.join(root, "node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2"),
  path.join(out, "fonts/manrope-latin-wght-normal.woff2"),
);

const bundleCss = [
  `/* dawg: the app's own stylesheets (src/ui/ui.css, src/styles.css), after tokens.css. */`,
  `:root { --font: var(--font-sans); --mono: var(--font); color-scheme: dark; }`,
  readFileSync(path.join(root, "src/ui/ui.css"), "utf8"),
  readFileSync(path.join(root, "src/styles.css"), "utf8"),
  readFileSync(path.join(here, "kit.css"), "utf8"),
].join("\n\n");
if (/<\/style/i.test(bundleCss)) throw new Error("bundle.css holds </style");
write("components/bundle.css", bundleCss);

const js = readFileSync(path.join(here, "dist/bundle.js"), "utf8");
if (/<\/script|<!--/i.test(js)) throw new Error("bundle.js holds </script or <!--");
const header = { format: 4, namespace: NS, components: COMPONENTS.filter((c) => !c.page).map((c) => ({ name: c.name })) };
write("components/bundle.js", `/* @ds-bundle: ${JSON.stringify(header)} */\n${js}`);

/* ------------------------------------------------------------------ */
/* Components: preview, guidelines, types                              */
/* ------------------------------------------------------------------ */

const attr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
for (const c of COMPONENTS) {
  const marker = `<!-- @dsCard group="${c.group}" height=${c.height}${c.width ? ` width=${c.width}` : ""}${c.subtitle ? ` subtitle="${attr(c.subtitle)}"` : ""} -->`;
  write(
    `components/${c.name}/preview.html`,
    `${marker}
<!doctype html>
<html>
<head><meta charset="utf-8"><title>${c.name}</title>
<style>body{margin:0;background:var(--bg-1);color:var(--text);font-family:var(--font);font-size:var(--fs-md)}#root{padding:${c.pad ?? 16}px;display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}</style>
</head>
<body>
<div id="root"></div>
<script>
  var D = window.${NS}, h = React.createElement;
  ReactDOM.createRoot(document.getElementById('root')).render(h(React.Fragment, null, ${c.preview}));
</script>
</body>
</html>
`,
  );
  write(`components/${c.name}/README.md`, `${c.readme.trim()}\n`);
}
write(
  "components/index.d.ts",
  `/* dawg design kit: window.${NS}. Each component is the app's own, from src/ui or src/components. */\n` +
    COMPONENTS.filter((c) => c.props !== undefined).map((c) => `export interface ${c.name}Props ${c.props}\nexport declare function ${c.name}(props: ${c.name}Props): JSX.Element;\n`).join("\n"),
);

write("README.md", README);

/* ------------------------------------------------------------------ */
/* Cover                                                               */
/* ------------------------------------------------------------------ */

write("components/Cover/preview.html", readFileSync(path.join(here, "cover.html"), "utf8"));

console.log(`design system written to ${path.relative(root, out)}`);

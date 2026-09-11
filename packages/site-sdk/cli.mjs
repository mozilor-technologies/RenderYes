#!/usr/bin/env node

import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { toSiteManifest } from "./dist/index.js";

const [command, ...args] = process.argv.slice(2);

if (command === "init") {
  await init(args[0] ?? ".");
} else if (command === "scan") {
  const site = await loadSite(args[0]);
  process.stdout.write(`${JSON.stringify(toSiteManifest(site), null, 2)}\n`);
} else if (command === "sync") {
  const site = await loadSite(args[0]);
  const output = resolve(args[1] ?? ".renderyes/catalog.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(toSiteManifest(site), null, 2)}\n`, "utf8");
  process.stdout.write(`Synced ${site.id} to ${output}\n`);
} else {
  process.stderr.write(
    "Usage: renderyes-site <init [directory] | scan <site-module> | sync <site-module> [output]>\n",
  );
  process.exitCode = 1;
}

async function init(directory) {
  const target = resolve(directory, "renderyes.site.mjs");
  try {
    await access(target);
    throw new Error(`Refusing to overwrite existing ${target}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(
    target,
    `import {
  defineComponent,
  defineProps,
  defineSite,
  defineSurface,
  defineTheme,
  field,
} from "@renderyes/site-sdk";

const ExampleCard = defineComponent({
  id: "ExampleCard",
  version: "1.0.0",
  description: "Replace this with an approved customer component.",
  props: defineProps({
    text: field.string({ default: "Registered RenderYes component" }),
  }),
  renderer: {
    component: "Text",
    props: { variant: "body" },
  },
});

export default defineSite({
  id: "example-site",
  name: "Example site",
  version: "1.0.0",
  catalogId: "https://example.com/renderyes/catalog.json",
  components: [ExampleCard],
  surfaces: [
    defineSurface({
      id: "main",
      description: "Primary personalized surface.",
      componentIds: ["ExampleCard"],
      maxComponents: 4,
    }),
  ],
  theme: defineTheme({
    id: "example-theme",
    tokens: { primary: "#2563eb", ink: "#172033", radius: 14 },
  }),
});
`,
    "utf8",
  );
  process.stdout.write(`Created ${target}\n`);
}

async function loadSite(modulePath) {
  if (!modulePath) throw new Error("A site registration module is required");
  const loaded = await import(pathToFileURL(resolve(modulePath)).href);
  const site = loaded.default ?? loaded.site;
  if (!site?.catalog || !site?.registrationFingerprint) {
    throw new Error("Module does not export a registered RenderYes site");
  }
  return site;
}

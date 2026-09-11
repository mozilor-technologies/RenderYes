import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";
import { themes as prismThemes } from "prism-react-renderer";

const config: Config = {
  title: "RenderYes",
  tagline: "Your website, rearranged around one sentence.",
  favicon: "img/favicon.svg",

  url: "https://mozilor-technologies.github.io",
  baseUrl: "/RenderYes/",

  organizationName: "mozilor-technologies",
  projectName: "RenderYes",

  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",

  markdown: {
    format: "detect",
    hooks: { onBrokenMarkdownLinks: "throw" },
  },

  i18n: { defaultLocale: "en", locales: ["en"] },

  presets: [
    [
      "classic",
      {
        docs: {
          path: "../docs",
          routeBasePath: "docs",
          sidebarPath: "./sidebars.ts",
          editUrl: "https://github.com/mozilor-technologies/RenderYes/tree/main/",
          showLastUpdateTime: true,
          // Repository-only product guidance is not part of the integration docs.
          exclude: ["PRODUCT.md"],
        },
        blog: false,
        theme: { customCss: "./src/css/custom.css" },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: { respectPrefersColorScheme: true },
    navbar: {
      title: "RenderYes",
      logo: { alt: "RenderYes", src: "img/logo.svg" },
      items: [
        { type: "docSidebar", sidebarId: "docs", position: "left", label: "Docs" },
        { to: "/docs/QUICKSTART", label: "Quickstart", position: "left" },
        { to: "/docs/ARCHITECTURE", label: "Architecture", position: "left" },
        {
          href: "https://github.com/mozilor-technologies/RenderYes",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Start here",
          items: [
            { label: "Quickstart", to: "/docs/QUICKSTART" },
            { label: "Build a host", to: "/docs/BUILD_A_HOST" },
            { label: "The example host", to: "/docs/EXAMPLE_HOST" },
          ],
        },
        {
          title: "Reference",
          items: [
            { label: "Architecture", to: "/docs/ARCHITECTURE" },
            { label: "API", to: "/docs/API" },
            { label: "Troubleshooting", to: "/docs/TROUBLESHOOTING" },
          ],
        },
        {
          title: "Project",
          items: [
            {
              label: "GitHub",
              href: "https://github.com/mozilor-technologies/RenderYes",
            },
            {
              label: "Contributing",
              href: "https://github.com/mozilor-technologies/RenderYes/blob/main/CONTRIBUTING.md",
            },
            {
              label: "Changelog",
              href: "https://github.com/mozilor-technologies/RenderYes/blob/main/CHANGELOG.md",
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Mozilor Technologies. MIT licensed.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "json", "graphql", "diff"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;

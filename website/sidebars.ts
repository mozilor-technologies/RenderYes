import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

// Keep site ordering here so the shared Markdown files need no Docusaurus frontmatter.
const sidebars: SidebarsConfig = {
  docs: [
    {
      type: "category",
      label: "Start here",
      collapsed: false,
      items: [
        { type: "doc", id: "QUICKSTART", label: "Quickstart" },
        { type: "doc", id: "EXAMPLE_HOST", label: "The example host" },
        { type: "doc", id: "HOST_INTEGRATION_STEPS", label: "Integration steps" },
      ],
    },
    {
      type: "category",
      label: "Build with it",
      collapsed: false,
      items: [
        { type: "doc", id: "BUILD_A_HOST", label: "Build a host" },
        { type: "doc", id: "INTEGRATION", label: "Integration reference" },
        { type: "doc", id: "CATALOG", label: "Building a catalog in code" },
        { type: "doc", id: "AUTHORING_VIEWS", label: "Authoring views" },
      ],
    },
    {
      type: "category",
      label: "Reference",
      collapsed: false,
      items: [
        { type: "doc", id: "API", label: "API reference" },
        { type: "doc", id: "ARCHITECTURE", label: "Architecture" },
        { type: "doc", id: "TROUBLESHOOTING", label: "Troubleshooting" },
      ],
    },
  ],
};

export default sidebars;

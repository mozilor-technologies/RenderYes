import {
  defineComponent,
  defineProps,
  defineSite,
  defineSurface,
  defineTheme,
  field,
} from "../dist/index.js";

const Notice = defineComponent({
  id: "Notice",
  version: "1.0.0",
  description: "A registered notice.",
  props: defineProps({
    text: field.string({ default: "Hello" }),
  }),
  renderer: {
    component: "Text",
    props: { variant: "body" },
  },
});

export default defineSite({
  id: "cli-fixture",
  name: "CLI fixture",
  version: "1.0.0",
  catalogId: "https://example.com/cli-fixture/catalog.json",
  components: [Notice],
  surfaces: [
    defineSurface({
      id: "main",
      description: "Fixture surface.",
      componentIds: ["Notice"],
    }),
  ],
  theme: defineTheme({
    id: "fixture-theme",
    tokens: { primary: "#2563eb" },
  }),
});

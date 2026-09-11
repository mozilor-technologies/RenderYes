import { defineComponent, defineProps, field } from "@renderyes/site-sdk";

export const recipeGridDefinition = defineComponent({
  id: "RecipeGrid",
  version: "1.0.0",
  description: "Recipe cards for the pantry dashboard, one card per recipe.",
  props: defineProps({ heading: field.string({ default: "Recipes" }) }),
  renderer: {
    component: "RecipeGrid",
    props: { recipes: { path: "/recipes" } },
  },
  dataSlots: {
    recipes: { accepts: [{ dataTypeId: "Recipe", shapes: ["collection"] }] },
  },
});

export const componentDefinitions = [recipeGridDefinition];

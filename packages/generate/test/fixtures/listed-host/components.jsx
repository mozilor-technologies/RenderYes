import { defineHostComponent, defineProps, field } from "@renderyes/react";

function RecipeGrid({ heading, recipes }) {
  const rows = Array.isArray(recipes) ? recipes : [];
  return (
    <section aria-label="Recipes">
      <h2>{heading}</h2>
      <p>{rows.length} recipes</p>
    </section>
  );
}

const recipeGrid = defineHostComponent({
  id: "RecipeGrid",
  version: "1.0.0",
  description: "Recipe cards for the pantry dashboard, one card per recipe.",
  props: defineProps({ heading: field.string({ default: "Recipes" }) }),
  dataSlots: {
    recipes: { accepts: [{ dataTypeId: "Recipe", shapes: ["collection"] }] },
  },
  component: RecipeGrid,
});

export const components = [recipeGrid];

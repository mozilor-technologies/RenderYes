/**
 * Sanitized shape of a request for "non-veg food near me".
 *
 * The plan controls food preferences and radius. The trusted host resolves the
 * saved delivery location and the executor passes only deliveryLocationId to
 * the approved runtime. A real host would import executeDataRequest and supply
 * its registered catalog, runtime map, and session adapter.
 */
export const request = {
  requestId: "nearby-non-veg",
  capabilityId: "restaurants.search",
  params: {
    diet: "non-veg",
    radiusKm: 5,
  },
};

export const dataCatalog = {
  id: "swiggy-food-data",
  version: "0.1.0",
  hash: "generated-by-hashCapabilityCatalog",
};

export const trustedSessionExample = {
  viewerId: "viewer-123",
  deliveryLocationId: "saved-address-456",
  permissions: ["restaurants.read"],
  accessToken: "never-forwarded-to-the-runtime",
};

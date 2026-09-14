// Object spread evaluates getters eagerly. Preserve the original descriptors so
// MST installs computed views at the same point, in the same override order.
export function mergeViewDefinitions(...definitions) {
  return definitions.reduce((result, definition) =>
    Object.defineProperties(result, Object.getOwnPropertyDescriptors(definition)), {});
}

// This only relocates existing Choices controls. The stored Reviewed result,
// required validation, undo and autosave still belong to the original control.
export function vectorReviewDockEnabled(image) {
  const annotation = image?.annotation;
  return !!(
    image?.wholeRoomInheritanceEnabled &&
    image.hasRoomConstraints &&
    annotation?.editable &&
    !annotation.store?.annotationStore?.viewingAll &&
    !annotation.isReadOnly()
  );
}

export function dockedVectorReviewImage(control) {
  const image = control.annotation?.names?.get(control.toname);
  if (!vectorReviewDockEnabled(image) || !control.perregion) return null;
  return [...image.connectionVectorControlNames].some((name) => image.geometryReviewControlFor(name) === control.name)
    ? image
    : null;
}

export function vectorReviewRows(image) {
  if (!vectorReviewDockEnabled(image)) return [];
  return image.connectionVectorRegions
    .filter((region) => !region.isReadOnly())
    .map((region) => {
      const labeling = region.results.find((result) => image.connectionVectorControlNames.has(result.from_name?.name));
      const controlName = image.geometryReviewControlFor(labeling?.from_name?.name);
      const control = image.annotation.names.get(controlName);
      return {
        id: region.cleanId,
        region,
        control,
        type: labeling?.from_name?.name === "visual_connection_vector" ? "仅视觉连通" : "交通连通",
        label: labeling?.mainValue?.join(", ") || "",
        reviewed: region.results.some(
          (result) => result.from_name?.name === controlName && result.mainValue?.includes("Reviewed"),
        ),
      };
    });
}

import { getType, types } from "mobx-state-tree";

export const EditableRegion = types
  .model("EditableRegion")
  .volatile(() => ({
    editorEnabled: true,
    /**
     * Adding properties to the editableFields array on the
     * target model will make them editable in the details panel.
     */
    editableFields: [
      // { property: "x", label: "X" },
    ],
  }))
  .views((self) => ({
    getProperty(name) {
      return self[name];
    },

    getPropertyType(name) {
      return getType(self).properties[name];
    },

    isPropertyEditable(name) {
      return self.editableFields.some((f) => f.property === name);
    },

    get hasEditableFields() {
      return self.editableFields.length > 0;
    },
  }))
  .actions((self) => ({
    setProperty(propName, value) {
      if (self.isPropertyEditable(propName)) {
        if (
          self.type === "rectangleregion" &&
          self.parent?.occupancyConstrains?.(self) &&
          ["x", "y", "width", "height", "rotation"].includes(propName)
        ) {
          const next = {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
            rotation: self.rotation,
            [propName]: value,
          };
          self.setPositionInternal(next.x, next.y, next.width, next.height, next.rotation);
          return;
        }
        self[propName] = value;
      } else {
        throw new Error(`Property ${propName} of model ${self.type} is not editable`);
      }
    },
  }));

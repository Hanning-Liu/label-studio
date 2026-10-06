import { observer } from "mobx-react";
import { isAlive } from "mobx-state-tree";

import type { IReactComponent } from "mobx-react/dist/types/IReactComponent";
import { type ExoticComponent, Fragment, type ReactNode, useCallback } from "react";
import { Portal } from "react-konva-utils";

type Region = {
  annotation: any;
  hidden: boolean;
  // ...
  setShapeRef(ref: any): void;
  inSelection: boolean;
  parent?: { occupancyEnabled?: boolean };
};

type RegionComponentProps = {
  item: Region;
  setShapeRef: (ref: any) => void;
};

type Options = {
  renderHidden?: boolean;
  shouldNotUsePortal?: boolean;
};

type PortalProps = {
  selector?: string;
  enabled?: boolean;
  children: ReactNode;
};

export const AliveRegion = (RegionComponent: IReactComponent<RegionComponentProps>, options?: Options) => {
  const ObservableRegion = observer(RegionComponent);

  return observer(({ item, ...rest }: RegionComponentProps) => {
    const canRender = options?.renderHidden || !item.hidden;
    // L3 mounts its native selection layer only for an editable physical part.
    // Keep that part in its image layer instead of reparenting it through a
    // Portal while the destination is mounting; otherwise its canvas transform
    // can be lost when switching from the logical footprint to native handles.
    const shouldNotUsePortal = options?.shouldNotUsePortal || item.parent?.occupancyEnabled;
    const Wrapper = (shouldNotUsePortal ? Fragment : Portal) as ExoticComponent<PortalProps>;
    const wrapperProps = shouldNotUsePortal ? {} : { selector: ".selection-regions-layer", enabled: item.inSelection };
    const isInTree = !!item.annotation;
    const setShapeRef = useCallback(
      (ref) => {
        if (isAlive(item)) {
          item.setShapeRef(ref);
        }
      },
      [item],
    );

    return isInTree && isAlive(item) && canRender ? (
      <Wrapper {...wrapperProps}>
        <ObservableRegion item={item} {...rest} setShapeRef={setShapeRef} />
      </Wrapper>
    ) : null;
  });
};

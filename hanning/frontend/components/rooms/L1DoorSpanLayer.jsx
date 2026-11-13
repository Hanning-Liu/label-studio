import { observer } from "mobx-react";
import { Circle, Group, Layer, Line, Rect } from "react-konva";
import { doorAxis, pointAlong } from "@hanning/frontend/domain/rooms/doorOperation";

const stop = (event) => { event.cancelBubble = true; };

export const L1DoorSpanLayer = observer(({ item }) => {
  const region = item.l1SlidingDoor;
  const edit = region && !region.hidden && item.l1DoorSpanEdit?.id === region.id &&
    !item.l1SwitchBlockReason && !region.isReadOnly() ?
    item.l1DoorSpanEdit : null;
  const frame = edit && item.l1DoorFrame(region);
  const symbols = item.l1DoorSymbols.filter(({ id }) => id !== edit?.id);
  if (!frame && !symbols.length) return null;
  const at = ({ x, y }) => {
    return { x: item.internalToCanvasX(item.imageToInternalX(x)), y: item.internalToCanvasY(item.imageToInternalY(y)) };
  };
  const pointer = (event, endpoint) => {
    const stage = event.target.getStage();
    const point = stage?.getRelativePointerPosition();
    if (!point) return;
    const pixel = item.placeL1DoorSpanPoint({
      x: item.internalToImageX(item.canvasToInternalX(point.x)),
      y: item.internalToImageY(item.canvasToInternalY(point.y)),
    }, endpoint);
    if (pixel) event.target.position(at(pixel));
  };
  const draw = !!frame && edit.mode === "draw";
  const adjust = !!frame && edit.mode === "adjust";
  const active = draw || adjust;
  const axis = frame && doorAxis(frame);
  const ends = frame && (edit.points ?? edit.span?.map((ratio) => pointAlong(...axis, ratio)));
  const line = (points) => points.flatMap((point) => { const { x, y } = at(point); return [x, y]; });
  return (
    <Layer name="l1-door-span" listening={active}>
      {symbols.map((symbol) => (
        <Group key={symbol.id} listening={false} name={`l1-door-${symbol.kind}-symbol`}>
          {symbol.kind === "sliding" ? (
            <>
              <Line points={line(symbol.points)} stroke="#fff" strokeWidth={6} lineCap="round" strokeScaleEnabled={false} />
              <Line points={line(symbol.points)} stroke="#007e6c" strokeWidth={3} lineCap="round" strokeScaleEnabled={false} />
            </>
          ) : (
            <>
              <Line points={line(symbol.arc)} stroke="#fff" strokeWidth={4} strokeScaleEnabled={false} />
              <Line points={line(symbol.arc)} stroke="#a84214" strokeWidth={2} dash={[4, 3]} strokeScaleEnabled={false} />
              <Line points={line(symbol.leaf)} stroke="#fff" strokeWidth={5} strokeScaleEnabled={false} />
              <Line points={line(symbol.leaf)} stroke="#a84214" strokeWidth={3} strokeScaleEnabled={false} />
              <Circle {...at(symbol.hinge)} radius={3.5 / item.zoomScale} fill="#a84214"
                stroke="white" strokeWidth={1} strokeScaleEnabled={false} />
            </>
          )}
        </Group>
      ))}
      {active && <Rect width={item.stageWidth} height={item.stageHeight} fill="transparent"
        onMouseDown={stop} onMouseUp={stop} onTouchStart={stop} onTouchEnd={stop}
        onClick={(event) => { stop(event); if (draw && event.evt.button === 0) pointer(event); }}
        onTap={(event) => { stop(event); if (draw) pointer(event); }} />}
      {active && <Line points={line(axis)} stroke="#195d56" strokeWidth={2}
        dash={[4, 4]} strokeScaleEnabled={false} listening={false} />}
      {ends && <Line points={line(ends)} stroke="#00a38b" strokeWidth={4} lineCap="round"
        strokeScaleEnabled={false} listening={false} />}
      {ends?.map((point, index) => (
        <Circle key={index} {...at(point)} radius={6 / item.zoomScale} fill="white" stroke="#007e6c"
          strokeWidth={2} strokeScaleEnabled={false} listening={adjust} draggable={adjust}
          onMouseDown={stop} onMouseUp={stop} onTouchStart={stop} onTouchEnd={stop} onClick={stop} onTap={stop}
          onDragMove={(event) => { stop(event); pointer(event, index); }}
          onDragEnd={(event) => { stop(event); pointer(event, index); }} />
      ))}
      {draw && edit.start && <Circle {...at(edit.start.pixel)} radius={6 / item.zoomScale}
        fill="white" stroke="#007e6c" strokeWidth={2} strokeScaleEnabled={false} listening={false} />}
    </Layer>
  );
});

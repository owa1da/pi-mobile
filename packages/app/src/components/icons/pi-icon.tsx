// The Pi mark (the launcher icon's π) as a vector, in any colour. Same geometry as
// assets/brand/pi-mark.svg via pi-mark-shapes.ts.
import Svg, { Polygon, Rect } from "react-native-svg";
import { PI_MARK_SHAPES, PI_MARK_VIEWBOX, polygonPoints } from "./pi-mark-shapes";

interface PiIconProps {
  size?: number;
  color?: string;
}

export function PiIcon({ size = 16, color = "currentColor" }: PiIconProps) {
  return (
    <Svg width={size} height={size} viewBox={PI_MARK_VIEWBOX} fill={color}>
      {PI_MARK_SHAPES.map((shape) =>
        shape.kind === "polygon" ? (
          <Polygon key={polygonPoints(shape)} points={polygonPoints(shape)} fill={color} />
        ) : (
          <Rect
            key={`${shape.x},${shape.y}`}
            x={shape.x}
            y={shape.y}
            width={shape.width}
            height={shape.height}
            rx={shape.rx}
            fill={color}
          />
        ),
      )}
    </Svg>
  );
}

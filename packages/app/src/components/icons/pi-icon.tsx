// The pi agent logo (the launcher icon's mark) as a vector, in any colour. Same geometry as
// assets/brand/pi-mark.svg via pi-mark-shapes.ts.
import Svg, { Rect } from "react-native-svg";
import { PI_MARK_SHAPES, PI_MARK_VIEWBOX } from "./pi-mark-shapes";

interface PiIconProps {
  size?: number;
  color?: string;
}

export function PiIcon({ size = 16, color = "currentColor" }: PiIconProps) {
  return (
    <Svg width={size} height={size} viewBox={PI_MARK_VIEWBOX} fill={color}>
      {PI_MARK_SHAPES.map((shape) => (
        <Rect
          key={`${shape.x},${shape.y}`}
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          fill={color}
        />
      ))}
    </Svg>
  );
}

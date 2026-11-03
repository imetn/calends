import { useState, type RefObject } from 'react';
import { ColorArea, ColorField, ColorSlider, ColorThumb, Input, parseColor, SliderTrack, type Color } from 'react-aria-components';
import { Pop } from './Pop.tsx';

/** 取色面板：饱和度与明度、色相、十六进制值，替代系统色盘；选色即生效，点外面收起。 */
export function ColorPop({
  triggerRef,
  value,
  label,
  onChange,
  onClose,
}: {
  triggerRef: RefObject<HTMLElement | null>;
  value: string;
  label: string;
  onChange: (hex: string) => void;
  onClose: () => void;
}) {
  // 自己存 HSB：拖到纯黑或纯灰时色相不会被十六进制值冲掉
  const [color, setColor] = useState(() => parseColor(value).toFormat('hsb'));
  const set = (next: Color | null) => {
    if (!next) return;
    setColor(next.toFormat('hsb'));
    onChange(next.toString('hex').toLowerCase());
  };
  return (
    <Pop triggerRef={triggerRef} onClose={onClose} label={label} className="color-pop">
      <ColorArea
        className="color-area"
        style={{ width: '100%', height: 160 }}
        aria-label={label}
        colorSpace="hsb"
        xChannel="saturation"
        yChannel="brightness"
        value={color}
        onChange={set}
      >
        <ColorThumb className="color-thumb" />
      </ColorArea>
      <ColorSlider className="color-hue" aria-label={label} colorSpace="hsb" channel="hue" value={color} onChange={set}>
        <SliderTrack className="color-hue-track">
          <ColorThumb className="color-thumb" style={{ top: '50%' }} />
        </SliderTrack>
      </ColorSlider>
      <ColorField className="color-hex" aria-label={label} value={color} onChange={set}>
        <Input className="num" />
      </ColorField>
    </Pop>
  );
}

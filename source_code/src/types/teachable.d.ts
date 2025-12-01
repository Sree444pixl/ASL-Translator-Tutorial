declare module '@teachablemachine/image' {
  export class Webcam {
    constructor(width: number, height: number, flip: boolean);
    setup(): Promise<void>;
    play(): Promise<void>;
    pause(): void;
    stop(): void;
    update(): void;
    canvas: HTMLCanvasElement;
  }
  export type Prediction = { className: string; probability: number };
  export type CustomMobileNet = {
    predict: (input: HTMLCanvasElement | HTMLImageElement) => Promise<Prediction[]>;
  };
  export function load(modelUrl: string, metadataUrl: string): Promise<CustomMobileNet>;
}